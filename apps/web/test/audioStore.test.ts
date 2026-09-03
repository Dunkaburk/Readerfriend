/**
 * Chunk audio resolution (§6.4): local-first, then server cache, then
 * generation; plus the local mirroring generateAndCache performs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFetchMock, jsonResponse, restoreFetch, type FetchMock } from './fetch-mock';

const { blobStore } = await import('../src/adapters/blobStore.dexie');
const { db } = await import('../src/db/dexie');
const audioStore = await import('../src/audio/audioStore');
const { r2Keys } = await import('@readerfriend/shared');

let mock: FetchMock;

beforeEach(async () => {
  mock = installFetchMock();
  await db.chunks.bulkPut([
    {
      bookId: 'b1',
      chapterIdx: 0,
      chunkIdx: 0,
      charStart: 0,
      charEnd: 50,
      text: 'hello world',
    },
    {
      bookId: 'b1',
      chapterIdx: 0,
      chunkIdx: 1,
      charStart: 50,
      charEnd: 100,
      text: 'second chunk',
      audioKey: r2Keys.audio('b1', 0, 1),
    },
  ]);
});

afterEach(() => {
  restoreFetch();
});

describe('resolveChunkAudio', () => {
  it('returns the local blob without touching the network', async () => {
    const local = new Blob(['local-bytes'], { type: 'audio/mpeg' });
    await blobStore.put(r2Keys.audio('b1', 0, 0), local);

    const r = await audioStore.resolveChunkAudio('b1', 0, 0, { generate: false });
    expect(r.origin).toBe('local');
    // Note: content equality is untestable here — happy-dom's Blob is not
    // structured-cloneable, so fake-indexeddb stores only its type. Real
    // browsers round-trip bytes natively.
    expect(r.blob).not.toBeNull();
    expect(mock.requests).toHaveLength(0);
  });

  it('fetches the server cache when the chunk row has an audio_key', async () => {
    mock.queue.push(() => new Response(new Blob(['cached-bytes']), { status: 200 }));
    const r = await audioStore.resolveChunkAudio('b1', 0, 1, { generate: false });
    expect(r.origin).toBe('server-cache');
    expect(await new Response(r.blob).text()).toBe('cached-bytes');
    expect(mock.requests[0]!.method).toBe('GET');
    expect(mock.requests[0]!.url).toContain('/books/b1/chapters/0/chunks/1/audio');
    // Cached locally: a second resolve is a pure local hit.
    mock.queue.push(() => new Response('nope', { status: 500 }));
    const r2 = await audioStore.resolveChunkAudio('b1', 0, 1, { generate: true });
    expect(r2.origin).toBe('local');
  });

  it('falls back to generate when the cached GET 404s (stale audio_key)', async () => {
    mock.queue.push(() => jsonResponse(404, { error: 'not generated' }));
    mock.queue.push(() => new Response(new Blob(['fresh-bytes']), { status: 200 }));
    const r = await audioStore.resolveChunkAudio('b1', 0, 1, { generate: true });
    expect(r.origin).toBe('generated');
    expect(await new Response(r.blob).text()).toBe('fresh-bytes');
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1]!.method).toBe('POST');
  });

  it('throws ChunkNotGeneratedError when generate:false and nothing is cached', async () => {
    await expect(audioStore.resolveChunkAudio('b1', 0, 0, { generate: false })).rejects.toThrow(
      audioStore.ChunkNotGeneratedError,
    );
    expect(mock.requests).toHaveLength(0);
  });

  it('throws ChunkNotGeneratedError when generation 404s', async () => {
    mock.queue.push(() => jsonResponse(404, { error: 'unknown chunk' }));
    await expect(audioStore.resolveChunkAudio('b1', 0, 0)).rejects.toThrow(audioStore.ChunkNotGeneratedError);
  });
});

describe('generateAndCache', () => {
  it('caches the bytes locally and mirrors generation state into the chunk row', async () => {
    mock.queue.push(() => new Response(new Blob(['generated-audio']), { status: 200 }));
    const blob = await audioStore.generateAndCache('b1', 0, 0);
    expect(await new Response(blob).text()).toBe('generated-audio');

    const cached = await audioStore.getCachedChunkAudio('b1', 0, 0);
    expect(cached).not.toBeNull(); // content check not possible in happy-dom (Blob clone limitation)

    const row = await db.chunks.get(['b1', 0, 0]);
    expect(row?.audioKey).toBe(r2Keys.audio('b1', 0, 0));
    expect(row?.bytes).toBe(blob.size);
  });

  it('surfaces 429 with its Retry-After for the queue to act on', async () => {
    mock.queue.push(
      () =>
        new Response(JSON.stringify({ error: 'slow down' }), {
          status: 429,
          headers: { 'Retry-After': '45' },
        }),
    );
    const err = await audioStore.generateAndCache('b1', 0, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBe(429);
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(45_000);
  });
});

describe('dropCachedChunkAudio', () => {
  it('drops one chapter or the whole book, leaving others alone', async () => {
    await blobStore.put(r2Keys.audio('b1', 0, 0), new Blob(['a']));
    await blobStore.put(r2Keys.audio('b1', 1, 0), new Blob(['b']));
    await audioStore.dropCachedChunkAudio('b1', 0);
    expect(await blobStore.get(r2Keys.audio('b1', 0, 0))).toBeNull();
    expect(await blobStore.get(r2Keys.audio('b1', 1, 0))).not.toBeNull();

    await audioStore.dropCachedChunkAudio('b1');
    expect(await blobStore.get(r2Keys.audio('b1', 1, 0))).toBeNull();
  });
});
