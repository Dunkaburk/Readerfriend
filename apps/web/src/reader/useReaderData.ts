/**
 * Reader data loading: book + chapter metas + saved progress, all from the
 * local mirror (Dexie) — offline-first (§7). Chapter content loads separately
 * so navigation only touches one chapter at a time.
 *
 * A book that exists only as synced metadata (imported on another device) is
 * hydrated on first open: source download + server chunk plan (§6.4).
 */

import { useEffect, useState } from 'react';
import type { Progress } from '@readerfriend/shared';
import {
  db,
  type ChapterContentRow,
  type ChapterMetaRow,
  type StoredBook,
  type StoredChunk,
} from '../db/dexie';
import { hydrateBook } from '../sync/hydrate';

export interface ReaderData {
  book: StoredBook;
  chapters: ChapterMetaRow[];
  initialProgress: Progress | null;
}

export type ReaderDataState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'hydrating'; book: StoredBook }
  | { status: 'error'; book: StoredBook | null; message: string }
  | { status: 'ready'; data: ReaderData };

export function useReaderData(bookId: string | undefined, retryKey = 0): ReaderDataState {
  const [state, setState] = useState<ReaderDataState>({ status: 'loading' });

  useEffect(() => {
    if (!bookId) return;
    let alive = true;
    setState({ status: 'loading' });
    void (async () => {
      let book = await db.books.get(bookId);
      if (!book || !alive) {
        if (alive) setState({ status: 'missing' });
        return;
      }
      const hasContent = (await db.chapterContent.where('bookId').equals(bookId).count()) > 0;
      if (!hasContent && book.pendingSync === 0) {
        // Metadata-only (synced from another device): download it.
        setState({ status: 'hydrating', book });
        try {
          await hydrateBook(bookId);
        } catch (err) {
          if (!alive) return;
          setState({
            status: 'error',
            book,
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        if (!alive) return;
        book = (await db.books.get(bookId)) ?? book;
      }
      const chapters = await db.chapters.where('bookId').equals(bookId).sortBy('idx');
      const initialProgress = (await db.progress.get(bookId)) ?? null;
      if (!alive) return;
      setState({ status: 'ready', data: { book, chapters, initialProgress } });
    })();
    return () => {
      alive = false;
    };
  }, [bookId, retryKey]);

  return state;
}

/** Content + chunk plan for one chapter, from the local mirror. */
export async function loadChapter(
  bookId: string,
  chapterIdx: number,
): Promise<{ content: ChapterContentRow | null; chunks: StoredChunk[] }> {
  const [content, chunks] = await Promise.all([
    db.chapterContent.get([bookId, chapterIdx]),
    db.chunks.where('[bookId+chapterIdx]').equals([bookId, chapterIdx]).sortBy('chunkIdx'),
  ]);
  return { content: content ?? null, chunks };
}
