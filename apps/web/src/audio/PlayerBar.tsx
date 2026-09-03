/**
 * The player bar (§6.1 Player, §9.3): slides up from the bottom while audio
 * is active — play/pause, skip back/forward by chunk, 15-second seek, speed
 * control, chunk position — and expands to a full-screen player with cover
 * art. Shows generation progress and a spinner while the playhead chunk is
 * being generated (§9.3), plus the daily-quota warning (§9.2).
 */

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { blobStore } from '../adapters/blobStore.dexie';
import { db } from '../db/dexie';
import { useNarration } from '../state/narration';
import { useGenerationStatus } from './useGenerationStatus';
import { generationQueue, QUOTA_WARNING_AT, DAILY_QUOTA } from './generationQueue';

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function PlayerBar() {
  const narration = useNarration();
  const gen = useGenerationStatus();
  const [expanded, setExpanded] = useState(false);
  const [meta, setMeta] = useState<{ title: string; author: string | null; coverKey: string | null } | null>(null);

  const bookId = narration.bookId;
  /** Chunks of the narrated chapter that have audio (local mirror of the server). */
  const readyCount = useLiveQuery(async () => {
    if (!bookId || narration.chapterIdx === null) return 0;
    return db.chunks
      .where('[bookId+chapterIdx]')
      .equals([bookId, narration.chapterIdx])
      .filter((c) => !!c.audioKey)
      .count();
  }, [bookId, narration.chapterIdx]);
  /** Chapter chunks still missing audio — the "generate whole chapter" set. */
  const chapterPending = useLiveQuery(async () => {
    if (!bookId || narration.chapterIdx === null) return [] as number[];
    const rows = await db.chunks
      .where('[bookId+chapterIdx]')
      .equals([bookId, narration.chapterIdx])
      .toArray();
    return rows.filter((c) => !c.audioKey).map((c) => c.chunkIdx);
  }, [bookId, narration.chapterIdx]);
  /** Book-wide missing-audio count — the "generate whole book" size. */
  const bookPending = useLiveQuery(async () => {
    if (!bookId) return 0;
    return db.chunks.where('bookId').equals(bookId).filter((c) => !c.audioKey).count();
  }, [bookId]);

  useEffect(() => {
    if (!bookId) {
      setMeta(null);
      return;
    }
    let alive = true;
    void db.books.get(bookId).then((b) => {
      if (alive && b) setMeta({ title: b.title, author: b.author, coverKey: b.coverKey });
    });
    return () => {
      alive = false;
    };
  }, [bookId]);

  if (!narration.active) return null;

  const chapterTitle = narration.chapterTitle ?? 'Narration';
  const chunkNum = (narration.chunkIdx ?? 0) + 1;
  const position = `Chunk ${chunkNum} / ${narration.totalChunks}`;

  const controls = (
    <PlayerControls narration={narration} big={expanded} />
  );

  if (expanded) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-surface" role="dialog" aria-label="Now playing">
        <div className="flex items-center justify-between px-4 pt-4">
          <p className="truncate text-xs uppercase tracking-wide text-muted">{meta?.title ?? ''}</p>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex h-11 w-11 items-center justify-center rounded text-muted hover:text-fg"
            aria-label="Minimise player"
          >
            ⌄
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
          <div className="aspect-square w-48 overflow-hidden rounded-lg shadow-lg sm:w-64">
            <CoverArt coverKey={meta?.coverKey ?? null} title={meta?.title ?? ''} />
          </div>
          <div className="w-full max-w-md text-center">
            <p className="truncate text-lg text-fg">{chapterTitle}</p>
            <p className="mt-1 text-sm text-muted">{meta?.author ?? ''}</p>
          </div>
          <p className="text-sm text-muted tabular-nums">{position}</p>
          <GenerationLine
            waiting={narration.waiting}
            gen={gen}
            ready={readyCount ?? null}
            total={narration.totalChunks}
            chapterNum={(narration.chapterIdx ?? 0) + 1}
            centered
          />
          {controls}
          <QuotaLine gen={gen} />
          <BulkGeneration
            bookId={bookId}
            chapterIdx={narration.chapterIdx}
            chapterPending={chapterPending ?? []}
            bookPending={bookPending ?? 0}
            gen={gen}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        'fixed inset-x-0 bottom-0 z-40 border-t border-black/10 bg-surface/95 backdrop-blur transition-transform duration-150 dark:border-white/10 ' +
        'translate-y-0'
      }
    >
      <GenerationLine
        waiting={narration.waiting}
        gen={gen}
        ready={readyCount ?? null}
        total={narration.totalChunks}
        chapterNum={(narration.chapterIdx ?? 0) + 1}
      />
      {narration.error && (
        <p className="px-4 text-xs text-red-600 dark:text-red-400" role="alert">
          {narration.error}
        </p>
      )}
      <div className="mx-auto flex h-16 max-w-4xl items-center gap-1 px-3">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-11 min-w-11 items-center justify-center rounded text-muted hover:text-fg"
          aria-label="Expand player"
        >
          ⌃
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fg">{chapterTitle}</p>
          <p className="truncate text-xs text-muted tabular-nums">{position}</p>
        </div>
        {controls}
        <button
          type="button"
          onClick={() => narration.stop()}
          className="flex h-11 w-11 items-center justify-center rounded text-muted hover:text-fg"
          aria-label="Stop narration"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function PlayerControls({ narration, big }: { narration: ReturnType<typeof useNarration.getState>; big: boolean }) {
  const size = big ? 'h-14 w-14 text-xl' : 'h-11 w-11 text-base';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => narration.prevChunk()}
        className={'flex items-center justify-center rounded text-fg disabled:opacity-30 ' + size}
        aria-label="Previous chunk"
      >
        ⏮
      </button>
      <button
        type="button"
        onClick={() => narration.skip(-15)}
        className={'flex items-center justify-center rounded text-fg ' + (big ? 'h-12 w-12' : 'h-11 w-11')}
        aria-label="Back 15 seconds"
      >
        ↺15
      </button>
      <button
        type="button"
        onClick={() => narration.toggle()}
        className={
          'flex items-center justify-center rounded-full bg-accent text-white ' +
          (big ? 'mx-2 h-16 w-16 text-2xl' : 'mx-1 h-12 w-12 text-lg')
        }
        aria-label={narration.playing ? 'Pause' : 'Play'}
      >
        {narration.playing ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        onClick={() => narration.skip(15)}
        className={'flex items-center justify-center rounded text-fg ' + (big ? 'h-12 w-12' : 'h-11 w-11')}
        aria-label="Forward 15 seconds"
      >
        15↻
      </button>
      <button
        type="button"
        onClick={() => narration.nextChunk()}
        className={'flex items-center justify-center rounded text-fg disabled:opacity-30 ' + size}
        aria-label="Next chunk"
      >
        ⏭
      </button>
      <SpeedButton narration={narration} />
    </div>
  );
}

