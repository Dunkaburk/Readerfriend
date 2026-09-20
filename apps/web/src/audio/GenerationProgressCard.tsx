/**
 * Floating generation-progress card: a persistent, screen-wide indicator for
 * background TTS generation — bulk runs ("generate whole chapter/book") and
 * leftover prefetch alike. Complements the PlayerBar's own progress line:
 * the card hides while narration is active (the player bar already shows
 * progress then) and floats above the reader/library otherwise, so a running
 * queue is never invisible and can always be stopped.
 */

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/dexie';
import { useNarration } from '../state/narration';
import { useGenerationStatus } from './useGenerationStatus';
import { DAILY_QUOTA, generationQueue, RATE_INTERVAL_MS } from './generationQueue';
import type { GenerationStatus } from './generationQueue';

export function GenerationProgressCard() {
  const gen = useGenerationStatus();
  const narrating = useNarration((s) => s.active);
  const [dismissedKey, setDismissedKey] = useState<number | null>(null);

  const busy = gen.pending > 0 || gen.current !== null;
  // A bulk run's startedAt keys its dismissal; non-bulk activity shares key 0
  // and stays hidden until the next real bulk run begins.
  const runKey = gen.bulk?.startedAt ?? 0;
  if (!busy || narrating || dismissedKey === runKey) return null;

  return <CardInner gen={gen} onDismiss={() => setDismissedKey(runKey)} />;
}

function CardInner({ gen, onDismiss }: { gen: GenerationStatus; onDismiss: () => void }) {
  const bookId = gen.bulk?.bookId ?? gen.current?.bookId ?? null;
  const book = useLiveQuery(
    async () => (bookId ? db.books.get(bookId) : undefined),
    [bookId],
  );
  // Display title of the chunk being generated right now (the bulk run's
  // chapters don't map 1:1 onto spine idx + 1, so the raw number reads
  // oddly next to the reader's "Chapter 24"-style titles).
  const cur = gen.current;
  const curTitle = useLiveQuery(
    async () =>
      cur && bookId
        ? ((await db.chapters.get([bookId, cur.chapterIdx]))?.title ?? null)
        : null,
    [bookId, cur?.chapterIdx],
  );

  const bulk = gen.bulk;
  const pct =
    bulk && bulk.total > 0 ? Math.min(100, Math.round((bulk.done / bulk.total) * 100)) : null;
  const remaining = bulk ? Math.max(0, bulk.total - bulk.done) : gen.pending;
  const etaMin = bulk && gen.chunksPerMinute ? remaining / gen.chunksPerMinute : null;

  const detail: string[] = [];
  if (bulk) detail.push(`${bulk.done} of ${bulk.total} chunks done`);
  else detail.push(`${gen.pending} chunk${gen.pending === 1 ? '' : 's'} queued`);
  if (etaMin !== null) {
    detail.push(etaMin < 1 ? 'under a minute left' : `~${Math.ceil(etaMin)} min left`);
  } else if (bulk) {
    detail.push(`~${Math.ceil((remaining * RATE_INTERVAL_MS) / 60_000)} min left`);
  }
  if (gen.current) {
    detail.push(
      `${curTitle ?? `chapter ${gen.current.chapterIdx + 1}`}, chunk ${gen.current.chunkIdx + 1}`,
    );
  }
  if (gen.nextAttemptInMs > 1_500) {
    detail.push(`retrying in ${Math.ceil(gen.nextAttemptInMs / 1000)}s`);
  }

  return (
    <div
      className="fixed inset-x-3 bottom-20 z-30 sm:inset-x-auto sm:right-4 sm:w-96"
      role="status"
      aria-live="polite"
      aria-label="Audio generation progress"
    >
      <div className="rounded-lg border border-black/10 bg-surface/95 p-3 shadow-lg backdrop-blur dark:border-white/15">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
            aria-hidden
          />
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
            Generating audio{book?.title ? ` — ${book.title}` : ''}
          </p>
          <button
            type="button"
            onClick={() =>
              bookId ? generationQueue.cancelBulk(bookId) : generationQueue.cancelAll()
            }
            className="h-8 shrink-0 rounded-md border border-black/15 px-2.5 text-xs text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
            aria-label="Stop background generation"
          >
            Stop
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:text-fg"
            aria-label="Hide the progress card (generation continues)"
            title="Hide — generation keeps running"
          >
            ✕
          </button>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
          {pct !== null ? (
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" aria-hidden />
          )}
        </div>
        <p className="mt-1.5 text-xs text-muted tabular-nums">{detail.join(' · ')}</p>
        {gen.quotaWarning && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" role="status">
            {gen.requestsToday}/{DAILY_QUOTA} generation requests used today.
          </p>
        )}
      </div>
    </div>
  );
}
