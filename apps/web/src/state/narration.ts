/**
 * Narration orchestrator (§9.2, §9.3): owns the play session for one chapter.
 * Resolves chunk audio (local blob → server cache → generation queue with
 * user-priority for the playhead), drives the ping-pong player, prefetches
 * generation ahead of the playhead (§9.2: stay ≥5 chunks in front), persists
 * listening progress every few seconds, and wires MediaSession.
 */

import { create } from 'zustand';
import type { Chunk } from '@readerfriend/shared';
import { db } from '../db/dexie';
import { useSettingsStore } from './settings';
import { generationQueue } from '../audio/generationQueue';
import { ChunkNotGeneratedError, getCachedChunkAudio, resolveChunkAudio } from '../audio/audioStore';
import { PingPongPlayer, type PlayerEvent } from '../audio/player';
import { blobStore } from '../adapters/blobStore.dexie';

/** §9.2 prefetch: keep at least this many chunks (~10 min audio) ahead. */
const AHEAD_CHUNKS = 5;
const PROGRESS_INTERVAL_MS = 5_000;

/** The plan fields narration needs — local StoredChunk rows satisfy this. */
export type NarratableChunk = Pick<Chunk, 'chunkIdx' | 'charStart' | 'charEnd' | 'text'>;

interface NarrationState {
  active: boolean;
  bookId: string | null;
  chapterIdx: number | null;
  chapterTitle: string | null;
  chunkIdx: number | null;
  totalChunks: number;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  rate: number;
  /** True while the playhead chunk is being generated (spinner). */
  waiting: boolean;
  error: string | null;

  start(bookId: string, chapterIdx: number, chapterTitle: string, chunks: NarratableChunk[], startChunkIdx?: number, startMs?: number): Promise<void>;
  stop(): void;
  toggle(): void;
  play(): void;
  pause(): void;
  nextChunk(): void;
  prevChunk(): void;
  /** Jump playback to a chunk of the active session (§9.4 tap-to-play). */
  seekToChunk(chunkIdx: number): void;
  /** Jump to a position within a chunk of the active session (sentence taps). */
  seekToChunkPosition(chunkIdx: number, positionMs: number): void;
  skip(seconds: number): void;
  setRate(rate: number): void;
}

