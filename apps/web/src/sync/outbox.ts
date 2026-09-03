/**
 * Outbox flush (§6.2/§7): replay queued uploads in order. Any failure stops
 * the flush (entries stay, order preserved); 401 stops everything until the
 * user fixes the token. Triggered on app start, on `online`, and after imports.
 */

import { api, ApiError } from '../api/client';
import { blobStore } from '../adapters/blobStore.dexie';
import { db } from '../db/dexie';
import { buildCreateBody } from '../import/importService';

async function apply(entry: import('../db/dexie').OutboxEntry): Promise<void> {
  switch (entry.kind) {
    case 'createBook': {
      const body = await buildCreateBody(entry.bookId);
      await api.createBook(body);
      break;
    }
    case 'putSource': {
      const book = await db.books.get(entry.bookId);
      if (!book) return; // deleted locally since; skip
      const blob = await blobStore.get(book.sourceKey);
      if (!blob) return;
      await api.putSource(entry.bookId, entry.ext ?? 'epub', blob);
      break;
    }
    case 'putCover': {
      const book = await db.books.get(entry.bookId);
      if (!book?.coverKey) return;
      const blob = await blobStore.get(book.coverKey);
      if (!blob) return;
      await api.putCover(entry.bookId, entry.ext ?? 'png', blob);
      break;
    }
    case 'deleteBook': {
      await api.deleteBook(entry.bookId);
      break;
    }
  }
}

/** True when this failure should not be retried until user action. */
function isFatal(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

let flushing = false;

export async function flushOutbox(): Promise<{ synced: number; remaining: number }> {
  if (flushing) return { synced: 0, remaining: await db.outbox.count() };
  flushing = true;
  let synced = 0;
  try {
    const entries = await db.outbox.orderBy('id').toArray();
    for (const entry of entries) {
      try {
        await apply(entry);
        if (entry.id !== undefined) await db.outbox.delete(entry.id);
        synced += 1;
      } catch (err) {
        if (entry.id !== undefined) {
          await db.outbox.update(entry.id, { attempts: entry.attempts + 1 });
        }
        // Network errors and 5xx stop the flush; the entries survive.
        throw err;
      }
    }
  } finally {
    flushing = false;
    // Books whose upload sequence completed are now server-confirmed.
    await settlePendingSync();
  }
  return { synced, remaining: await db.outbox.count() };
}

/** Mark books with no remaining outbox work as synced. */
export async function settlePendingSync(): Promise<void> {
  const pendingBooks = await db.books.where('pendingSync').equals(1).toArray();
  for (const book of pendingBooks) {
    const remaining = await db.outbox.where('bookId').equals(book.id).count();
    if (remaining === 0) {
      await db.books.update(book.id, { pendingSync: 0 });
    }
  }
}

/** Wire the standard triggers. Returns a cleanup fn (unused in production). */
export function startOutboxTrigger(): () => void {
  const run = (): void => {
    void flushOutbox().catch(() => {
      // Flushing is best-effort; failures remain queued.
    });
  };
  window.addEventListener('online', run);
  window.addEventListener('focus', run);
  // Give the settings store a moment to hydrate before the first attempt.
  const t = setTimeout(run, 1500);
  return () => {
    window.removeEventListener('online', run);
    window.removeEventListener('focus', run);
    clearTimeout(t);
  };
}
