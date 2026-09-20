/**
 * GenerationQueue behaviour (§9.2): rate limiting to ~17/min, in-flight
 * concurrency cap with a user-priority bypass, 429 handling with
 * Retry-After, bounded retries for other failures, bulk progress tracking,
 * persistence across restarts, and the daily request count / quota warning.
 *
 * Timing: fake timers advance the clock in steps, and the pump's own
 * microtask chain flushes between steps — so the next attempt can be
 * scheduled a little after the exact gate. The queue never fires EARLY (its
 * gates are asserted strictly); "it eventually fires" is asserted with an
 * advancing loop.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/audioStore', () => {
  class ChunkNotGeneratedError extends Error {
    constructor() {
      super('Chunk has no audio yet');
      this.name = 'ChunkNotGeneratedError';
    }
  }
  return { ChunkNotGeneratedError, generateAndCache: vi.fn() };
});

const { GenerationQueue, RATE_INTERVAL_MS, MAX_IN_FLIGHT } = await import(
  '../src/audio/generationQueue'
);
const { generateAndCache } = await import('../src/audio/audioStore');
const { db } = await import('../src/db/dexie');

const generate = generateAndCache as ReturnType<typeof vi.fn>;
const calls = () => generate.mock.calls.length;

/** Advance in steps until the condition holds, bounded by maxMs of fake time. */
async function advanceUntil(cond: () => boolean, maxMs: number): Promise<void> {
  let elapsed = 0;
  while (!cond() && elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(250);
    elapsed += 250;
  }
}