export const useNarration = create<NarrationState>()((set, get) => ({
  active: false,
  bookId: null,
  chapterIdx: null,
  chapterTitle: null,
  chunkIdx: null,
  totalChunks: 0,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  rate: useSettingsStore.getState().settings.speed,
  waiting: false,
  error: null,

  async start(bookId, chapterIdx, chapterTitle, chunks, startChunkIdx, startMs) {
    get().stop();
    const byIdx = new Map<number, NarratableChunk>();
    for (const c of chunks) byIdx.set(c.chunkIdx, c);
    session = {
      bookId,
      chapterIdx,
      chapterTitle,
      byIdx,
      order: chunks.map((c) => c.chunkIdx),
    };

    const first = startChunkIdx ?? chunks[0]?.chunkIdx;
    if (first === undefined) {
      session = null;
      set({ error: 'This chapter has no narration chunks.' });
      return;
    }

    player = new PingPongPlayer();
    player.on(handlePlayerEvent);
    player.setRate(get().rate);
    set({
      active: true,
      bookId,
      chapterIdx,
      chapterTitle,
      chunkIdx: first,
      totalChunks: chunks.length,
      positionMs: 0,
      durationMs: 0,
      playing: false,
      waiting: false,
      error: null,
    });

    void setupMediaSession();
    queueUnsub = generationQueue.subscribe(() => void refreshAhead());
    progressTimer = setInterval(() => void persistProgress(), PROGRESS_INTERVAL_MS);

    await playChunk(first, { autoplay: true, startMs });
  },

  stop() {
    const wasActive = get().active;
    const posMs = player?.positionMs ?? get().positionMs;
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    if (queueUnsub) {
      queueUnsub();
      queueUnsub = undefined;
    }
    teardownMediaSession();
    if (wasActive) void persistProgress(posMs);
    player?.destroy();
    player = null;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    inflight.clear();
    session = null;
    set({
      active: false,
      bookId: null,
      chapterIdx: null,
      chapterTitle: null,
      chunkIdx: null,
      totalChunks: 0,
      positionMs: 0,
      durationMs: 0,
      playing: false,
      waiting: false,
    });
  },

  toggle() {
    if (get().playing) get().pause();
    else get().play();
  },

  play() {
    if (!player) return;
    player.play();
    set({ playing: true });
  },

  pause() {
    if (!player) return;
    player.pause();
    set({ playing: false });
    void persistProgress();
  },

  nextChunk() {
    void playChunk(nextOrderIdx(1), { autoplay: true });
  },

  prevChunk() {
    if (get().positionMs > 3000) {
      player?.seek(0);
      set({ positionMs: 0 });
      return;
    }
    void playChunk(nextOrderIdx(-1), { autoplay: true });
  },

  seekToChunk(chunkIdx) {
    if (!session || !session.byIdx.has(chunkIdx)) return;
    if (session.order.indexOf(chunkIdx) === -1) return;
    void playChunk(chunkIdx, { autoplay: true });
  },

  seekToChunkPosition(chunkIdx, positionMs) {
    if (!session || !session.byIdx.has(chunkIdx)) return;
    // A pending cross-chunk wait hasn't updated chunkIdx yet — a same-chunk
    // seek then would touch the old element and later lose to the wait.
    // Route through playChunk instead, which owns the wait.
    if (get().chunkIdx === chunkIdx && !get().waiting) {
      const ms = Math.max(0, positionMs);
      player?.seek(ms);
      set({ positionMs: ms });
      return;
    }
    void playChunk(chunkIdx, { autoplay: true, startMs: positionMs > 0 ? positionMs : undefined });
  },

  skip(seconds) {
    if (!player) return;
    const target = get().positionMs + seconds * 1000;
    const duration = get().durationMs;
    if (duration > 0 && target >= duration) {
      get().nextChunk();
      return;
    }
    player.seek(Math.max(0, target));
    set({ positionMs: Math.max(0, target) });
  },

  setRate(rate) {
    set({ rate });
    player?.setRate(rate);
    // Speed is a synced setting (§6.1); local write now, server sync in the
    // sync task.
    useSettingsStore.getState().update({ speed: rate });
  },
}));

// ---------------------------------------------------------------------------
// Session plumbing (module scope: one narration session at a time)

interface Session {
  bookId: string;
  chapterIdx: number;
  chapterTitle: string;
  byIdx: Map<number, NarratableChunk>;
  order: number[];
}

let session: Session | null = null;
let player: PingPongPlayer | null = null;
/** Bumped at every playChunk request. A wait that resolves after a newer
 *  request (another tap, skip, chapter change) must not touch the player —
 *  but it can't detect that via state.chunkIdx, which only updates once
 *  audio resolves, so the stale comparison silently discarded every
 *  cross-chunk wait's result and left the spinner stuck. */
let playRequestSeq = 0;
let progressTimer: ReturnType<typeof setInterval> | undefined;
let queueUnsub: (() => void) | undefined;
/** chunkIdx → object URL for the current session. */
const urls = new Map<number, string>();
/** chunkIdx → in-flight audio resolution (dedupes concurrent refreshes). */
const inflight = new Map<number, Promise<Blob | null>>();

function nextOrderIdx(delta: number): number | undefined {
  if (!session) return undefined;
  const cur = useNarration.getState().chunkIdx;
  const pos = cur === null ? -1 : session.order.indexOf(cur);
  return session.order[pos + delta];
}

