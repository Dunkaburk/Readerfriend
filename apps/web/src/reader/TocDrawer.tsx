/**
 * Table of contents drawer (§6.1 reader top bar). Slides in from the right;
 * one entry per chapter, current chapter marked.
 */

import type { ChapterMetaRow } from '../db/dexie';

interface TocDrawerProps {
  open: boolean;
  chapters: ChapterMetaRow[];
  currentIdx: number;
  onSelect(idx: number): void;
  onClose(): void;
}

export function TocDrawer({ open, chapters, currentIdx, onSelect, onClose }: TocDrawerProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-label="Table of contents">
      <button
        type="button"
        aria-label="Close table of contents"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/30"
      />
      <nav className="absolute inset-y-0 right-0 flex w-80 max-w-[85vw] flex-col bg-surface shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-black/10 px-4 dark:border-white/10">
          <h2 className="text-sm font-medium text-fg">Contents</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center text-muted hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto py-2">
          {chapters.map((ch) => {
            const current = ch.idx === currentIdx;
            return (
              <li key={ch.idx}>
                <button
                  type="button"
                  onClick={() => onSelect(ch.idx)}
                  className={
                    'flex min-h-11 w-full items-baseline gap-3 px-4 py-2 text-left text-sm ' +
                    (current ? 'bg-accent/10 text-accent' : 'text-fg hover:bg-black/5 dark:hover:bg-white/5')
                  }
                >
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted">
                    {ch.idx + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{ch.title ?? `Chapter ${ch.idx + 1}`}</span>
                    <span className="block text-xs text-muted">{formatChars(ch.charCount)} chars</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}

function formatChars(n: number): string {
  return n.toLocaleString();
}