beforeEach(() => {
  // Only the clock pieces the queue uses — faking everything stalls
  // fake-indexeddb's microtask loop and the IndexedDB ops never settle.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  generate.mockReset();
  generate.mockResolvedValue(new Blob(['x']));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GenerationQueue', () => {
  it('rate limits to one request every 3.5 seconds (§9.2)', async () => {
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0, 1], 'prefetch');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls()).toBe(1);
    expect(generate).toHaveBeenCalledWith('b', 0, 0);

    // The second job can never run before the 3.5s gate.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(1);

    // ...and always runs once the gate passes.
    await advanceUntil(() => calls() >= 2, 60_000);
    expect(calls()).toBe(2);
    expect(generate).toHaveBeenLastCalledWith('b', 0, 1);
  });

  it('caps concurrent prefetch jobs and waits for a free slot', async () => {
    generate.mockImplementation(() => new Promise<Blob>(() => undefined)); // never settle
    const q = new GenerationQueue();
    await q.init();
    const count = MAX_IN_FLIGHT + 4;
    q.enqueue('b', 0, Array.from({ length: count }, (_, i) => i), 'prefetch');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls()).toBe(1);

    // Starts stay RATE_INTERVAL apart until the pool is full…
    await vi.advanceTimersByTimeAsync(RATE_INTERVAL_MS * (MAX_IN_FLIGHT - 1) + 100);
    expect(calls()).toBe(MAX_IN_FLIGHT);

    // …then nothing starts no matter how much time passes.
    await vi.advanceTimersByTimeAsync(RATE_INTERVAL_MS * 3);
    expect(calls()).toBe(MAX_IN_FLIGHT);
  });

  it('starts a user-priority job even when every slot is busy', async () => {
    generate.mockImplementation(() => new Promise<Blob>(() => undefined)); // never settle
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, i) => i), 'prefetch');
    await advanceUntil(() => calls() === MAX_IN_FLIGHT, 120_000);

    q.prioritize('b', 1, 0);
    // Only the rate gate stands between the user chunk and its request —
    // never the full prefetch pool.
    await vi.advanceTimersByTimeAsync(RATE_INTERVAL_MS + 100);
    expect(calls()).toBe(MAX_IN_FLIGHT + 1);
    expect(generate).toHaveBeenLastCalledWith('b', 1, 0);
  });

  it('on 429 honours Retry-After and retries', async () => {
    generate.mockImplementationOnce(async () => {
      const err = new Error('rate limited') as Error & { status: number; retryAfterMs: number };
      err.status = 429;
      err.retryAfterMs = 60_000;
      throw err;
    });
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0], 'user');
    await advanceUntil(() => calls() >= 1, 5_000);
    expect(calls()).toBe(1);

    // The regular 3.5s rate gate is not enough — the Retry-After gate holds
    // for a full minute (never re-fires early).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls()).toBe(1);

    await advanceUntil(() => calls() >= 2, 120_000);
    expect(calls()).toBe(2);
  });

  it('on 429 without Retry-After backs off 30s, then retries', async () => {
    generate.mockImplementationOnce(async () => {
      const err = new Error('rate limited') as Error & { status: number };
      err.status = 429;
      throw err;
    });
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0], 'user');
    await advanceUntil(() => calls() >= 1, 5_000);
    expect(calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls()).toBe(1); // 30s backoff still holds

    await advanceUntil(() => calls() >= 2, 60_000);
    expect(calls()).toBe(2);
  });

  it('drops a job after 3 consecutive non-429 failures', async () => {
    generate.mockImplementation(async () => {
      throw new Error('boom');
    });
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0], 'user');
    // attempt 1 → +30s → attempt 2 → +60s → attempt 3 → dropped.
    await advanceUntil(() => calls() >= 3, 200_000);
    expect(q.status().pending).toBe(0);
    // Nothing left to retry even with time passing.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls()).toBe(3);
  });

  it('skips chunks the server says were never generated (404)', async () => {
    generate.mockImplementation(async () => {
      const { ChunkNotGeneratedError } = await import('../src/audio/audioStore');
      throw new ChunkNotGeneratedError();
    });
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0, 1], 'user');
    await advanceUntil(() => calls() >= 2, 30_000);
    expect(q.status().pending).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
  });

  it('prioritize() jumps the user chunk to the front', async () => {
    const q = new GenerationQueue();
    await q.init();
    // The playhead job goes in front before anything else is queued; the
    // pump picks it up first, then works the prefetch queue in order.
    q.prioritize('b', 0, 2);
    q.enqueue('b', 0, [0, 1, 2], 'prefetch'); // 2 is already queued as user
    await advanceUntil(() => calls() >= 1, 5_000);
    expect(generate).toHaveBeenNthCalledWith(1, 'b', 0, 2);
    await advanceUntil(() => calls() >= 3, 60_000);
    expect(generate).toHaveBeenNthCalledWith(2, 'b', 0, 0);
    expect(generate).toHaveBeenNthCalledWith(3, 'b', 0, 1);
  });

  it('does not double-queue a chunk that is already in flight', async () => {
    generate.mockImplementation(() => new Promise<Blob>(() => undefined)); // never settle
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0], 'prefetch');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls()).toBe(1);
    // The same chunk re-queued (playhead seek, repeated button press) must
    // not start a second request.
    q.enqueue('b', 0, [0], 'user');
    q.prioritize('b', 0, 0);
    await vi.advanceTimersByTimeAsync(RATE_INTERVAL_MS * 3);
    expect(calls()).toBe(1);
    expect(q.status().pending).toBe(1);
  });

  it('tracks bulk progress and clears it when the book drains', async () => {
    let release!: () => void;
    generate.mockImplementationOnce(() => new Promise<Blob>((r) => (release = r)));
    const q = new GenerationQueue();
    await q.init();
    q.enqueueBulk('b', [
      { chapterIdx: 0, chunkIdxs: [0, 1, 2] },
      { chapterIdx: 1, chunkIdxs: [0] },
    ]);
    expect(q.status().bulk).toEqual({
      bookId: 'b',
      total: 4,
      done: 0,
      startedAt: expect.any(Number),
    });

    // Settle the in-flight job; the rest run through the rate gate.
    release();
    await advanceUntil(() => q.status().pending === 0, 30_000);
    expect(calls()).toBe(4);
    expect(q.status().bulk).toBeNull();
  });

  it('extends the bulk total when more work is queued mid-run', async () => {
    const q = new GenerationQueue();
    await q.init();
    generate.mockImplementation(() => new Promise<Blob>(() => undefined)); // never settle
    q.enqueueBulk('b', [{ chapterIdx: 0, chunkIdxs: [0, 1] }]);
    expect(q.status().bulk).toMatchObject({ total: 2 });
    // "Generate whole book" clicked while the chapter run is going.
    q.enqueueBulk('b', [{ chapterIdx: 1, chunkIdxs: [0, 1] }]);
    expect(q.status().bulk).toMatchObject({ total: 4 });
    // Re-clicking the same scope changes nothing (dedupe).
    q.enqueueBulk('b', [{ chapterIdx: 1, chunkIdxs: [0, 1] }]);
    expect(q.status().bulk).toMatchObject({ total: 4 });
  });

  it('cancelBulk drops queued prefetch work but keeps user jobs', async () => {
    // The first (bulk) job settles; later ones hang, like a slow render.
    generate.mockImplementationOnce(() => Promise.resolve(new Blob(['x'])));
    generate.mockImplementation(() => new Promise<Blob>(() => undefined));
    const q = new GenerationQueue();
    await q.init();
    q.enqueueBulk('b', [{ chapterIdx: 0, chunkIdxs: [0, 1, 2] }]);
    await advanceUntil(() => calls() === 1 && q.status().pending === 2, 5_000);
    q.enqueue('b', 0, [9], 'user');
    q.cancelBulk('b');
    // The user job survives; the in-flight job (already running) finishes on
    // its own but nothing new starts for the bulk run.
    expect(q.status().bulk).toBeNull();
    expect(q.status().pending).toBe(1);
    await vi.advanceTimersByTimeAsync(RATE_INTERVAL_MS + 100);
    expect(calls()).toBe(2);
    expect(generate).toHaveBeenLastCalledWith('b', 0, 9);
  });

  it('persists its queue and resumes after a restart', async () => {
    const q1 = new GenerationQueue();
    await q1.init();
    q1.enqueue('b', 3, [10, 11], 'prefetch');
    await advanceUntil(() => calls() >= 1, 5_000);
    await vi.advanceTimersByTimeAsync(200); // let the post-job persist land

    // A fresh instance resumes the interrupted queue from persisted state;
    // init()'s pump picks the job up right away.
    const q2 = new GenerationQueue();
    await q2.init();
    await advanceUntil(() => calls() >= 2, 30_000);
    expect(generate).toHaveBeenLastCalledWith('b', 3, 11);
  });

  it('counts daily requests and warns near the free cap', async () => {
    const day = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    // Simulate a heavy day via the persisted counter (init reads it back).
    await db.kv.put({ key: 'genqueue.v1', value: { jobs: [], day, requestsToday: 899 } });
    const q = new GenerationQueue();
    await q.init();
    expect(q.status().quotaWarning).toBe(false);

    q.enqueue('b', 0, [0], 'user');
    await advanceUntil(() => calls() >= 1, 5_000);
    expect(q.status().requestsToday).toBe(900);
    expect(q.status().quotaWarning).toBe(true);
  });

  it('persists a snapshot of the queue, not the live array', async () => {
    // persist() used to capture this.jobs by reference; the pump splices that
    // same array in place moments later, so the value IndexedDB eventually
    // clones could already be missing jobs — a restart then lost them.
    generate.mockImplementation(() => new Promise<Blob>(() => undefined)); // never settle
    const captured: Array<{ jobs: unknown[] }> = [];
    const origPut = db.kv.put.bind(db.kv);
    vi.spyOn(db.kv, 'put').mockImplementation(async (row: { key: string; value: { jobs: unknown[] } }) => {
      captured.push(row.value);
      return origPut(row as never);
    });
    try {
      const q = new GenerationQueue();
      await q.init();
      q.enqueue('b', 0, [0, 1], 'prefetch');
      // The pump starts job 0 synchronously inside enqueue(), splicing the
      // live array down to one — the persist() taken a moment earlier must
      // still hold both.
      await vi.advanceTimersByTimeAsync(10);
      expect(captured.at(-1)?.jobs).toHaveLength(2);
    } finally {
      (db.kv.put as ReturnType<typeof vi.spyOn>).mockRestore();
    }
  });

  it('cancelAll drops every queued job across books', async () => {
    generate.mockImplementation(() => new Promise<Blob>(() => undefined)); // never settle
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0, 1], 'prefetch'); // 0 starts, 1 queues behind the gate
    q.enqueue('c', 0, [0], 'user');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls()).toBe(1);

    // A resumed-from-restart queue has no bulk run to target, so the
    // progress card's Stop falls back to this: everything queued goes.
    q.cancelAll();
    expect(q.status().bulk).toBeNull();
    expect(q.status().pending).toBe(1); // only the in-flight chunk remains
    await vi.advanceTimersByTimeAsync(RATE_INTERVAL_MS * 3);
    expect(calls()).toBe(1); // nothing else ever starts
  });

  it('cancelChapter drops queued jobs for that chapter', async () => {
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0, 1, 2], 'prefetch');
    q.enqueue('b', 1, [0], 'prefetch');
    // The pump starts the first chunk synchronously inside enqueue() and
    // pending counts in-flight jobs too — let that one finish so the
    // assertion below is purely about the queued remainder.
    await advanceUntil(() => q.status().pending === 3, 5_000);
    q.cancelChapter('b', 0);
    expect(q.status().pending).toBe(1);
    q.cancelBook('b');
    expect(q.status().pending).toBe(0);
  });
});