/** Resolve audio for one chunk and point the player at it. */
async function playChunk(
  chunkIdx: number | undefined,
  opts: { autoplay: boolean; startMs?: number } = { autoplay: true },
): Promise<void> {
  if (!session || !player || chunkIdx === undefined) return;
  const sess = session;
  const seq = ++playRequestSeq;
  const chunk = sess.byIdx.get(chunkIdx);
  if (!chunk) return;

  let blob = await getCachedChunkAudio(sess.bookId, sess.chapterIdx, chunkIdx);
  if (!blob) {
    // §9.3: pause, show the spinner, resume when the chunk arrives. The
    // playhead chunk generates with user priority through the rate-limited
    // queue (never a bypass).
    useNarration.setState({ waiting: true, playing: false });
    generationQueue.prioritize(sess.bookId, sess.chapterIdx, chunkIdx);
    blob = await waitForChunk(chunkIdx);
    // Superseded by a newer playChunk request (another tap/skip), or the
    // session ended (stop() nulls it). The newer request owns the flags.
    if (session !== sess || seq !== playRequestSeq) return; // user moved on
    if (!blob) {
      useNarration.setState({
        waiting: false,
        error: 'This chunk could not be generated. Check your connection and try again.',
      });
      return;
    }
  }

  const url = URL.createObjectURL(blob);
  urls.set(chunkIdx, url);
  player.loadQueue([{ url, chunkIdx }], 0);
  if (opts.startMs) player.seek(opts.startMs);
  useNarration.setState({
    chunkIdx,
    positionMs: opts.startMs ?? 0,
    waiting: false,
    error: null,
    playing: opts.autoplay,
  });
  if (opts.autoplay) player.play();
  void refreshAhead();
}

/**
 * Wait for a chunk's audio to appear in the local cache (the generation
 * queue writes it there). Resolves null when the job disappears without
 * producing audio (dropped after retries, or the session ended).
 */
function waitForChunk(chunkIdx: number): Promise<Blob | null> {
  const existing = inflight.get(chunkIdx);
  if (existing) return existing;
  let resolveP: (b: Blob | null) => void = () => undefined;
  const p = new Promise<Blob | null>((resolve) => {
    resolveP = resolve;
  });
  inflight.set(chunkIdx, p);

  const sess = session;
  let unsub: (() => void) | undefined;
  const check = async () => {
    if (!sess) {
      finish(null);
      return;
    }
    const local = await getCachedChunkAudio(sess.bookId, sess.chapterIdx, chunkIdx);
    if (local) {
      finish(local);
      return;
    }
    if (!generationQueue.isQueued(sess.bookId, sess.chapterIdx, chunkIdx)) {
      finish(null);
    }
  };
  const finish = (b: Blob | null) => {
    unsub?.();
    if (inflight.get(chunkIdx) === p) inflight.delete(chunkIdx);
    resolveP(b);
  };
  void check();
  if (inflight.get(chunkIdx) === p) unsub = generationQueue.subscribe(() => void check());
  return p;
}

/**
 * Keep the player's queue fed in order (§9.2): resolve the next chunks
 * ahead of the playhead from local/server cache, and enqueue generation for
 * the first one that has no audio yet. Processing stops at the first gap so
 * the queue stays contiguous — later refreshes fill it as chunks land.
 */
async function refreshAhead(): Promise<void> {
  if (!session || !player) return;
  const sess = session;
  const cur = useNarration.getState().chunkIdx;
  if (cur === null) return;
  const pos = sess.order.indexOf(cur);

  const queued = new Set(player.queuedIdxs());
  for (let k = 1; k <= AHEAD_CHUNKS && pos + k < sess.order.length; k++) {
    const idx = sess.order[pos + k]!;
    if (urls.has(idx) || queued.has(idx)) continue;
    const pending = inflight.get(idx);
    const blob = await (pending ?? resolveChunkAudio(sess.bookId, sess.chapterIdx, idx, { generate: false })
      .then((r) => r.blob)
      .catch((err: unknown) => {
        if (err instanceof ChunkNotGeneratedError) {
          generationQueue.enqueue(sess.bookId, sess.chapterIdx, [idx], 'prefetch');
        }
        return null;
      }));
    inflight.delete(idx);
    if (!blob) break; // gap: wait for the queue to fill it
    const url = URL.createObjectURL(blob);
    urls.set(idx, url);
    player.extendQueue([{ url, chunkIdx: idx }]);
  }
}

