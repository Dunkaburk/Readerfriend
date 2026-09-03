/**
 * Import orchestration (§6.2). Local-first: the book is stored and readable
 * before any upload is confirmed; failed uploads land in the outbox and
 * retry on connectivity.
 */

import { r2Keys } from '@readerfriend/shared';
import { blobStore } from '../adapters/blobStore.dexie';
import { api } from '../api/client';
import { db, type StoredBook, type StoredChunk } from '../db/dexie';
import type { ImportChapter, ImportRequest, ImportResult } from './protocol';

let worker: Worker | null = null;
let nextRequestId = 1;

interface PendingRequest {
  resolve: (result: Extract<ImportResult, { ok: true }>) => void;
  reject: (err: Error) => void;
}
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (ev: MessageEvent<ImportResult>) => {
      const waiter = pending.get(ev.data.id);
      if (!waiter) return;
      pending.delete(ev.data.id);
      if (ev.data.ok) waiter.resolve(ev.data);
      else waiter.reject(new Error(ev.data.error));
    });
    worker.addEventListener('error', (ev) => {
      // Worker-level failure (script error): fail every waiter.
      const err = new Error(ev.message || 'Import worker crashed');
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
      worker?.terminate();
      worker = null;
    });
  }
  return worker;
}

/** Parse + chunk a file in the import worker. */
export async function parseFile(file: File): Promise<{
  title: string;
  author: string | null;
  language: string | null;
  cover: { blob: Blob; ext: string } | null;
  chapters: ImportChapter[];
}> {
  const kind = file.name.toLowerCase().endsWith('.txt') ? 'txt' : 'epub';
  const req: ImportRequest = { id: nextRequestId++, kind };
  let transfer: Transferable[] = [];
  if (kind === 'epub') {
    req.bytes = await file.arrayBuffer();
    transfer = [req.bytes];
  } else {
    req.text = await file.text();
  }
  const result = await new Promise<Extract<ImportResult, { ok: true }>>((resolve, reject) => {
    pending.set(req.id, { resolve, reject });
    getWorker().postMessage(req, transfer);
  });
  return {
    title: result.title,
    author: result.author,
    language: result.language,
    cover: result.cover ? { blob: result.cover.blob, ext: result.cover.ext } : null,
    chapters: result.chapters,
  };
}

export class BookExistsError extends Error {
  constructor() {
    super('This book is already in your library.');
    this.name = 'BookExistsError';
  }
}

export interface ImportCallbacks {
  onStage?: (stage: 'parsing' | 'saving' | 'uploading' | 'done') => void;
  onError?: (message: string) => void;
}

/** Duplicate detection: same title+author+total size imports twice. */
async function findDuplicate(title: string, author: string | null): Promise<StoredBook | undefined> {
  const all = await db.books.toArray();
  return all.find(
    (b) => b.title === title && (b.author ?? null) === author && b.deletedAt === null,
  );
}

/**
 * Import a picked file end-to-end. Throws on parse errors; upload failures
 * are queued in the outbox and surfaced as a non-fatal "will sync later".
 */
