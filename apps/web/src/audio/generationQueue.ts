/**
 * GenerationQueue (§9.2): client-side orchestrator for TTS generation.
 *
 * - One chunk at a time, in order (user-priority jobs jump ahead of prefetch).
 * - Self-rate-limits to 12 requests/minute — one every 5 seconds — well under
 *   OpenRouter's free-tier 20/minute, leaving headroom for a second device.
 *   (A ~2,000-char chunk is ~275 requests for a 100k-word novel; at 12/minute
 *   that is ~23 minutes per book, inside the free daily cap.)
 * - On 429 honours Retry-After, otherwise backs off exponentially from 30s,
 *   capped at 5 minutes.
 * - Persists its queue + daily request count, so a queue survives a restart.
 * - Cancellable by book/chapter, and tracks a rough daily request count to
 *   warn as the ~1000/day free cap approaches.
 */

import { db } from '../db/dexie';
import { ChunkNotGeneratedError, generateAndCache } from './audioStore';

/** 12/minute = one every 5s. §9.2: stay well under 20/minute. */
const RATE_INTERVAL_MS = 5_000;
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
/** Free tier is 1000/day once $10 lifetime credits purchased (§9.1). */
export const DAILY_QUOTA = 1000;
export const QUOTA_WARNING_AT = 900;

const KV_KEY = 'genqueue.v1';

export type JobPriority = 'user' | 'prefetch';

export interface GenJob {
  bookId: string;
  chapterIdx: number;
  chunkIdx: number;
  priority: JobPriority;
}

export interface GenerationStatus {
  /** The chunk currently being generated, if any. */
  current: { bookId: string; chapterIdx: number; chunkIdx: number } | null;
  pending: number;
  requestsToday: number;
  quotaWarning: boolean;
  /** Milliseconds until the next attempt is allowed (rate limit or backoff). */
  nextAttemptInMs: number;
}

interface PersistedState {
  jobs: GenJob[];
  day: string;
  requestsToday: number;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class GenerationQueue {
  private jobs: GenJob[] = [];
  private current: GenJob | null = null;
  private running = false;
  private day = today();
  private requestsToday = 0;
  private lastStartAt = 0;
  private notBefore = 0; // wall-clock gate: rate limit + backoff
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<(s: GenerationStatus) => void>();
  private inited = false;

  /** Load persisted state and resume an interrupted queue. Idempotent. */
  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;
    try {
      const row = await db.kv.get(KV_KEY);
      if (row) {
        const state = row.value as PersistedState;
        if (state.day === today()) {
          this.requestsToday = state.requestsToday;
        }
        this.jobs = state.jobs ?? [];
      }
    } catch {
      // Corrupt state: start clean rather than block the app.
      this.jobs = [];
    }
    void this.pump();
  }

  subscribe(cb: (s: GenerationStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status());
    return () => this.listeners.delete(cb);
  }

  status(): GenerationStatus {
    return {
      current: this.current ? { ...this.current } : null,
      pending: this.jobs.length,
      requestsToday: this.requestsToday,
      quotaWarning: this.requestsToday >= QUOTA_WARNING_AT,
      nextAttemptInMs: Math.max(0, this.notBefore - Date.now()),
    };
  }

  private emit(): void {
    const s = this.status();
    for (const cb of this.listeners) cb(s);
  }

  /** Queue chunks for generation. Duplicates are ignored. */
  enqueue(
    bookId: string,
    chapterIdx: number,
    chunkIdxs: number[],
    priority: JobPriority,
  ): void {
    for (const chunkIdx of chunkIdxs) {
      const exists = this.jobs.some(
        (j) => j.bookId === bookId && j.chapterIdx === chapterIdx && j.chunkIdx === chunkIdx,
      );
      if (this.current?.bookId === bookId && this.current.chapterIdx === chapterIdx && this.current.chunkIdx === chunkIdx) {
        continue;
      }
      if (!exists) this.jobs.push({ bookId, chapterIdx, chunkIdx, priority });
    }
    void this.persist();
    this.emit();
    void this.pump();
  }

