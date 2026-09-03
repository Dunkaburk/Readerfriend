/**
 * API integration tests. Requests go through SELF (the real worker) against
 * real D1/R2 via Miniflare; OpenRouter is mocked by stubbing globalThis.fetch.
 * The Cloudflare Vitest plugin isolates storage per test FILE, not per test,
 * so a beforeEach hook wipes D1/R2 between tests and each test seeds the
 * data it needs.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type {
  Book,
  Chunk,
  ChunkListResponse,
  CreateBookRequest,
  LibraryResponse,
  Progress,
} from '@readerfriend/shared';

const TOKEN = 'test-token-0123456789abcdef';
const API = 'https://internal.test';
const authHeaders = { Authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

const BOOK_ID = '11111111-1111-4111-8111-111111111111';

function createBody(overrides: Partial<CreateBookRequest['book']> = {}): CreateBookRequest {
  return {
    book: {
      id: BOOK_ID,
      title: 'Test Book',
      author: 'Ada Author',
      language: 'en',
      sourceFormat: 'epub',
      coverExt: 'png',
      charCount: 42,
      ...overrides,
    },
    chapters: [
      { idx: 0, title: 'Chapter 1', href: 'ch1.xhtml', charCount: 30 },
      { idx: 1, title: 'Chapter 2', href: 'ch2.xhtml', charCount: 12 },
    ],
    chunks: [
      { chapterIdx: 0, chunkIdx: 0, charStart: 0, charEnd: 20, text: 'First chunk of text.' },
      { chapterIdx: 0, chunkIdx: 1, charStart: 20, charEnd: 30, text: 'Second chunk.' },
      { chapterIdx: 1, chunkIdx: 0, charStart: 0, charEnd: 12, text: 'Chapter two text.' },
    ],
  };
}

async function seedBook(overrides: Partial<CreateBookRequest['book']> = {}): Promise<void> {
  const res = await SELF.fetch(`${API}/api/books`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(createBody(overrides)),
  });
  expect(res.status).toBe(201);
}

async function getLibrary(since = 0): Promise<LibraryResponse> {
  const res = await SELF.fetch(`${API}/api/library?since=${since}`, { headers: authHeaders });
  expect(res.status).toBe(200);
  return (await res.json()) as LibraryResponse;
}

/** Poll until `cond` passes (waitUntil tasks run after the response). */
async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// --- outbound fetch mocking -------------------------------------------------
// Tests share an isolate with the tested worker, so stubbing globalThis.fetch
// intercepts the Worker's calls to OpenRouter. Anything else passes through.

let openRouterCalls = 0;
let openRouterHandler: ((req: Request) => Response) | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.url.startsWith('https://openrouter.ai/')) {
      openRouterCalls++;
      return Promise.resolve(
        openRouterHandler
          ? openRouterHandler(req)
          : new Response('no OpenRouter mock for this test', { status: 599 }),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  openRouterHandler = null;
  openRouterCalls = 0;
});

function assertNoOpenRouterCalls(): void {
  expect(openRouterCalls).toBe(0);
}

// --- storage reset ----------------------------------------------------------
// Children first so foreign-key ordering never bites, then R2 under books/.

beforeEach(async () => {
  await Promise.all([
    env.DB.prepare('DELETE FROM chunks').run(),
    env.DB.prepare('DELETE FROM chapters').run(),
    env.DB.prepare('DELETE FROM progress').run(),
    env.DB.prepare('DELETE FROM settings').run(),
    env.DB.prepare('DELETE FROM books').run(),
  ]);
  let cursor: string | undefined;
  for (;;) {
    const listing = await env.BUCKET.list({ prefix: 'books/', cursor });
    await Promise.all(listing.objects.map((o) => env.BUCKET.delete(o.key)));
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
});

/** Intercept the TTS speech request (the global stub already counts calls). */
function mockSpeech(status: number, body: Uint8Array | string, extra: Record<string, string> = {}): void {
  openRouterHandler = () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'audio/mpeg', ...extra },
    });
}

describe('health & auth', () => {
  it('answers health without a token', async () => {
    const res = await SELF.fetch(`${API}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects missing and wrong tokens on real routes', async () => {
    expect((await SELF.fetch(`${API}/api/library`)).status).toBe(401);
    expect(
      (await SELF.fetch(`${API}/api/library`, { headers: { Authorization: 'Bearer nope' } })).status,
    ).toBe(401);
  });
});

describe('POST /api/books', () => {
  it('creates a book with chapters and chunks', async () => {
    const res = await SELF.fetch(`${API}/api/books`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(createBody()),
    });
    expect(res.status).toBe(201);
    const { book } = (await res.json()) as { book: Book };
    expect(book.id).toBe(BOOK_ID);
    expect(book.sourceKey).toBe(`books/${BOOK_ID}/source.epub`);
    expect(book.coverKey).toBe(`books/${BOOK_ID}/cover.png`);
    expect(book.chapterCount).toBe(2);
    expect(book.deletedAt).toBeNull();
  });

  it('is idempotent: a repeat call returns 200 and does not duplicate', async () => {
    await seedBook();
    const second = await SELF.fetch(`${API}/api/books`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(createBody()),
    });
    expect(second.status).toBe(200);
    expect((await getLibrary()).books.length).toBe(1);
  });

  it('rebuilds a partially-created book on repeat call', async () => {
    await seedBook();
    // Simulate an interrupted create: drop a chunk row behind the API's back.
    await env.DB
      .prepare('DELETE FROM chunks WHERE book_id = ? AND chapter_idx = 1 AND chunk_idx = 0')
      .bind(BOOK_ID)
      .run();
    const second = await SELF.fetch(`${API}/api/books`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(createBody()),
    });
    expect(second.status).toBe(201);
    const res = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/1/chunks`, {
      headers: authHeaders,
    });
    const { chunks } = (await res.json()) as ChunkListResponse;
    expect(chunks.length).toBe(1);
  });

  it('validates the body', async () => {
    const res = await SELF.fetch(`${API}/api/books`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ book: { id: 'x' } }),
    });
    expect(res.status).toBe(400);
  });
});

