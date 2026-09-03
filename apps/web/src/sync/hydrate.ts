/**
 * Second-device hydration (§6.2 step 7 + §6.4). A book pulled by the sync
 * engine starts as metadata only — another device imported it. When the
 * reader opens it, this module downloads the original file, re-derives the
 * *renderable* chapters (sanitized HTML + normalized plain text), and pulls
 * the canonical chunk plan from the server.
 *
 * §13 trap 1: the chunk plan is NEVER recomputed here. Parsing produces
 * chapters and text; chunk boundaries come from D1 via the chunks endpoint.
 * Plain-text normalization is deterministic, so offsets line up.
 */

import { api } from '../api/client';
import { blobStore } from '../adapters/blobStore.dexie';
import { db } from '../db/dexie';
import { parseFile } from '../import/importService';

const inflight = new Map<string, Promise<void>>();

/** True when the book's renderable content is already on this device. */
export async function isBookHydrated(bookId: string): Promise<boolean> {
  return (await db.chapterContent.where('bookId').equals(bookId).count()) > 0;
}

/**
 * Download and store a synced book's content. Idempotent; concurrent calls
 * share one run. Throws when the source cannot be fetched or parsed.
 */
export function hydrateBook(bookId: string): Promise<void> {
  const running = inflight.get(bookId);
  if (running) return running;
  const p = doHydrate(bookId).finally(() => inflight.delete(bookId));
  inflight.set(bookId, p);
  return p;
}

async function doHydrate(bookId: string): Promise<void> {
  const book = await db.books.get(bookId);
  if (!book) throw new Error('Book not found locally');
  if (await isBookHydrated(bookId)) return;

  // A local-only import (not yet on the server) cannot be hydrated — its
  // source must still be in the local blob store.
  if (book.pendingSync === 1) throw new Error('Book has not been synced to the server yet');

  // 1. Original file → blob store (also serves chapter images, §8).
  const blob = await api.getSource(bookId);
  await blobStore.put(book.sourceKey, blob);

  // 2. Cover, once, so the library grid shows it.
  if (book.coverKey && !(await blobStore.has(book.coverKey))) {
    try {
      await blobStore.put(book.coverKey, await api.getCover(bookId));
    } catch {
      // Cosmetic — the placeholder covers a miss.
    }
  }

  // 3. Parse for rendered chapters (deterministic; §8 normalization).
  const file = new File([blob], `book.${book.sourceFormat}`);
  const parsed = await parseFile(file);
  if (parsed.chapters.length === 0) throw new Error('The downloaded file has no readable chapters');

  await db.transaction('rw', db.chapters, db.chapterContent, async () => {
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
  });

  // 4. Canonical chunk plan from the server, per chapter (§4.3). Mirrors
  // generation state so the reader knows what already has audio.
  for (const chapter of parsed.chapters) {
    const { chunks } = await api.getChunks(bookId, chapter.idx);
    await db.chunks.bulkPut(
      chunks.map((c) => ({
        bookId,
        chapterIdx: c.chapterIdx,
        chunkIdx: c.chunkIdx,
        charStart: c.charStart,
        charEnd: c.charEnd,
        text: c.text,
        audioKey: c.audioKey,
        bytes: c.bytes,
        createdAt: c.createdAt,
      })),
    );
  }

  // Chapter charCounts now exist locally; the library's progress bars use them.
  await db.books.update(bookId, { chapterCount: parsed.chapters.length });
}