/** Cycles 0.75× → 2.0× in 0.25 steps (§9.3). */
function SpeedButton({ narration }: { narration: ReturnType<typeof useNarration.getState> }) {
  const next = () => {
    const i = SPEEDS.findIndex((s) => Math.abs(s - narration.rate) < 0.01);
    narration.setRate(SPEEDS[(i + 1) % SPEEDS.length]!);
  };
  return (
    <button
      type="button"
      onClick={next}
      className="ml-1 flex h-11 min-w-11 items-center justify-center rounded px-1 text-xs text-muted tabular-nums hover:text-fg"
      aria-label={`Playback speed ${narration.rate}×, tap to change`}
    >
      {narration.rate}×
    </button>
  );
}

function GenerationLine({
  waiting,
  gen,
  ready,
  total,
  chapterNum,
  centered,
}: {
  waiting: boolean;
  gen: ReturnType<typeof useGenerationStatus>;
  ready: number | null;
  total: number;
  chapterNum: number;
  centered?: boolean;
}) {
  if (waiting) {
    return (
      <div className={'flex items-center gap-2 px-4 py-1.5 text-xs text-muted ' + (centered ? 'justify-center' : '')}>
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
        {ready !== null ? `Generating chapter ${chapterNum} — ${ready} of ${total} chunks.` : 'Generating this chunk…'}
      </div>
    );
  }
  if (gen.current || gen.pending > 0) {
    const readyText = ready !== null ? `${ready} of ${total} chunks ready` : `${gen.pending} queued`;
    return (
      <p className={'px-4 py-1.5 text-xs text-muted ' + (centered ? 'text-center' : '')}>
        Generating chapter {chapterNum} — {readyText}.
      </p>
    );
  }
  if (centered) return <div className="py-1.5" aria-hidden />;
  return null;
}