describe('source & cover blobs', () => {
  it('round-trips the source file with its content type', async () => {
    await seedBook();
    const bytes = 'fake-epub-bytes';
    const put = await SELF.fetch(`${API}/api/books/${BOOK_ID}/source`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/epub+zip' },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const { key, bytes: count } = (await put.json()) as { key: string; bytes: number };
    expect(key).toBe(`books/${BOOK_ID}/source.epub`);
    expect(count).toBe(bytes.length);

    const get = await SELF.fetch(`${API}/api/books/${BOOK_ID}/source`, { headers: authHeaders });
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('application/epub+zip');
    expect(await get.text()).toBe(bytes);
  });

  it('derives the ext from ?ext= when the content type is unknown', async () => {
    await seedBook({ sourceFormat: 'txt' });
    const put = await SELF.fetch(`${API}/api/books/${BOOK_ID}/source?ext=txt`, {
      method: 'PUT',
      headers: authHeaders,
      body: 'plain text',
    });
    expect(put.status).toBe(200);
    const { key } = (await put.json()) as { key: string };
    expect(key).toBe(`books/${BOOK_ID}/source.txt`);
  });

  it('404s for unknown books', async () => {
    const res = await SELF.fetch(`${API}/api/books/does-not-exist/source`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/epub+zip' },
      body: 'x',
    });
    expect(res.status).toBe(404);
  });

  it('round-trips the cover and 404s when no cover was uploaded', async () => {
    await seedBook();
    const noCover = await SELF.fetch(`${API}/api/books/${BOOK_ID}/cover`, { headers: authHeaders });
    expect(noCover.status).toBe(404);

    const put = await SELF.fetch(`${API}/api/books/${BOOK_ID}/cover`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'image/png' },
      body: 'fake-png-bytes',
    });
    expect(put.status).toBe(200);
    const { key } = (await put.json()) as { key: string };
    expect(key).toBe(`books/${BOOK_ID}/cover.png`);

    const get = await SELF.fetch(`${API}/api/books/${BOOK_ID}/cover`, { headers: authHeaders });
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/png');
    expect(await get.text()).toBe('fake-png-bytes');
  });
});

describe('chunks & deletes', () => {
  it('serves the chunk plan for a chapter', async () => {
    await seedBook();
    const res = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const { chunks } = (await res.json()) as ChunkListResponse;
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toMatchObject({
      chapterIdx: 0,
      chunkIdx: 0,
      charStart: 0,
      charEnd: 20,
      text: 'First chunk of text.',
      audioKey: null,
    } satisfies Partial<Chunk>);
  });

  it('syncs library changes with a since watermark', async () => {
    await seedBook();
    const full = await getLibrary();
    expect(full.books.length).toBe(1);
    expect(full.serverTime).toBeGreaterThan(0);
    const later = await getLibrary(full.serverTime + 1);
    expect(later.books.length).toBe(0);
  });

  it('propagates soft deletes and purges R2 objects', async () => {
    await seedBook();
    await SELF.fetch(`${API}/api/books/${BOOK_ID}/source`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/epub+zip' },
      body: 'source-bytes',
    });

    const del = await SELF.fetch(`${API}/api/books/${BOOK_ID}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(del.status).toBe(200);

    const library = await getLibrary();
    expect(library.books[0]?.deletedAt).not.toBeNull();

    await until(async () => {
      const listing = await env.BUCKET.list({ prefix: `books/${BOOK_ID}/` });
      return listing.objects.length === 0;
    }, 'R2 purge');

    const get = await SELF.fetch(`${API}/api/books/${BOOK_ID}/source`, { headers: authHeaders });
    expect(get.status).toBe(404);
  });
});

describe('progress & settings', () => {
  it('stores, returns, and upserts reading progress', async () => {
    const put = (chapterIdx: number, charOffset: number): Promise<Response> =>
      SELF.fetch(`${API}/api/progress/${BOOK_ID}`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ chapterIdx, charOffset, chunkIdx: 2, audioPositionMs: 1200 }),
      });
    expect((await put(0, 10)).status).toBe(200);
    expect((await put(0, 99)).status).toBe(200);

    const library = await getLibrary();
    expect(library.progress.length).toBe(1);
    expect(library.progress[0]).toMatchObject({
      bookId: BOOK_ID,
      chapterIdx: 0,
      charOffset: 99,
      chunkIdx: 2,
    } satisfies Partial<Progress>);
  });

  it('defaults and round-trips settings', async () => {
    const initial = (await (
      await SELF.fetch(`${API}/api/settings`, { headers: authHeaders })
    ).json()) as { settings: Record<string, unknown> };
    expect(initial.settings.theme).toBe('light');
    expect(initial.settings.fontSize).toBe(18);

    await SELF.fetch(`${API}/api/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ model: 'test/tts:free', voice: 'narrator', theme: 'dark' }),
    });
    const after = (await (
      await SELF.fetch(`${API}/api/settings`, { headers: authHeaders })
    ).json()) as { settings: Record<string, unknown> };
    expect(after.settings.theme).toBe('dark');
    expect(after.settings.model).toBe('test/tts:free');
  });
});