export async function importFile(file: File, cb: ImportCallbacks = {}): Promise<StoredBook> {
  cb.onStage?.('parsing');
  const parsed = await parseFile(file);
  if (parsed.chapters.length === 0) throw new Error('No readable chapters were found in this file.');

  const duplicate = await findDuplicate(parsed.title, parsed.author);
  if (duplicate) throw new BookExistsError();

  const bookId = crypto.randomUUID();
  const sourceExt = file.name.toLowerCase().endsWith('.txt') ? 'txt' : 'epub';
  const sourceKey = r2Keys.source(bookId, sourceExt);
  const coverKey = parsed.cover ? r2Keys.cover(bookId, parsed.cover.ext) : null;

  const book: StoredBook = {
    id: bookId,
    title: parsed.title,
    author: parsed.author,
    language: parsed.language,
    sourceFormat: sourceExt === 'txt' ? 'txt' : 'epub',
    sourceKey,
    coverKey,
    charCount: parsed.chapters.reduce((n, c) => n + c.charCount, 0),
    chapterCount: parsed.chapters.length,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    pendingSync: 1,
  };

  cb.onStage?.('saving');
  // Blobs first (their own table); if the metadata transaction below fails the
  // retry overwrites them, so a partial import leaves at most orphan blobs.
  await blobStore.put(sourceKey, file);
  if (parsed.cover) await blobStore.put(coverKey!, parsed.cover.blob);
  await db.transaction('rw', db.books, db.chapters, db.chapterContent, db.chunks, async () => {
    await db.books.put(book);
    await db.chapters.bulkPut(
      parsed.chapters.map((c) => ({
        bookId,
        idx: c.idx,
        title: c.title,
        href: c.href,
        charCount: c.charCount,
      })),
    );
    await db.chapterContent.bulkPut(
      parsed.chapters.map((c) => ({ bookId, idx: c.idx, html: c.html, plainText: c.plainText })),
    );
    const chunks: StoredChunk[] = [];
    for (const c of parsed.chapters) {
      for (const ch of c.chunks) {
        chunks.push({ bookId, chapterIdx: c.idx, chunkIdx: ch.chunkIdx, charStart: ch.charStart, charEnd: ch.charEnd, text: ch.text });
      }
    }
    await db.chunks.bulkPut(chunks);
  });

  cb.onStage?.('uploading');
  await syncBookNow(bookId, parsed.cover?.ext ?? null).catch((err: unknown) => {
    // Local-first: the book stays usable; the outbox will retry (§6.2).
    cb.onError?.(
      err instanceof Error && err.message.includes('Failed to fetch')
        ? 'Imported locally — will sync when you are online.'
        : `Imported locally, but sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  cb.onStage?.('done');
  return book;
}

/**
 * Push one book to the server now: POST the plan, then PUT the blobs.
 * Enqueues into the outbox on any failure so a later flush retries.
 */
export async function syncBookNow(bookId: string, coverExt: string | null): Promise<void> {
  const book = await db.books.get(bookId);
  if (!book || book.deletedAt !== null) return;

  try {
    const body = await buildCreateBody(bookId);
    await api.createBook(body);
    await api.putSource(bookId, extOf(book.sourceKey), await mustBlob(book.sourceKey));
    if (book.coverKey && coverExt) {
      await api.putCover(bookId, coverExt, await mustBlob(book.coverKey));
    }
    await db.books.update(bookId, { pendingSync: 0 });
    await clearOutboxFor(bookId);
  } catch {
    // Queue the full sequence; the flusher replays in order.
    const existing = await db.outbox.where('bookId').equals(bookId).toArray();
    if (existing.length === 0) {
      await db.outbox.bulkPut([
        { bookId, kind: 'createBook', createdAt: Date.now(), attempts: 0 },
        { bookId, kind: 'putSource', ext: extOf(book.sourceKey), createdAt: Date.now(), attempts: 0 },
        ...(book.coverKey
          ? [{ bookId, kind: 'putCover' as const, ext: coverExt ?? extOf(book.coverKey), createdAt: Date.now(), attempts: 0 }]
          : []),
      ]);
    }
    throw new Error('Sync queued — will retry when online.');
  }
}

function extOf(key: string): string {
  const dot = key.lastIndexOf('.');
  return dot >= 0 ? key.slice(dot + 1) : '';
}

async function mustBlob(key: string): Promise<Blob> {
  const blob = await blobStore.get(key);
  if (!blob) throw new Error(`Local blob missing: ${key}`);
  return blob;
}

/** Reconstruct the POST /api/books body from the local mirror (§5 body). */
export async function buildCreateBody(bookId: string) {
  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Book ${bookId} not found locally`);
  const [chapters, chunks] = await Promise.all([
    db.chapters.where('bookId').equals(bookId).sortBy('idx'),
    db.chunks.where('bookId').equals(bookId).toArray(),
  ]);
  return {
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
      language: book.language,
      sourceFormat: book.sourceFormat,
      coverExt: book.coverKey ? extOf(book.coverKey) : null,
      charCount: book.charCount,
    },
    chapters: chapters.map((c) => ({
      idx: c.idx,
      title: c.title,
      href: c.href,
      charCount: c.charCount,
    })),
    chunks: chunks
      .sort((a, b) => a.chapterIdx - b.chapterIdx || a.chunkIdx - b.chunkIdx)
      .map((c) => ({
        chapterIdx: c.chapterIdx,
        chunkIdx: c.chunkIdx,
        charStart: c.charStart,
        charEnd: c.charEnd,
        text: c.text,
      })),
  };
}

async function clearOutboxFor(bookId: string): Promise<void> {
  const entries = await db.outbox.where('bookId').equals(bookId).toArray();
  await db.outbox.bulkDelete(entries.map((e) => e.id!).filter((id) => Number.isInteger(id)));
}

/** Remove a book locally; propagate the delete to the server when possible. */
export async function deleteBook(bookId: string): Promise<void> {
  const book = await db.books.get(bookId);
  if (!book) return;

  const touchedServer = book.pendingSync === 0 || (await db.outbox.where('bookId').equals(bookId).count()) > 0;
  if (touchedServer) {
    // Try now; fall back to the outbox so the delete is not lost offline.
    try {
      await api.deleteBook(bookId);
    } catch {
      await db.outbox.put({ bookId, kind: 'deleteBook', createdAt: Date.now(), attempts: 0 });
    }
  }
  await clearOutboxFor(bookId);

  for (const key of await blobStore.list(r2Keys.bookPrefix(bookId))) {
    await blobStore.delete(key);
  }
  await db.transaction('rw', db.books, db.chapters, db.chapterContent, db.chunks, db.progress, async () => {
    await db.books.delete(bookId);
    await db.chapters.where('bookId').equals(bookId).delete();
    await db.chapterContent.where('bookId').equals(bookId).delete();
    await db.chunks.where('bookId').equals(bookId).delete();
    await db.progress.delete(bookId);
  });
}
