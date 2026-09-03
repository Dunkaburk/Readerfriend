/**
 * Sync engine (§6.4): library merge with watermark, progress last-write-wins,
 * soft-delete propagation, settings push/pull reconciliation, and second-device
 * hydration (content download + server-owned chunk plan).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, installFetchMock, restoreFetch, type FetchMock } from './fetch-mock';
import { r2Keys, DEFAULT_SETTINGS, type Book } from '@readerfriend/shared';
import type { StoredBook } from '../src/db/dexie';

vi.mock('../src/import/importService', () => ({
  parseFile: vi.fn(),
}));

const { db } = await import('../src/db/dexie');
const { blobStore } = await import('../src/adapters/blobStore.dexie');
const engine = await import('../src/sync/engine');
const { hydrateBook, isBookHydrated } = await import('../src/sync/hydrate');
const { parseFile } = await import('../src/import/importService');
const { useSettingsStore } = await import('../src/state/settings');

const parse = parseFile as ReturnType<typeof vi.fn>;

let mock: FetchMock;

function bookRow(overrides: Partial<Book> & { id: string }): Book {
  return {
    title: 'A Book',
    author: null,
    language: 'en',
    sourceFormat: 'epub',
    sourceKey: r2Keys.source(overrides.id, 'epub'),
    coverKey: null,
    charCount: 100,
    chapterCount: 1,
    addedAt: 1,
    updatedAt: 10,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  mock = installFetchMock();
  parse.mockReset();
  await db.books.clear();
  await db.chapters.clear();
  await db.chapterContent.clear();
  await db.chunks.clear();
  await db.progress.clear();
  await db.outbox.clear();
  await db.blobs.clear();
  await db.kv.clear();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, token: 't' });
});

afterEach(() => {
  restoreFetch();
});

describe('pullLibrary', () => {
  it('merges server books, confirms pending local creates, and stores the watermark', async () => {
    const local: StoredBook = { ...bookRow({ id: 'b1', title: 'Old Title' }), pendingSync: 1 };
    await db.books.put(local);
    await db.outbox.put({ bookId: 'b1', kind: 'putCover', ext: 'png', createdAt: 1, attempts: 0 });

    mock.queue.push(() =>
      jsonResponse(200, {
        books: [bookRow({ id: 'b1', title: 'Server Title', updatedAt: 20 }), bookRow({ id: 'b2' })],
        progress: [],
        serverTime: 555,
      }),
    );
    mock.queue.push(() => new Response(new Blob(['cover-bytes']), { status: 200 })); // b2 cover

    const { merged } = await engine.pullLibrary();

    expect(merged).toBe(2);
    const b1 = await db.books.get('b1');
    expect(b1?.title).toBe('Server Title');
    expect(b1?.pendingSync).toBe(0);
    const b2 = await db.books.get('b2');
    expect(b2?.pendingSync).toBe(0);
    // Watermark + last-pull time recorded for the incremental next round.
    expect(await db.kv.get('sync.watermark')).toMatchObject({ value: 555 });
    expect(await db.kv.get('sync.lastPullAt')).toBeDefined();
  });

  it('keeps the incremental watermark: a second pull re-requests from serverTime', async () => {
    mock.queue.push(() => jsonResponse(200, { books: [], progress: [], serverTime: 42 }));
    await engine.pullLibrary();
    mock.queue.push(() => jsonResponse(200, { books: [], progress: [], serverTime: 99 }));
    await engine.pullLibrary();
    expect(mock.requests[1]!.url).toContain('since=42');
  });

  it('applies progress last-write-wins on updated_at', async () => {
    await db.books.put({ ...bookRow({ id: 'b1' }), pendingSync: 0 });
    await db.progress.put({ bookId: 'b1', chapterIdx: 0, charOffset: 10, chunkIdx: null, audioPositionMs: null, updatedAt: 1000 });

    // Server is newer → wins.
    mock.queue.push(() =>
      jsonResponse(200, {
        books: [],
        progress: [{ bookId: 'b1', chapterIdx: 3, charOffset: 77, chunkIdx: 2, audioPositionMs: 500, updatedAt: 2000 }],
        serverTime: 10_000,
      }),
    );
    await engine.pullLibrary();
    expect(await db.progress.get('b1')).toMatchObject({ charOffset: 77, updatedAt: 2000 });

    // Server is older → local kept.
    mock.queue.push(() =>
      jsonResponse(200, {
        books: [],
        progress: [{ bookId: 'b1', chapterIdx: 0, charOffset: 1, chunkIdx: null, audioPositionMs: null, updatedAt: 500 }],
        serverTime: 20_000,
      }),
    );
    await engine.pullLibrary();
    expect(await db.progress.get('b1')).toMatchObject({ charOffset: 77, updatedAt: 2000 });
  });

  it('propagates soft deletes: local content, blobs and outbox go away', async () => {
    const id = 'b1';
    await db.books.put({ ...bookRow({ id }), pendingSync: 0 });
    await db.chapters.bulkPut([{ bookId: id, idx: 0, title: null, href: null, charCount: 100 }]);
    await db.chapterContent.put({ bookId: id, idx: 0, html: '<p>x</p>', plainText: 'x' });
    await db.chunks.put({ bookId: id, chapterIdx: 0, chunkIdx: 0, charStart: 0, charEnd: 1, text: 'x' });
    await db.progress.put({ bookId: id, chapterIdx: 0, charOffset: 0, chunkIdx: null, audioPositionMs: null, updatedAt: 1 });
    await blobStore.put(r2Keys.source(id, 'epub'), new Blob(['s']));
    await blobStore.put(r2Keys.audio(id, 0, 0), new Blob(['a']));
    await db.outbox.bulkPut([
      { bookId: id, kind: 'putSource', ext: 'epub', createdAt: 1, attempts: 0 },
      { bookId: id, kind: 'deleteBook', createdAt: 2, attempts: 0 },
    ]);

    mock.queue.push(() =>
      jsonResponse(200, { books: [bookRow({ id, deletedAt: 999, updatedAt: 1000 })], progress: [], serverTime: 2000 }),
    );
    const { deleted } = await engine.pullLibrary();

    expect(deleted).toBe(1);
    expect(await db.books.get(id)).toBeUndefined();
    expect(await db.chapterContent.where('bookId').equals(id).count()).toBe(0);
    expect(await db.chunks.where('bookId').equals(id).count()).toBe(0);
    expect(await db.progress.get(id)).toBeUndefined();
    expect(await blobStore.get(r2Keys.source(id, 'epub'))).toBeNull();
    expect(await blobStore.get(r2Keys.audio(id, 0, 0))).toBeNull();
    expect(await db.outbox.where('bookId').equals(id).count()).toBe(0);
  });
});

describe('settings sync', () => {
  it('adopts server settings when this device has no unsynced edits', async () => {
    const cleanup = engine.startSync();
    try {
      mock.queue.push(() => jsonResponse(200, { settings: { ...DEFAULT_SETTINGS, fontSize: 21, theme: 'sepia' } }));
      await engine.syncSettings();
      expect(useSettingsStore.getState().settings.fontSize).toBe(21);
      expect(useSettingsStore.getState().settings.theme).toBe('sepia');
    } finally {
      cleanup();
    }
  });

  it('pushes unsynced local edits instead of being clobbered by the server', async () => {
    const cleanup = engine.startSync();
    try {
      // Baseline: server and local agree.
      mock.queue.push(() => jsonResponse(200, { settings: { ...DEFAULT_SETTINGS } }));
      await engine.syncSettings();
      expect(mock.requests[0]!.url).toContain('/api/settings');

      // A local edit (not yet pushed)…
      useSettingsStore.getState().update({ fontSize: 24 });
      mock.queue.push(() => jsonResponse(200, { settings: { ...DEFAULT_SETTINGS, fontSize: 15 } }));
      await engine.syncSettings();

      // …is pushed (syncSettings always GETs first, then decides), and the
      // stale server copy does not overwrite it.
      expect(mock.requests[1]!.method).toBe('GET');
      const put = mock.requests[2]!;
      expect(put.method).toBe('PUT');
      expect(put.body).toMatchObject({ fontSize: 24 });
      expect(useSettingsStore.getState().settings.fontSize).toBe(24);
    } finally {
      cleanup();
    }
  });
});

describe('hydrateBook', () => {
  it('downloads the source, parses chapters and pulls the chunk plan from the server', async () => {
    const id = 'b1';
    const sourceKey = r2Keys.source(id, 'epub');
    await db.books.put({ ...bookRow({ id, sourceKey }), pendingSync: 0 });
    expect(await isBookHydrated(id)).toBe(false);

    parse.mockResolvedValue({
      title: 'A Book',
      author: null,
      language: 'en',
      cover: null,
      chapters: [
        {
          idx: 0,
          title: 'One',
          href: 'c1.xhtml',
          charCount: 5,
          html: '<p>hello</p>',
          plainText: 'hello',
          chunks: [], // parsed plan is ignored — the server owns chunk boundaries (§4.3)
        },
      ],
    });
    mock.queue.push(() => new Response(new Blob(['epub-bytes']), { status: 200 })); // source
    mock.queue.push(() =>
      jsonResponse(200, {
        chunks: [
          {
            chapterIdx: 0,
            chunkIdx: 0,
            charStart: 0,
            charEnd: 5,
            text: 'hello',
            audioKey: r2Keys.audio(id, 0, 0),
            voice: 'v',
            model: 'm',
            durationMs: null,
            bytes: 123,
            createdAt: 7,
          },
        ],
      }),
    );

    await hydrateBook(id);

    expect(await isBookHydrated(id)).toBe(true);
    expect(await blobStore.get(sourceKey)).not.toBeNull();
    const content = await db.chapterContent.get([id, 0]);
    expect(content?.plainText).toBe('hello');
    // Generation state mirrored from the server, not recomputed.
    const chunk = await db.chunks.get([id, 0, 0]);
    expect(chunk).toMatchObject({ charStart: 0, charEnd: 5, audioKey: r2Keys.audio(id, 0, 0), bytes: 123 });
    expect(await db.books.get(id)).toMatchObject({ chapterCount: 1 });
    expect(mock.requests[1]!.url).toContain('/api/books/b1/chapters/0/chunks');
  });

  it('shares one run between concurrent calls and is idempotent', async () => {
    const id = 'b2';
    await db.books.put({ ...bookRow({ id }), pendingSync: 0 });
    parse.mockResolvedValue({
      title: 'X',
      author: null,
      language: null,
      cover: null,
      chapters: [{ idx: 0, title: null, href: null, charCount: 2, html: '<p>hi</p>', plainText: 'hi', chunks: [] }],
    });
    mock.queue.push(() => new Response(new Blob(['x']), { status: 200 }));
    mock.queue.push(() => jsonResponse(200, { chunks: [] }));

    await Promise.all([hydrateBook(id), hydrateBook(id), hydrateBook(id)]);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(mock.requests).toHaveLength(2); // source + one chapter's chunks
  });

  it('refuses to hydrate a local-only book that never reached the server', async () => {
    await db.books.put({ ...bookRow({ id: 'b3' }), pendingSync: 1 });
    await expect(hydrateBook('b3')).rejects.toThrow(/not been synced/);
    expect(mock.requests).toHaveLength(0);
  });
});
