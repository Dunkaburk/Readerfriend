/** Message protocol between the main thread and the import Web Worker. */

import type { ParsedCover } from '@readerfriend/shared/epub';

export interface ImportRequest {
  id: number;
  kind: 'epub' | 'txt';
  /** For epubs: the raw file bytes (transferred). */
  bytes?: ArrayBuffer;
  /** For txt: the decoded file text. */
  text?: string;
}

export interface ImportChunk {
  chunkIdx: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface ImportChapter {
  idx: number;
  title: string;
  href: string | null;
  charCount: number;
  /** Sanitized HTML fragment, exactly as it will be rendered. */
  html: string;
  /** Normalized plain text — chunking + highlight contract. */
  plainText: string;
  chunks: ImportChunk[];
}

export type ImportResult =
  | {
      id: number;
      ok: true;
      title: string;
      author: string | null;
      language: string | null;
      cover: ParsedCover | null;
      chapters: ImportChapter[];
    }
  | { id: number; ok: false; error: string };