function handlePlayerEvent(ev: PlayerEvent): void {
  switch (ev.type) {
    case 'position':
      useNarration.setState({ positionMs: ev.ms, durationMs: player?.durationMs ?? 0 });
      break;
    case 'chunkChange': {
      const chunkIdx = ev.chunkIdx;
      useNarration.setState({ chunkIdx, positionMs: 0 });
      // Release object URLs behind the playhead.
      if (session) {
        const pos = session.order.indexOf(chunkIdx);
        for (const idx of session.order.slice(0, Math.max(0, pos - 1))) {
          const url = urls.get(idx);
          if (url) {
            URL.revokeObjectURL(url);
            urls.delete(idx);
          }
        }
      }
      void persistProgress();
      void refreshAhead();
      break;
    }
    case 'ended': {
      // The queue can run dry mid-chapter while the prefetch fills; keep
      // going if there is a next chunk, otherwise the chapter is done (§9.3).
      const next = nextOrderIdx(1);
      if (next !== undefined) void playChunk(next, { autoplay: true });
      else useNarration.getState().stop();
      break;
    }
    case 'error':
      useNarration.setState({ error: 'Audio playback failed.', playing: false });
      break;
  }
}

async function persistProgress(positionOverrideMs?: number): Promise<void> {
  const s = useNarration.getState();
  if (!s.active || !s.bookId || !session || s.chapterIdx === null) return;
  const chunk = session.byIdx.get(s.chunkIdx ?? -1);
  try {
    await db.progress.put({
      bookId: s.bookId,
      chapterIdx: s.chapterIdx,
      charOffset: chunk?.charStart ?? 0,
      chunkIdx: s.chunkIdx,
      audioPositionMs: positionOverrideMs ?? s.positionMs,
      updatedAt: Date.now(),
    });
  } catch {
    // Progress persistence is best-effort.
  }
}

// ---------------------------------------------------------------------------
// MediaSession (§9.3): OS media controls and lock-screen metadata.

let artworkUrl: string | null = null;

async function setupMediaSession(): Promise<void> {
  if (!('mediaSession' in navigator) || !session) return;
  const sess = session;
  const ms = navigator.mediaSession;
  const book = await db.books.get(sess.bookId);
  if (!sess || session !== sess) return;
  ms.metadata = new MediaMetadata({
    title: sess.chapterTitle ?? book?.title ?? 'Narration',
    artist: book?.author ?? '',
    album: book?.title ?? 'Readerfriend',
    artwork: [],
  });
  if (book?.coverKey && !artworkUrl) {
    const blob = await blobStore.get(book.coverKey);
    if (blob && session === sess) {
      artworkUrl = URL.createObjectURL(blob);
      if (ms.metadata instanceof MediaMetadata) {
        ms.metadata.artwork = [{ src: artworkUrl, sizes: '512x512', type: blob.type || 'image/jpeg' }];
      }
    }
  }
  const n = useNarration.getState();
  const handlers: Array<[MediaSessionAction, (d?: MediaSessionActionDetails) => void]> = [
    ['play', () => n.play()],
    ['pause', () => n.pause()],
    ['previoustrack', () => n.prevChunk()],
    ['nexttrack', () => n.nextChunk()],
    ['seekbackward', () => n.skip(-15)],
    ['seekforward', () => n.skip(15)],
    ['stop', () => n.stop()],
  ];
  for (const [action, handler] of handlers) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // Unsupported action on this platform; fine.
    }
  }
}

function teardownMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'stop'] as MediaSessionAction[]) {
      navigator.mediaSession.setActionHandler(action, null);
    }
  } catch {
    // Ignore.
  }
  if (artworkUrl) {
    URL.revokeObjectURL(artworkUrl);
    artworkUrl = null;
  }
}
