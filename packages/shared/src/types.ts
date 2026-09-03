/**
 * Types shared by the client and the Worker.
 *
 * Convention: JSON over the wire is camelCase. D1 rows are snake_case and are
 * mapped to these types at the Worker boundary (see workers/api/src/db.ts).
 */

export type SourceFormat = 'epub' | 'txt';

export interface Book {
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
  /** Set when soft-deleted; clients remove their local copy when they see it. */
  deletedAt: number | null;
}

export interface ChapterMeta {
  /** 0-based position in spine order. */
  idx: number;
  title: string | null;
  /** Path inside the EPUB, for debugging. */
  href: string | null;
  charCount: number;
}

export interface Progress {
  bookId: string;
  chapterIdx: number;
  /** Offset into the chapter's normalized plain text. */
  charOffset: number;
  /** Last chunk played, if listening. */
  chunkIdx: number | null;
  /** Position within that chunk. */
  audioPositionMs: number | null;
  updatedAt: number;
}

/** The chunk plan sent at import time. The canonical record lives in D1. */
export interface ChunkPlan {
  chapterIdx: number;
  chunkIdx: number;
  /** Offset into the chapter's normalized plain text (inclusive). */
  charStart: number;
  /** Offset into the chapter's normalized plain text (exclusive). */
  charEnd: number;
  /** Exact string sent to the TTS model. */
  text: string;
}

/** A chunk as served by the API: plan fields plus generation state. */
export interface Chunk extends ChunkPlan {
  audioKey: string | null;
  voice: string | null;
  model: string | null;
  durationMs: number | null;
  bytes: number | null;
  createdAt: number | null;
}

/** Body of POST /api/books. */
export interface CreateBookRequest {
  book: {
    id: string;
    title: string;
    author: string | null;
    language: string | null;
    sourceFormat: SourceFormat;
    coverExt: string | null;
    charCount: number;
  };
  chapters: ChapterMeta[];
  chunks: ChunkPlan[];
}

/** Synced app settings. Stored as a JSON blob per key on the server. */
export interface AppSettings {
  model: string | null;
  voice: string | null;
  theme: 'light' | 'sepia' | 'dark';
  fontFamily: 'serif' | 'sans';
  fontSize: number;
  lineHeight: number;
  marginWidth: number;
  speed: number;
  /** Interpolated sentence highlighting (§9.4 enhancement). */
  sentenceHighlight: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  model: null,
  voice: null,
  theme: 'light',
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.6,
  marginWidth: 24,
  speed: 1,
  sentenceHighlight: true,
};

export interface LibraryResponse {
  books: Book[];
  progress: Progress[];
  serverTime: number;
}

export interface ChunkListResponse {
  chunks: Chunk[];
}

export interface ModelsResponse {
  models: TtsModel[];
}

export interface TtsModel {
  id: string;
  name: string;
  /** True when the model id ends with ":free". */
  free: boolean;
  /** Voice ids advertised by the model, when the models API declares them. */
  voices: string[];
  contextLength: number | null;
}

/** Progress update body for PUT /api/progress/:bookId (updated_at is server-set). */
export type ProgressUpdate = Omit<Progress, 'updatedAt' | 'bookId'>;

export interface AudioJobState {
  chapterIdx: number;
  chunkIdx: number;
  total: number;
  done: number;
}

/** R2 key layout (§4.2). Deterministic — reconstructable from coordinates. */
export const r2Keys = {
  source: (bookId: string, ext: string) => `books/${bookId}/source.${ext}`,
  cover: (bookId: string, ext: string) => `books/${bookId}/cover.${ext}`,
  audio: (bookId: string, chapterIdx: number, chunkIdx: number) =>
    `books/${bookId}/audio/${chapterIdx}/${chunkIdx}.mp3`,
  /** Everything belonging to a book lives under this prefix. */
  bookPrefix: (bookId: string) => `books/${bookId}/`,
};
