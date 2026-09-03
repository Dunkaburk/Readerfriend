/**
 * Library state: local-first view over the Dexie mirror. The sync engine
 * (Task: Sync) merges server changes into Dexie; this store reads Dexie.
 */

import { create } from 'zustand';
import { db, type ChapterMetaRow, type StoredBook } from '../db/dexie';
import type { Progress } from '@readerfriend/shared';

export interface BookWithProgress extends StoredBook {
  /** 0..1, when a reading position exists. */
  progressPct: number | null;
  progressChapterIdx: number | null;
}

interface LibraryState {
  books: BookWithProgress[];
  loading: boolean;
  /** Refresh from the local mirror (Dexie). */
  refresh(): Promise<void>;
}

function withProgress(
  book: StoredBook,
  progress: Progress | undefined,
  metas: ChapterMetaRow[],
): BookWithProgress {
  let pct: number | null = null;
  if (progress && book.charCount > 0) {
    let before = 0;
    for (const ch of metas) {
      if (ch.idx < progress.chapterIdx) before += ch.charCount;
    }
    pct = Math.min(1, (before + progress.charOffset) / book.charCount);
  }
  return {
    ...book,
    progressPct: pct,
    progressChapterIdx: progress?.chapterIdx ?? null,
  };
}

export const useLibraryStore = create<LibraryState>()((set) => ({
  books: [],
  loading: true,

  refresh: async () => {
    const [books, progress, metas] = await Promise.all([
      db.books.toArray(),
      db.progress.toArray(),
      db.chapters.toArray(),
    ]);
    const progressByBook = new Map(progress.map((p) => [p.bookId, p]));
    const metasByBook = new Map<string, ChapterMetaRow[]>();
    for (const m of metas) {
      const list = metasByBook.get(m.bookId);
      if (list) list.push(m);
      else metasByBook.set(m.bookId, [m]);
    }
    const visible = books
      .filter((b) => b.deletedAt === null)
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((b) => withProgress(b, progressByBook.get(b.id), metasByBook.get(b.id) ?? []));
    set({ books: visible, loading: false });
  },
}));
