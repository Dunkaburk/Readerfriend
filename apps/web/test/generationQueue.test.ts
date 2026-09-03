/**
 * GenerationQueue behaviour (§9.2): rate limiting to 12/min, 429 handling
 * with Retry-After, bounded retries for other failures, persistence across
 * restarts, and the daily request count / quota warning.
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

const { GenerationQueue } = await import('../src/audio/generationQueue');
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
  it('rate limits to one request every 5 seconds (§9.2)', async () => {
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0, 1], 'prefetch');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls()).toBe(1);
    expect(generate).toHaveBeenCalledWith('b', 0, 0);

    // The second job can never run before the 5s gate.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls()).toBe(1);

    // ...and always runs once the gate passes.
    await advanceUntil(() => calls() >= 2, 60_000);
    expect(calls()).toBe(2);
    expect(generate).toHaveBeenLastCalledWith('b', 0, 1);
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

    // The regular 5s rate gate is not enough — the Retry-After gate holds
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

  it('cancelChapter drops queued jobs for that chapter', async () => {
    const q = new GenerationQueue();
    await q.init();
    q.enqueue('b', 0, [0, 1, 2], 'prefetch');
    q.enqueue('b', 1, [0], 'prefetch');
    q.cancelChapter('b', 0);
    expect(q.status().pending).toBe(1);
    q.cancelBook('b');
    expect(q.status().pending).toBe(0);
  });
});