describe('TTS audio endpoint', () => {
  const AUDIO = new Uint8Array([0xff, 0xf3, 0x40, 0xc4, 0x00, 0x00, 0x00, 0x77]);

  async function configureModel(): Promise<void> {
    await SELF.fetch(`${API}/api/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ model: 'test/tts:free', voice: 'narrator' }),
    });
  }

  async function chunkAudioKey(): Promise<string | null> {
    const row = await env.DB
      .prepare('SELECT audio_key FROM chunks WHERE book_id = ? AND chapter_idx = 0 AND chunk_idx = 0')
      .bind(BOOK_ID)
      .first<{ audio_key: string | null }>();
    return row?.audio_key ?? null;
  }

  it('generates, tees to R2, then serves cache hits without OpenRouter', async () => {
    await seedBook();
    await configureModel();
    mockSpeech(200, AUDIO, { 'Content-Length': String(AUDIO.length) });

    const gen = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    expect(gen.status).toBe(200);
    expect(gen.headers.get('X-Cache')).toBe('miss');
    expect(gen.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(new Uint8Array(await gen.arrayBuffer())).toEqual(AUDIO);
    const callsAfterGen = openRouterCalls;

    // The waitUntil persistence lands after the response.
    await until(async () => (await chunkAudioKey()) !== null, 'chunk row update');
    expect(await chunkAudioKey()).toBe(`books/${BOOK_ID}/audio/0/0.mp3`);

    // Second request is served from R2; no OpenRouter interceptor is pending.
    const hit = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    expect(hit.status).toBe(200);
    expect(hit.headers.get('X-Cache')).toBe('hit');
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(AUDIO);
    expect(openRouterCalls).toBe(callsAfterGen);
  });

  it('persists the audio into R2 at the deterministic key', async () => {
    await seedBook();
    await configureModel();
    mockSpeech(200, AUDIO, { 'Content-Length': String(AUDIO.length) });

    // Drain the response so the tee's client branch does not backpressure the
    // background R2 persistence (a tee stalls when either branch stalls).
    const gen = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    await gen.arrayBuffer();
    await until(() => chunkAudioKey().then((k) => k !== null), 'chunk row update');

    const obj = await env.BUCKET.get(`books/${BOOK_ID}/audio/0/0.mp3`);
    expect(obj).not.toBeNull();
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(AUDIO);
  });

  it('GET returns 404 before generation and 200 after', async () => {
    await seedBook();
    await configureModel();
    const before = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      headers: authHeaders,
    });
    expect(before.status).toBe(404);

    mockSpeech(200, AUDIO, { 'Content-Length': String(AUDIO.length) });
    // Drain the response so the tee's client branch does not backpressure the
    // background R2 persistence (a tee stalls when either branch stalls).
    const gen = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    await gen.arrayBuffer();
    await until(() => chunkAudioKey().then((k) => k !== null), 'chunk row update');

    const after = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      headers: authHeaders,
    });
    expect(after.status).toBe(200);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(AUDIO);
  });

  it('never calls OpenRouter for a chunk with no text', async () => {
    await seedBook();
    // Unknown chunk: 404, no OpenRouter interceptor registered at all.
    const res = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/9/chunks/9/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    expect(res.status).toBe(404);
    assertNoOpenRouterCalls();
  });

  it('passes through upstream rate limits with Retry-After', async () => {
    await seedBook();
    await configureModel();
    mockSpeech(429, '{"error":"rate limited"}', { 'Retry-After': '7' });

    const res = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(await chunkAudioKey()).toBeNull();
  });

  it('maps a vanished model to a clear 502 message', async () => {
    await seedBook();
    await configureModel();
    mockSpeech(404, '{"error":"no such model"}');

    const res = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not available/i);
    expect(body.error).not.toContain('test-openrouter-key');
  });

  it('rejects requests with no model configured', async () => {
    await seedBook();
    const res = await SELF.fetch(`${API}/api/books/${BOOK_ID}/chapters/0/chunks/0/audio`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    expect(res.status).toBe(400);
    assertNoOpenRouterCalls();
  });
});
