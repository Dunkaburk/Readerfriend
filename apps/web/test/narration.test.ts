/**
 * Narration seek behaviour (§9.4): a tap into a chunk that has no audio yet
 * must play that chunk once generation lands (it used to be discarded — the
 * "user moved on" guard compared against state.chunkIdx, which only updates
 * once audio resolves), and a newer seek must supersede an older in-flight
 * wait.
 *
 * The generation queue is a controllable fake mirroring the real queue's
 * emit semantics (including the no-op-enqueue emit suppression) — the real
 * singleton's rate gate and cross-test clock state would make the waits
 * nondeterministic. The tests drive a job to completion the way the real
 * queue does: run generateAndCache, then emit.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/generationQueue', () => {
  class GenerationQueue {
    private listeners = new Set<(s: unknown) => void>();
    private queued = new Set<string>();
    private emit(): void {
      for (const cb of [...this.listeners]) cb({});
    }
    prioritize(b: string, c: number, i: number): void {
      // Mirrors the real queue: an in-flight/queued job is kept, a missing
      // one is added as user-priority.
      this.queued.add(`${b}:${c}:${i}`);
      this.emit();
    }
    isQueued(b: string, c: number, i: number): boolean {
      return this.queued.has(`${b}:${c}:${i}`);
    }
    enqueue(b: string, c: number, idxs: number[]): void {
      let added = 0;
      for (const i of idxs) {
        const k = `${b}:${c}:${i}`;
        if (!this.queued.has(k)) {
          this.queued.add(k);
          added++;
        }
      }
      if (added === 0) return; // no-op enqueues must not emit (see real queue)
      this.emit();
    }
    subscribe(cb: (s: unknown) => void): () => void {
      this.listeners.add(cb);
      cb({});
      return () => this.listeners.delete(cb);
    }
    cancelAll(): void {
      this.queued.clear();
    }
    cancelBulk(): void {
      this.queued.clear();
    }
    /** Test hook: the real queue emits when an in-flight job settles. */
    __emit(): void {
      this.emit();
    }
  }
  return { generationQueue: new GenerationQueue() };
});

vi.mock('../src/audio/audioStore', () => {
  class ChunkNotGeneratedError extends Error {
    constructor() {
      super('Chunk has no audio yet');
      this.name = 'ChunkNotGeneratedError';
    }
  }
  const cache = new Map<string, Blob>();
  const key = (bookId: string, chapterIdx: number, chunkIdx: number): string =>
    `${bookId}:${chapterIdx}:${chunkIdx}`;
  return {
    ChunkNotGeneratedError,
    __cache: cache,
    getCachedChunkAudio: vi.fn(async (b: string, c: number, i: number) => cache.get(key(b, c, i)) ?? null),
    resolveChunkAudio: vi.fn(async (b: string, c: number, i: number) => {
      const blob = cache.get(key(b, c, i));
      if (!blob) throw new ChunkNotGeneratedError();
      return { blob, fromCache: true as const };
    }),
    generateAndCache: vi.fn(async (b: string, c: number, i: number) => {
      cache.set(key(b, c, i), new Blob(['x']));
    }),
  };
});

const { useNarration } = await import('../src/state/narration');
const { generateAndCache, __cache } = await import('../src/audio/audioStore');
const { generationQueue } = await import('../src/audio/generationQueue');

const cache = __cache as Map<string, Blob>;
const generate = generateAndCache as ReturnType<typeof vi.fn>;
const queue = generationQueue as ReturnType<typeof vi.fn> & {
  isQueued(b: string, c: number, i: number): boolean;
  __emit(): void;
};

const chunks = [
  { chunkIdx: 0, charStart: 0, charEnd: 100, text: 'a'.repeat(100) },
  { chunkIdx: 1, charStart: 100, charEnd: 200, text: 'b'.repeat(100) },
  { chunkIdx: 2, charStart: 200, charEnd: 300, text: 'c'.repeat(100) },
];

beforeAll(() => {
  // happy-dom's media elements are stubs; narration only needs the calls not
  // to throw.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue(undefined);
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test', writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true });
  }
});

beforeEach(() => {
  cache.clear();
  cache.set('b:0:0', new Blob(['chunk0']));
  generate.mockReset();
  // Default: generating seeds the local cache, like the real audioStore.
  generate.mockImplementation(async (b: string, c: number, i: number) => {
    cache.set(`${b}:${c}:${i}`, new Blob(['x']));
  });
  queue.cancelAll();
  useNarration.getState().stop();
});

afterEach(() => {
  // start() arms progress/player intervals for the session; an active
  // session keeps the worker's event loop alive and the run never finishes.
  useNarration.getState().stop();
  queue.cancelAll();
});

/** Settle the "generation" of one chunk the way the queue would. */
async function settleChunk(bookId: string, chapterIdx: number, chunkIdx: number): Promise<void> {
  await generate(bookId, chapterIdx, chunkIdx);
  queue.__emit();
}

describe('narration seek', () => {
  it('plays a cross-chunk seek once the tapped chunk finishes generating', async () => {
    await useNarration.getState().start('b', 0, 'Chapter 1', chunks, 0);
    expect(useNarration.getState().chunkIdx).toBe(0);
    expect(queue.isQueued('b', 0, 1)).toBe(true); // prefetch enqueued for the gap

    // Tapping the ungenerated chunk: spinner goes up, nothing plays yet.
    useNarration.getState().seekToChunkPosition(1, 1_000);
    await vi.waitFor(() => expect(useNarration.getState().waiting).toBe(true));
    expect(useNarration.getState().playing).toBe(false);

    // Generation lands and the queue emits…
    await settleChunk('b', 0, 1);

    // …and the tapped chunk plays — the wait used to bail here and leave the
    // spinner stuck with nothing playing.
    await vi.waitFor(() => {
      const s = useNarration.getState();
      expect(s.chunkIdx).toBe(1);
      expect(s.waiting).toBe(false);
      expect(s.playing).toBe(true);
      expect(s.positionMs).toBe(1_000);
    });
  });

  it('a newer seek supersedes an in-flight wait', async () => {
    await useNarration.getState().start('b', 0, 'Chapter 1', chunks, 0);
    useNarration.getState().seekToChunkPosition(1, 1_000);
    await vi.waitFor(() => expect(useNarration.getState().waiting).toBe(true));

    // The user taps back into the current chunk while the wait is pending —
    // it must re-route through playChunk (the stale same-chunk branch would
    // seek the old element and later lose the playhead to the wait).
    useNarration.getState().seekToChunkPosition(0, 2_000);
    await vi.waitFor(() => {
      const s = useNarration.getState();
      expect(s.chunkIdx).toBe(0);
      expect(s.playing).toBe(true);
      expect(s.waiting).toBe(false);
    });

    // The pending generation settles — the stale wait must not hijack
    // playback back to chunk 1.
    await settleChunk('b', 0, 1);
    await new Promise((r) => setTimeout(r, 25));

    const s = useNarration.getState();
    expect(s.chunkIdx).toBe(0);
    expect(s.waiting).toBe(false);
    expect(s.playing).toBe(true);
  });
});
