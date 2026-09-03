/**
 * D1 access (SPEC §4.1). Snake_case rows mapped to the shared camelCase types
 * at this boundary; everything above deals in the shared JSON shapes.
 */

import type { Book, ChapterMeta, Chunk, Progress, SourceFormat } from '@readerfriend/shared';

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  language: string | null;
  source_format: string;
  source_key: string;
  cover_key: string | null;
  char_count: number;
  chapter_count: number;
  added_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export function bookFromRow(r: BookRow): Book {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    language: r.language,
    sourceFormat: r.source_format as Book['sourceFormat'],
    sourceKey: r.source_key,
    coverKey: r.cover_key,
    charCount: r.char_count,
    chapterCount: r.chapter_count,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export const BOOK_COLUMNS =
  'id, title, author, language, source_format, source_key, cover_key, char_count, chapter_count, added_at, updated_at, deleted_at';

export interface BookInsert {
  id: string;
  title: string;
  author: string | null;
  language: string | null;
  sourceFormat: SourceFormat;
  sourceKey: string;
  coverKey: string | null;
  charCount: number;
  chapterCount: number;
  addedAt: number;
  updatedAt: number;
}

export function bookInsertParams(b: BookInsert): unknown[] {
  return [
    b.id, b.title, b.author, b.language, b.sourceFormat, b.sourceKey, b.coverKey,
    b.charCount, b.chapterCount, b.addedAt, b.updatedAt,
  ];
}

export const INSERT_BOOK_SQL =
  'INSERT INTO books (id, title, author, language, source_format, source_key, cover_key, char_count, chapter_count, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// --- chapters ---

interface ChapterRow {
  book_id: string;
  idx: number;
  title: string | null;
  href: string | null;
  char_count: number;
}

export function chapterFromRow(r: ChapterRow): ChapterMeta {
  return { idx: r.idx, title: r.title, href: r.href, charCount: r.char_count };
}

export const INSERT_CHAPTER_SQL =
  'INSERT INTO chapters (book_id, idx, title, href, char_count) VALUES (?, ?, ?, ?, ?)';

export function chapterInsertParams(bookId: string, ch: ChapterMeta): unknown[] {
  return [bookId, ch.idx, ch.title, ch.href, ch.charCount];
}

// --- chunks ---

interface ChunkRow {
  book_id: string;
  chapter_idx: number;
  chunk_idx: number;
  char_start: number;
  char_end: number;
  text: string;
  audio_key: string | null;
  voice: string | null;
  model: string | null;
  duration_ms: number | null;
  bytes: number | null;
  created_at: number | null;
}

export function chunkFromRow(r: ChunkRow): Chunk {
  return {
    chapterIdx: r.chapter_idx,
    chunkIdx: r.chunk_idx,
    charStart: r.char_start,
    charEnd: r.char_end,
    text: r.text,
    audioKey: r.audio_key,
    voice: r.voice,
    model: r.model,
    durationMs: r.duration_ms,
    bytes: r.bytes,
    createdAt: r.created_at,
  };
}

export const CHUNK_COLUMNS =
  'book_id, chapter_idx, chunk_idx, char_start, char_end, text, audio_key, voice, model, duration_ms, bytes, created_at';

export const INSERT_CHUNK_SQL =
  'INSERT INTO chunks (book_id, chapter_idx, chunk_idx, char_start, char_end, text) VALUES (?, ?, ?, ?, ?, ?)';

export function chunkInsertParams(
  bookId: string,
  c: { chapterIdx: number; chunkIdx: number; charStart: number; charEnd: number; text: string },
): unknown[] {
  return [bookId, c.chapterIdx, c.chunkIdx, c.charStart, c.charEnd, c.text];
}

// --- progress ---

interface ProgressRow {
  book_id: string;
  chapter_idx: number;
  char_offset: number;
  chunk_idx: number | null;
  audio_position_ms: number | null;
  updated_at: number;
}

export function progressFromRow(r: ProgressRow): Progress {
  return {
    bookId: r.book_id,
    chapterIdx: r.chapter_idx,
    charOffset: r.char_offset,
    chunkIdx: r.chunk_idx,
    audioPositionMs: r.audio_position_ms,
    updatedAt: r.updated_at,
  };
}

export const PROGRESS_COLUMNS =
  'book_id, chapter_idx, char_offset, chunk_idx, audio_position_ms, updated_at';