  /** Move a job to the front as user-initiated (the narrator's playhead). */
  prioritize(bookId: string, chapterIdx: number, chunkIdx: number): void {
    const idx = this.jobs.findIndex(
      (j) => j.bookId === bookId && j.chapterIdx === chapterIdx && j.chunkIdx === chunkIdx,
    );
    if (idx > 0) {
      const [job] = this.jobs.splice(idx, 1);
      if (job) {
        job.priority = 'user';
        this.jobs.unshift(job);
      }
    } else if (idx === -1) {
      this.jobs.unshift({ bookId, chapterIdx, chunkIdx, priority: 'user' });
    }
    void this.persist();
    this.emit();
    void this.pump();
  }

  /** True when a chunk is queued or being generated right now. */
  isQueued(bookId: string, chapterIdx: number, chunkIdx: number): boolean {
    if (
      this.current?.bookId === bookId &&
      this.current.chapterIdx === chapterIdx &&
      this.current.chunkIdx === chunkIdx
    ) {
      return true;
    }
    return this.jobs.some(
      (j) => j.bookId === bookId && j.chapterIdx === chapterIdx && j.chunkIdx === chunkIdx,
    );
  }

  cancelBook(bookId: string): void {
    this.jobs = this.jobs.filter((j) => j.bookId !== bookId);
    void this.persist();
    this.emit();
  }

  cancelChapter(bookId: string, chapterIdx: number): void {
    this.jobs = this.jobs.filter((j) => !(j.bookId === bookId && j.chapterIdx === chapterIdx));
    void this.persist();
    this.emit();
  }

  private nextJob(): GenJob | null {
    if (this.jobs.length === 0) return null;
    // User-initiated jobs (playhead, "generate now") go first.
    const userIdx = this.jobs.findIndex((j) => j.priority === 'user');
    const [job] = this.jobs.splice(userIdx === -1 ? 0 : userIdx, 1);
    return job ?? null;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const waitMs = Math.max(0, this.notBefore - Date.now());
        if (waitMs > 0) {
          await this.delay(waitMs);
          if (this.jobs.length === 0) break;
        }
        const job = this.nextJob();
        if (!job) break;
        this.current = job;
        this.emit();

        // Enforce the inter-request gap even without backoff.
        const sinceLast = Date.now() - this.lastStartAt;
        if (sinceLast < RATE_INTERVAL_MS) {
          await this.delay(RATE_INTERVAL_MS - sinceLast);
        }

        this.lastStartAt = Date.now();
        this.notBefore = this.lastStartAt + RATE_INTERVAL_MS;
        const key = `${job.bookId}:${job.chapterIdx}:${job.chunkIdx}`;
        try {
          await generateAndCache(job.bookId, job.chapterIdx, job.chunkIdx);
          this.attempts.delete(key);
          this.recordRequest();
        } catch (err) {
          if (err instanceof ChunkNotGeneratedError) {
            // 404: nothing to retry — skip this chunk.
          } else {
            await this.handleFailure(job, err);
          }
        }
        this.current = null;
        this.emit();
        await this.persist();
      }
    } finally {
      this.current = null;
      this.running = false;
      this.emit();
    }
  }

  private attempts = new Map<string, number>();

  private async handleFailure(job: GenJob, err: unknown): Promise<void> {
    const key = `${job.bookId}:${job.chapterIdx}:${job.chunkIdx}`;
    const status = (err as { status?: number }).status;
    const isRateLimit = status === 429;
    const attempts = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempts);

    // 429: honour Retry-After, else exponential from 30s. Other failures:
    // retry a bounded number of times with the same backoff, then drop.
    const retryAfterMs = (err as { retryAfterMs?: number | null }).retryAfterMs ?? null;
    const backoff = isRateLimit
      ? Math.min(retryAfterMs ?? BACKOFF_START_MS, BACKOFF_MAX_MS)
      : Math.min(BACKOFF_START_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);

    if (!isRateLimit && attempts >= MAX_ATTEMPTS) {
      this.attempts.delete(key);
      return; // drop the job
    }
    this.jobs.unshift(job); // retry in place
    this.notBefore = Date.now() + backoff;
    this.emit();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }

  private recordRequest(): void {
    const t = today();
    if (t !== this.day) {
      this.day = t;
      this.requestsToday = 0;
    }
    this.requestsToday += 1;
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {
      jobs: this.jobs,
      day: this.day,
      requestsToday: this.requestsToday,
    };
    try {
      await db.kv.put({ key: KV_KEY, value: state });
    } catch {
      // Best effort — the queue still works this session.
    }
  }
}

export const generationQueue = new GenerationQueue();
