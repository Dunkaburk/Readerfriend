/**
 * Outbox + local-mirror behaviour: the offline upload queue (§6.2/§7).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { r2Keys } from '@readerfriend/shared';
import { blobStore } from '../src/adapters/blobStore.dexie';
import { db } from '../src/db/dexie';
import { buildCreateBody, syncBookNow } from '../src/import/importService';
import { flushOutbox } from '../src/sync/outbox';
import { installFetchMock, jsonResponse, restoreFetch, type FetchMock } from './fetch-mock';

const BOOK_ID = '22222222-2222-4222-8222-222222222222';

async function seedBook(pendingSync: 0 | 1 = 1): Promise<void> {
  await blobStore.put(r2Keys.source(BOOK_ID, 'epub'), new Blob(['epub-bytes']));
  await blobStore.put(r2Keys.cover(BOOK_ID, 'png'), new Blob(['png-bytes']));
  await db.books.put({
    id: BOOK_ID,
    title: 'Offline Book',
    author: 'An Author',
    language: 'en',
    sourceFormat: 'epub',
    sourceKey: r2Keys.source(BOOK_ID, 'epub'),
    coverKey: r2Keys.cover(BOOK_ID, 'png'),
    charCount: 20,
    chapterCount: 1,
    addedAt: 1,
    updatedAt: 1,
    deletedAt: null,
    pendingSync,
  });
  await db.chapters.put({ bookId: BOOK_ID, idx: 0, title: 'Ch 1', href: 'c1.xhtml', charCount: 20 });
  await db.chapterContent.put({ bookId: BOOK_ID, idx: 0, html: '<p>hello world</p>', plainText: 'hello world' });
  await db.chunks.bulkPut([
    { bookId: BOOK_ID, chapterIdx: 0, chunkIdx: 0, charStart: 0, charEnd: 11, text: 'hello worl' },
    { bookId: BOOK_ID, chapterIdx: 0, chunkIdx: 1, charStart: 11, charEnd: 20, text: 'd' },
  ]);
}

let mock: FetchMock | null = null;
afterEach(() => {
  restoreFetch();
  mock = null;
});

describe('buildCreateBody', () => {
  it('reconstructs the POST /api/books body from the local mirror', async () => {
    await seedBook();
    const body = await buildCreateBody(BOOK_ID);
    expect(body.book).toMatchObject({
      id: BOOK_ID,
      title: 'Offline Book',
      author: 'An Author',
      sourceFormat: 'epub',
      coverExt: 'png',
      charCount: 20,
    });
    expect(body.chapters).toEqual([{ idx: 0, title: 'Ch 1', href: 'c1.xhtml', charCount: 20 }]);
    expect(body.chunks).toEqual([
      { chapterIdx: 0, chunkIdx: 0, charStart: 0, charEnd: 11, text: 'hello worl' },
      { chapterIdx: 0, chunkIdx: 1, charStart: 11, charEnd: 20, text: 'd' },
    ]);
  });
});

describe('syncBookNow', () => {
  it('uploads the book, source and cover, then marks it synced', async () => {
    await seedBook();
    mock = installFetchMock();
    await syncBookNow(BOOK_ID, 'png');

    const urls = mock.requests.map((r) => r.url);
    expect(urls[0]).toContain('/api/books');
    expect(urls[1]).toContain(`/api/books/${BOOK_ID}/source`);
    expect(urls[2]).toContain(`/api/books/${BOOK_ID}/cover`);
    expect((await db.books.get(BOOK_ID))?.pendingSync).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('queues the upload sequence when the server is unreachable', async () => {
    await seedBook();
    mock = installFetchMock();
    mock.queue.push(() => {
      throw new TypeError('Failed to fetch');
    });

    await expect(syncBookNow(BOOK_ID, 'png')).rejects.toThrow(/queued/i);
    expect(await db.outbox.where('bookId').equals(BOOK_ID).count()).toBe(3);
    expect((await db.books.get(BOOK_ID))?.pendingSync).toBe(1);
  });
});

describe('flushOutbox', () => {
  it('replays queued uploads in order and settles pendingSync', async () => {
    await seedBook();
    await db.outbox.bulkPut([
      { bookId: BOOK_ID, kind: 'createBook', createdAt: 1, attempts: 0 },
      { bookId: BOOK_ID, kind: 'putSource', ext: 'epub', createdAt: 2, attempts: 0 },
      { bookId: BOOK_ID, kind: 'putCover', ext: 'png', createdAt: 2, attempts: 0 },
    ]);
    mock = installFetchMock();
    mock.queue.push(() => jsonResponse(201, { book: { id: BOOK_ID } }));
    mock.queue.push(() => jsonResponse(200));
    mock.queue.push(() => jsonResponse(200));

    const { synced, remaining } = await flushOutbox();
    expect(synced).toBe(3);
    expect(remaining).toBe(0);
    expect((await db.books.get(BOOK_ID))?.pendingSync).toBe(0);
    expect(mock.requests.map((r) => r.method)).toEqual(['POST', 'PUT', 'PUT']);
  });

  it('stops at the first failure and keeps the queue intact', async () => {
    await seedBook();
    await db.outbox.bulkPut([
      { bookId: BOOK_ID, kind: 'createBook', createdAt: 1, attempts: 0 },
      { bookId: BOOK_ID, kind: 'putSource', ext: 'epub', createdAt: 2, attempts: 0 },
    ]);
    mock = installFetchMock();
    mock.queue.push(() => jsonResponse(500, { error: 'boom' }));

    await expect(flushOutbox()).rejects.toThrow('boom');
    expect(await db.outbox.count()).toBe(2);
    expect(mock.requests.map((r) => r.method)).toEqual(['POST']);
    expect((await db.books.get(BOOK_ID))?.pendingSync).toBe(1);
  });

  it('skips file puts whose book was deleted locally', async () => {
    await db.outbox.put({
      bookId: BOOK_ID,
      kind: 'putSource',
      ext: 'epub',
      createdAt: 1,
      attempts: 0,
    });
    mock = installFetchMock();
    mock.queue.push(() => jsonResponse(200));

    const { synced } = await flushOutbox();
    expect(synced).toBe(1);
    expect(mock.requests).toHaveLength(0);
  });
});
