/**
 * GenerationQueue (§9.2): client-side orchestrator for TTS generation.
 *
 * - Up to MAX_IN_FLIGHT chunks generating at once. Starts stay ≥RATE_INTERVAL
 *   apart, so the per-minute cap still holds — overlap only hides upstream
 *   latency (a ~60s render no longer idles the rate budget, which is what
 *   made serial generation ~1 chunk/min in practice). User-priority jobs
 *   (the playhead) bypass the in-flight cap so playback never queues behind
 *   bulk prefetch.
 * - Self-rate-limits to ~17 requests/minute (one every 3.5s) — under
 *   OpenRouter's free-tier 20/minute. (A ~2,000-char chunk is ~275 requests
 *   for a 100k-word novel; at 17/minute that is ~16 minutes per book, inside
 *   the free daily cap.)
 * - On 429 honours Retry-After, otherwise backs off exponentially from 30s,
 *   capped at 5 minutes.
 * - Persists its queue + daily request count, so a queue survives a restart.
 * - Tracks per-book bulk progress (total/done) for the progress card, plus a
 *   rolling chunks/minute rate for the ETA.
 * - Cancellable by book/chapter/bulk, and tracks a rough daily request count
 *   to warn as the ~1000/day free cap approaches.
 */

import { db } from '../db/dexie';
import { ChunkNotGeneratedError, generateAndCache } from './audioStore';

/** ~17/minute = one every 3.5s. §9.2: stay under the 20/minute free cap. */
export const RATE_INTERVAL_MS = 3_500;
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
/** Chunks allowed in flight at once. Measured on fish-audio free models: a
 *  ~2,000-char chunk takes ~60s to render, and upstream renders run fully in
 *  parallel (4 concurrent probes each took the same wall time as one alone).
 *  Sustained throughput = slots × 60/render-seconds, so 12 slots carry ~12
 *  chunks/min through 62s renders; the rate gate still spaces every START, so
 *  the per-minute request cap holds regardless. */
export const MAX_IN_FLIGHT = 12;
/** A chunk 429-retried this many times is dropped: once the free daily cap is
 *  reached every request 429s until midnight, and unbounded retries would
 *  spin the queue forever without ever completing. */
const MAX_RATE_LIMIT_ATTEMPTS = 10;
/** Free tier is 1000/day once $10 lifetime credits purchased (§9.1). */
export const DAILY_QUOTA = 1000;
export const QUOTA_WARNING_AT = 900;

const KV_KEY = 'genqueue.v1';

/**
 * Sleep that keeps its promise when the tab is hidden. Chromium throttles
 * page timers to ~1/minute after a few minutes in a background tab, which
 * stretches a bulk book generation from ~20 minutes to many hours; timer
 * callbacks inside a Worker are exempt. Only installed in production builds —
 * vitest's fake timers must control the fallback setTimeout.
 */
const sleep: (ms: number) => Promise<void> = (() => {
  const onTimeout = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  if (typeof Worker === 'undefined' || !import.meta.env.PROD) return onTimeout;
  try {
    const src =
      'let n=0;const timers=new Map();' +
      'onmessage=(e)=>{const [id,ms]=e.data;' +
      'timers.set(id,setTimeout(()=>{timers.delete(id);postMessage(id)},ms))};';
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const waiting = new Map<number, () => void>();
    let nextId = 1;
    worker.onmessage = (e: MessageEvent<number>) => {
      const resolve = waiting.get(e.data);
      if (resolve) {
        waiting.delete(e.data);
        resolve();
      }
    };
    return (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        worker.postMessage([id, ms]);
      });
  } catch {
    // Worker blocked (CSP and friends) — throttled timers beat no timers.
    return onTimeout;
  }
})();

export type JobPriority = 'user' | 'prefetch';

export interface GenJob {
  bookId: string;
  chapterIdx: number;
  chunkIdx: number;
  priority: JobPriority;
}

/** Progress of the latest bulk run ("generate whole chapter/book"). */
export interface BulkProgress {
  bookId: string;
  /** Chunks this run aims to generate. Never decreases mid-run. */
  total: number;
  /** Chunks settled this run: generated, skipped (404) or dropped. */
  done: number;
  startedAt: number;
}

