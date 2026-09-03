/**
 * Local-first database (IndexedDB via Dexie).
 *
 * `books`/`chapters`/`chunks`/`progress` mirror the server (camelCase, as over
 * the wire) and gain local-only columns; `blobs` is the local blob store
 * (§6.3); `outbox` holds uploads that could not reach the server yet.
 */

import Dexie, { type EntityTable, type Table } from 'dexie';
import type { Book, ChapterMeta, ChunkPlan, Progress } from '@readerfriend/shared';

/** One entry in the offline upload queue (§6.2 step 5–6 retry). */
export type OutboxKind = 'createBook' | 'putSource' | 'putCover' | 'deleteBook';

export interface OutboxEntry {
  id?: number;
  bookId: string;
  kind: OutboxKind;
  /** For file puts: the extension used in the R2 key. */
  ext?: string;
  createdAt: number;
  attempts: number;
}

/** A book row mirrored from the server, plus local sync state. */
export interface StoredBook extends Book {
  /** 1 while the create/upload has not been confirmed by the server. */
  pendingSync: 0 | 1;
}

/** Chapter metadata only — cheap to load for the library grid and TOC. */
export interface ChapterMetaRow extends ChapterMeta {
  bookId: string;
}

/** The renderable part of a chapter, loaded only by the reader. */
export interface ChapterContentRow {
  bookId: string;
  idx: number;
  /** Sanitized HTML fragment, exactly as parsed at import time. */
  html: string;
  /** Normalized plain text — the chunking/highlight contract (§13 trap 2). */
  plainText: string;
}

/** Local copy of the chunk plan. Computed exactly once, at import (§4.3). */
export interface StoredChunk extends ChunkPlan {
  bookId: string;
  /** Generation state mirrored from the server when audio lands locally. */
  audioKey?: string | null;
  bytes?: number | null;
  createdAt?: number | null;
}

export interface BlobRow {
  key: string;
  blob: Blob;
  size: number;
  createdAt: number;
}

export const db = new Dexie('readerfriend') as Dexie & {
  blobs: EntityTable<BlobRow, 'key'>;
  books: EntityTable<StoredBook, 'id'>;
  chapters: Table<ChapterMetaRow, [string, number]>;
  chapterContent: Table<ChapterContentRow, [string, number]>;
  chunks: Table<StoredChunk, [string, number, number]>;
  progress: EntityTable<Progress, 'bookId'>;
  outbox: Table<OutboxEntry, number>;
  kv: EntityTable<{ key: string; value: unknown }, 'key'>;
};

db.version(1).stores({
  blobs: 'key',
  books: 'id, pendingSync, updatedAt',
  chapters: '[bookId+idx], bookId',
  chapterContent: '[bookId+idx]',
  chunks: '[bookId+chapterIdx+chunkIdx], bookId, [bookId+chapterIdx]',
  progress: 'bookId',
  outbox: '++id, bookId',
  kv: 'key',
});