function QuotaLine({ gen }: { gen: ReturnType<typeof useGenerationStatus> }) {
  if (!gen.quotaWarning) return null;
  return (
    <p className="px-4 pb-3 text-center text-xs text-amber-600 dark:text-amber-400" role="status">
      Approaching the daily free generation limit ({gen.requestsToday}/{DAILY_QUOTA} requests today — warning at{' '}
      {QUOTA_WARNING_AT}).
    </p>
  );
}

/**
 * Bulk generation (§9.2): "generate whole chapter" and "generate whole book"
 * for users preparing an offline trip, with the time warning the spec asks
 * for. 12 chunks/minute → ~5s per chunk.
 */
function BulkGeneration({
  bookId,
  chapterIdx,
  chapterPending,
  bookPending,
  gen,
}: {
  bookId: string | null;
  chapterIdx: number | null;
  chapterPending: number[];
  bookPending: number;
  gen: ReturnType<typeof useGenerationStatus>;
}) {
  if (!bookId || chapterIdx === null) return null;
  const busyHere = gen.current?.bookId === bookId;
  const working = busyHere || gen.pending > 0;
  const minutes = (chunks: number): number => Math.max(1, Math.ceil((chunks * 5) / 60));

  const generateChapter = (): void => {
    generationQueue.enqueue(bookId, chapterIdx, chapterPending, 'prefetch');
  };

  const generateBook = async (): Promise<void> => {
    const rows = await db.chunks.where('bookId').equals(bookId).toArray();
    const byChapter = new Map<number, number[]>();
    for (const r of rows) {
      if (r.audioKey) continue;
      const list = byChapter.get(r.chapterIdx);
      if (list) list.push(r.chunkIdx);
      else byChapter.set(r.chapterIdx, [r.chunkIdx]);
    }
    for (const [ch, idxs] of byChapter) {
      generationQueue.enqueue(bookId, ch, idxs, 'prefetch');
    }
  };

  const stop = (): void => {
    generationQueue.cancelChapter(bookId, chapterIdx);
    if (gen.current?.bookId === bookId) generationQueue.cancelBook(bookId);
  };

  if (chapterPending.length === 0 && bookPending === 0 && !working) return null;

  return (
    <div className="w-full max-w-md px-4 pb-6 text-center">
      <p className="text-xs uppercase tracking-wide text-muted">Prepare for offline</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {chapterPending.length > 0 && (
          <button
            type="button"
            onClick={generateChapter}
            className="h-11 rounded-md border border-black/15 px-4 text-xs text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
          >
            Generate whole chapter — {chapterPending.length} chunks (~{minutes(chapterPending.length)} min)
          </button>
        )}
        {bookPending > chapterPending.length && (
          <button
            type="button"
            onClick={() => void generateBook()}
            className="h-11 rounded-md border border-black/15 px-4 text-xs text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
          >
            Generate whole book — {bookPending} chunks (~{minutes(bookPending)} min)
          </button>
        )}
        {working && (
          <button
            type="button"
            onClick={stop}
            className="h-11 rounded-md border border-black/15 px-4 text-xs text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
          >
            Stop generating this book
          </button>
        )}
      </div>
      {(chapterPending.length > 0 || bookPending > 0) && (
        <p className="mt-2 text-xs text-muted">
          Generation runs one chunk every 5 seconds in the background — keep the app open until it
          finishes. {bookPending > 0 ? `${bookPending} chunk${bookPending === 1 ? '' : 's'} in this book lack audio.` : ''}
        </p>
      )}
    </div>
  );
}

function CoverArt({ coverKey, title }: { coverKey: string | null; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!coverKey) return;
    let alive = true;
    void blobStore.get(coverKey).then((blob) => {
      if (blob && alive) setUrl(URL.createObjectURL(blob));
    });
    return () => {
      alive = false;
    };
  }, [coverKey]);
  if (url) return <img src={url} alt="" className="h-full w-full object-cover" />;
  const initials = title
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <div className="flex h-full w-full items-center justify-center bg-accent/15">
      <span className="font-serif text-3xl text-accent">{initials}</span>
    </div>
  );
}