export interface GenerationStatus {
  /** The chunk currently being generated, if any. */
  current: { bookId: string; chapterIdx: number; chunkIdx: number } | null;
  /** Chunks left to generate: queued or currently in flight. */
  pending: number;
  requestsToday: number;
  quotaWarning: boolean;
  /** Milliseconds until the next attempt is allowed (rate limit or backoff). */
  nextAttemptInMs: number;
  /** The active bulk run, if any (session-scoped; null after a restart). */
  bulk: BulkProgress | null;
  /** Settled chunks per minute over the last few completions, for the ETA. */
  chunksPerMinute: number | null;
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
  /** Jobs currently generating (≤ MAX_IN_FLIGHT; insertion-ordered). */
  private inFlight = new Set<GenJob>();
  /** Bulk run tracked for the progress card (enqueueBulk/…). */
  private bulk: BulkProgress | null = null;
  /** Settled-at timestamps (bounded) behind chunksPerMinute. */
  private completions: number[] = [];
  /** Resolvers woken whenever queue state changes (work added/finished). */
  private wakeups = new Set<() => void>();
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
      pending: this.jobs.length + this.inFlight.size,
      requestsToday: this.requestsToday,
      quotaWarning: this.requestsToday >= QUOTA_WARNING_AT,
      nextAttemptInMs: Math.max(0, this.notBefore - Date.now()),
      bulk: this.bulk ? { ...this.bulk } : null,
      chunksPerMinute: this.chunksPerMinute(),
    };
  }

  private emit(): void {
    const s = this.status();
    for (const cb of this.listeners) cb(s);
  }

  /** Wake anything waiting for queue state to change (pump, idle waits). */
  private wake(): void {
    const waiters = [...this.wakeups];
    this.wakeups.clear();
    for (const w of waiters) w();
  }

  private waitForChange(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeups.add(resolve);
    });
  }

  /** True when a chunk is queued or being generated right now. */
  isQueued(bookId: string, chapterIdx: number, chunkIdx: number): boolean {
    return this.findTracked(bookId, chapterIdx, chunkIdx) !== null;
  }

  private findTracked(bookId: string, chapterIdx: number, chunkIdx: number): GenJob | null {
    for (const j of this.inFlight) {
      if (j.bookId === bookId && j.chapterIdx === chapterIdx && j.chunkIdx === chunkIdx) return j;
    }
    return this.jobs.find(
      (j) => j.bookId === bookId && j.chapterIdx === chapterIdx && j.chunkIdx === chunkIdx,
    ) ?? null;
  }

  /** Queue chunks for generation. Duplicates are ignored. */
  enqueue(
    bookId: string,
    chapterIdx: number,
    chunkIdxs: number[],
    priority: JobPriority,
  ): void {
    let added = 0;
    for (const chunkIdx of chunkIdxs) {
      if (this.isQueued(bookId, chapterIdx, chunkIdx)) continue;
      this.jobs.push({ bookId, chapterIdx, chunkIdx, priority });
      added++;
    }
    // A no-op enqueue must not emit: the narrator's prefetch re-enqueues the
    // first missing chunk ahead of the playhead on every queue event, so an
    // emit here (dedupe → emit → refreshAhead → dedupe → …) spins an endless
    // IDB-hot loop for as long as that chunk lacks audio — the reader
    // becomes unresponsive while generation runs.
    if (added === 0) return;
    this.refreshBulk();
    void this.persist();
    this.emit();
    this.wake();
    void this.pump();
  }

  /**
   * Queue a bulk batch (the "generate whole chapter/book" buttons) and start
   * tracking progress for the progress card. Per chapter, in book order.
   */
  enqueueBulk(bookId: string, chapters: Array<{ chapterIdx: number; chunkIdxs: number[] }>): void {
    for (const { chapterIdx, chunkIdxs } of chapters) {
      for (const chunkIdx of chunkIdxs) {
        if (this.isQueued(bookId, chapterIdx, chunkIdx)) continue;
        this.jobs.push({ bookId, chapterIdx, chunkIdx, priority: 'prefetch' });
      }
    }
    if (!this.bulk || this.bulk.bookId !== bookId) {
      this.bulk = { bookId, total: 0, done: 0, startedAt: Date.now() };
    }
    this.refreshBulk();
    void this.persist();
    this.emit();
    this.wake();
    void this.pump();
  }

  /** Move a job to the front as user-initiated (the narrator's playhead). */
  prioritize(bookId: string, chapterIdx: number, chunkIdx: number): void {
    // Already generating? Nothing to prioritise — the request is running.
    for (const j of this.inFlight) {
      if (j.bookId === bookId && j.chapterIdx === chapterIdx && j.chunkIdx === chunkIdx) return;
    }
    const idx = this.jobs.findIndex(
      (j) => j.bookId === bookId && j.chapterIdx === chapterIdx && j.chunkIdx === chunkIdx,
    );
    if (idx > 0) {
      const [job] = this.jobs.splice(idx, 1);
      if (job) {
        job.priority = 'user';
        this.jobs.unshift(job);
      }
    } else if (idx === 0) {
      this.jobs[0]!.priority = 'user';
    } else {
      this.jobs.unshift({ bookId, chapterIdx, chunkIdx, priority: 'user' });
    }
    void this.persist();
    this.emit();
    this.wake();
    void this.pump();
  }

  cancelBook(bookId: string): void {
    this.jobs = this.jobs.filter((j) => j.bookId !== bookId);
    if (this.bulk?.bookId === bookId) this.bulk = null;
    void this.persist();
    this.emit();
    this.wake();
  }

  cancelChapter(bookId: string, chapterIdx: number): void {
    this.jobs = this.jobs.filter((j) => !(j.bookId === bookId && j.chapterIdx === chapterIdx));
    this.refreshBulk();
    void this.persist();
    this.emit();
    this.wake();
  }

  /** Cancel the bulk run's queued work, keeping any user-priority jobs. */
  cancelBulk(bookId: string): void {
    this.jobs = this.jobs.filter((j) => !(j.bookId === bookId && j.priority === 'prefetch'));
    if (this.bulk?.bookId === bookId) this.bulk = null;
    void this.persist();
    this.emit();
    this.wake();
  }

  /** Cancel every queued job, any book, any priority (the card's global Stop;
   *  a resumed-from-restart queue has no bulk run to target). In-flight
   *  chunks finish on their own. */
  cancelAll(): void {
    this.jobs = [];
    this.bulk = null;
    void this.persist();
    this.emit();
    this.wake();
  }

  private pendingForBook(bookId: string): number {
    let n = 0;
    for (const j of this.inFlight) if (j.bookId === bookId) n++;
    for (const j of this.jobs) if (j.bookId === bookId) n++;
    return n;
  }

  /** Keep the bulk run's totals monotone; end it when the book drains. */
  private refreshBulk(): void {
    const bulk = this.bulk;
    if (!bulk) return;
    const pending = this.pendingForBook(bulk.bookId);
    if (pending === 0) {
      this.bulk = null;
      return;
    }
    bulk.total = Math.max(bulk.total, bulk.done + pending);
  }

  private nextJob(): GenJob | null {
    if (this.jobs.length === 0) return null;
    // User-initiated jobs (playhead, "generate now") go first.
    const userIdx = this.jobs.findIndex((j) => j.priority === 'user');
    const [job] = this.jobs.splice(userIdx === -1 ? 0 : userIdx, 1);
    return job ?? null;
  }

  private peekJob(): GenJob | null {
    if (this.jobs.length === 0) return null;
    const userIdx = this.jobs.findIndex((j) => j.priority === 'user');
    return this.jobs[userIdx === -1 ? 0 : userIdx] ?? null;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (this.jobs.length === 0 && this.inFlight.size === 0) break;
        const job = this.peekJob();
        if (!job) {
          // Only in-flight work remains — wait for it to settle.
          await this.waitForChange();
          continue;
        }
        const waitMs = Math.max(0, this.notBefore - Date.now());
        const slotFree = this.inFlight.size < MAX_IN_FLIGHT;
        // The rate gate applies to everything; the in-flight cap only to
        // prefetch, so a playhead chunk never queues behind bulk work.
        if (waitMs > 0 || (!slotFree && job.priority !== 'user')) {
          const waits: Array<Promise<void>> = [this.waitForChange()];
          if (waitMs > 0) waits.push(sleep(waitMs));
          await Promise.race(waits);
          continue;
        }
        this.startJob(this.nextJob()!);
      }
    } finally {
      this.current = null;
      this.running = false;
      this.emit();
    }
  }

  /**
   * Kick off one chunk without waiting for it. Overlap hides upstream latency;
   * the notBefore gate in pump() still spaces every START ≥RATE_INTERVAL apart,
   * so the per-minute rate cap (§9.2) holds regardless.
   */
  private startJob(job: GenJob): void {
    this.lastStartAt = Date.now();
    this.notBefore = this.lastStartAt + RATE_INTERVAL_MS;
    this.inFlight.add(job);
    if (!this.current) this.current = job;
    this.emit();
    this.recordRequest();
    const key = `${job.bookId}:${job.chapterIdx}:${job.chunkIdx}`;
    let outcome: 'done' | 'skip' | 'retry' | 'drop' = 'done';
    void generateAndCache(job.bookId, job.chapterIdx, job.chunkIdx)
      .then(() => undefined)
      .catch((err) => {
        if (err instanceof ChunkNotGeneratedError) {
          // 404 (ChunkNotGeneratedError): nothing to retry — skip the chunk.
          outcome = 'skip';
          return;
        }
        outcome = this.handleFailure(job, err);
      })
      .finally(() => {
        this.inFlight.delete(job);
        this.current = this.inFlight.values().next().value ?? null;
        if (outcome !== 'retry') {
          this.recordCompletion();
          this.attempts.delete(key);
          const bulk = this.bulk;
          if (bulk && bulk.bookId === job.bookId) bulk.done += 1;
        }
        this.refreshBulk();
        this.emit();
        this.wake();
        void this.persist();
      });
  }

  private attempts = new Map<string, number>();

  /** Returns 'retry' when the job was re-queued, 'drop' when abandoned. */
  private handleFailure(job: GenJob, err: unknown): 'retry' | 'drop' {
    const key = `${job.bookId}:${job.chapterIdx}:${job.chunkIdx}`;
    const status = (err as { status?: number }).status;
    const isRateLimit = status === 429;
    const attempts = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempts);

    // 429: honour Retry-After, else exponential from 30s — but only up to
    // MAX_RATE_LIMIT_ATTEMPTS, so a hit daily cap can't spin the queue all
    // day. Other failures: retry a bounded number of times with the same
    // backoff, then drop.
    const retryAfterMs = (err as { retryAfterMs?: number | null }).retryAfterMs ?? null;
    const backoff = isRateLimit
      ? Math.min(retryAfterMs ?? BACKOFF_START_MS, BACKOFF_MAX_MS)
      : Math.min(BACKOFF_START_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);

    const maxAttempts = isRateLimit ? MAX_RATE_LIMIT_ATTEMPTS : MAX_ATTEMPTS;
    if (attempts >= maxAttempts) {
      this.attempts.delete(key);
      return 'drop'; // drop the job — unrelated chunks shouldn't inherit the wait
    }
    this.jobs.unshift(job); // retry in place
    this.notBefore = Date.now() + backoff;
    this.emit();
    return 'retry';
  }

  private recordRequest(): void {
    const t = today();
    if (t !== this.day) {
      this.day = t;
      this.requestsToday = 0;
    }
    this.requestsToday += 1;
  }

  /** Settled chunks per minute, over the last few completions (ETA input). */
  private recordCompletion(): void {
    const now = Date.now();
    this.completions.push(now);
    while (this.completions.length > 12 || (this.completions.length > 0 && now - this.completions[0]! > 600_000)) {
      this.completions.shift();
    }
  }

  private chunksPerMinute(): number | null {
    const c = this.completions;
    if (c.length < 2) return null;
    const spanMs = c[c.length - 1]! - c[0]!;
    if (spanMs <= 0) return null;
    return Math.round(((c.length - 1) / spanMs) * 60_000 * 10) / 10;
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {
      // Snapshot now: the pump mutates this.jobs in place (splice/push/
      // unshift) and IndexedDB structured-clones the value only when the
      // transaction runs — persisting the live array can write a torn
      // mid-mutation state, silently dropping (or resurrecting) jobs across
      // a restart.
      jobs: this.jobs.map((j) => ({ ...j })),
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
