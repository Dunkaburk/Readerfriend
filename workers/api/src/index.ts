/**
 * Readerfriend Worker API (SPEC §5).
 *
 * Base path /api. Bearer-token auth everywhere except /api/health. D1 holds
 * the canonical chunk plan; R2 holds source files, covers and generated
 * audio. Audio generation streams through with a tee: one branch to R2,
 * one to the client — never buffered in the Worker (SPEC §13 trap 4).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { DEFAULT_SETTINGS, r2Keys } from '@readerfriend/shared';
import type {
  Book,
  ChapterMeta,
  ChunkPlan,
  CreateBookRequest,
  Progress,
} from '@readerfriend/shared';
import { requireAuth } from './auth';
import type { Env } from './env';
import {
  BOOK_COLUMNS,
  CHUNK_COLUMNS,
  INSERT_BOOK_SQL,
  INSERT_CHAPTER_SQL,
  INSERT_CHUNK_SQL,
  PROGRESS_COLUMNS,
  bookFromRow,
  bookInsertParams,
  type BookInsert,
  chapterFromRow,
  chapterInsertParams,
  chunkFromRow,
  chunkInsertParams,
  progressFromRow,
} from './db';
import { TtsError, fetchTtsModelsCached, requestSpeech } from './tts';

type App = Hono<{ Bindings: Env }>;

const app: App = new Hono<{ Bindings: Env }>();

// CORS must precede auth: preflight OPTIONS has no token. Token auth means no
// cookies, so any origin is safe for this single-user API. The middleware's
// return value must flow through — it returns the 204 preflight response, and
// a discarded return leaves the Context unfinalized (500).
app.use(
  '/api/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-Cache', 'Retry-After'],
    maxAge: 86400,
  }),
);
app.use('/api/*', requireAuth);

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal error' }, 500);
});
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// --- helpers ---

function errJson(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...extra },
  });
}

function parseIdx(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

type BookRow = Parameters<typeof bookFromRow>[0];
type ProgressRow = Parameters<typeof progressFromRow>[0];

async function findBookRow(db: Env['DB'], id: string): Promise<BookRow | null> {
  return db
    .prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`)
    .bind(id)
    .first<BookRow>();
}

const SOURCE_EXTS = new Set(['epub', 'txt']);
const COVER_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp']);

const CT_TO_EXT: Array<[RegExp, string]> = [
  [/^application\/epub\+zip/i, 'epub'],
  [/^text\/plain/i, 'txt'],
  [/^image\/jpe?g/i, 'jpg'],
  [/^image\/png/i, 'png'],
  [/^image\/gif/i, 'gif'],
  [/^image\/svg/i, 'svg'],
  [/^image\/webp/i, 'webp'],
];

/** Ext for an upload: explicit ?ext= wins, else Content-Type. Null if unknown. */
function uploadExt(c: Context<{ Bindings: Env }>): string | null {
  const explicit = c.req.query('ext');
  if (explicit) return explicit.toLowerCase();
  const ct = c.req.header('Content-Type') ?? '';
  for (const [re, ext] of CT_TO_EXT) {
    if (re.test(ct)) return ext;
  }
  return null;
}

// --- routes ---

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/library', async (c) => {
  const since = Number(c.req.query('since') ?? '0');
  if (!Number.isFinite(since) || since < 0) {
    return c.json({ error: 'since must be a non-negative epoch ms' }, 400);
  }
  const [books, progress] = await Promise.all([
    c.env.DB.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE updated_at > ? ORDER BY updated_at ASC`)
      .bind(since)
      .all<BookRow>(),
    c.env.DB.prepare(`SELECT ${PROGRESS_COLUMNS} FROM progress WHERE updated_at > ?`)
      .bind(since)
      .all<ProgressRow>(),
  ]);
  return c.json({
    books: books.results.map(bookFromRow),
    progress: progress.results.map(progressFromRow),
    serverTime: Date.now(),
  });
});

app.post('/api/books', async (c) => {
  let body: CreateBookRequest;
  try {
    body = await c.req.json<CreateBookRequest>();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const invalid = validateCreateBody(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const { book, chapters, chunks } = body;
  const now = Date.now();
  const sourceKey = r2Keys.source(book.id, book.sourceFormat);
  const coverKey = book.coverExt ? r2Keys.cover(book.id, book.coverExt) : null;

  const existing = await c.env.DB.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`)
    .bind(book.id)
    .first<BookRow>();
  if (existing) {
    // Idempotent create. An interrupted retry may have left a partial book
    // behind (multi-batch inserts are not one transaction); rebuild that.
    const [chCount, chunkCount] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?')
        .bind(book.id)
        .first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE book_id = ?')
        .bind(book.id)
        .first<{ n: number }>(),
    ]);
    if (chCount?.n === chapters.length && chunkCount?.n === chunks.length) {
      return c.json({ book: bookFromRow(existing) }, 200);
    }
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM chunks WHERE book_id = ?').bind(book.id),
      c.env.DB.prepare('DELETE FROM chapters WHERE book_id = ?').bind(book.id),
      c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(book.id),
    ]);
  }

  const meta: BookInsert = {
    id: book.id,
    title: book.title,
    author: book.author,
    language: book.language,
    sourceFormat: book.sourceFormat,
    sourceKey,
    coverKey,
    charCount: book.charCount,
    chapterCount: chapters.length,
    addedAt: now,
    updatedAt: now,
  };
  await insertBookData(c.env, meta, chapters, chunks);
  const created: Book = { ...meta, deletedAt: null };
  return c.json({ book: created }, 201);
});

async function insertBookData(
  env: Env,
  meta: BookInsert,
  chapters: ChapterMeta[],
  chunks: ChunkPlan[],
): Promise<void> {
  // D1 batches are transactions per call; statements are capped per batch, so
  // chunk inserts are grouped. A crash mid-way leaves a partial book that the
  // idempotency path above rebuilds on retry.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(INSERT_BOOK_SQL).bind(...bookInsertParams(meta)),
  ];
  for (const ch of chapters) {
    statements.push(env.DB.prepare(INSERT_CHAPTER_SQL).bind(...chapterInsertParams(meta.id, ch)));
  }
  let batch = statements;
  const flush = async (): Promise<void> => {
    if (batch.length > 0) await env.DB.batch(batch);
    batch = [];
  };
  for (const ck of chunks) {
    if (batch.length >= 90) await flush();
    batch.push(env.DB.prepare(INSERT_CHUNK_SQL).bind(...chunkInsertParams(meta.id, ck)));
  }
  await flush();
}

function validateCreateBody(body: CreateBookRequest): string | null {
  if (!body || typeof body !== 'object') return 'Body must be an object';
  const b = body.book;
  if (!b || typeof b !== 'object') return 'book is required';
  if (typeof b.id !== 'string' || b.id.length === 0 || b.id.length > 100) return 'book.id must be a string';
  if (typeof b.title !== 'string' || b.title.length === 0) return 'book.title is required';
  if (b.sourceFormat !== 'epub' && b.sourceFormat !== 'txt') return "book.sourceFormat must be 'epub' or 'txt'";
  if (!Number.isInteger(b.charCount) || b.charCount < 0) return 'book.charCount must be a non-negative integer';
  if (b.coverExt !== null && b.coverExt !== undefined && typeof b.coverExt !== 'string') return 'book.coverExt must be a string or null';
  if (!Array.isArray(body.chapters) || body.chapters.length === 0) return 'chapters must be a non-empty array';
  if (body.chapters.length > 5000) return 'too many chapters';
  if (!Array.isArray(body.chunks) || body.chunks.length === 0) return 'chunks must be a non-empty array';
  if (body.chunks.length > 50_000) return 'too many chunks';
  for (const ch of body.chapters) {
    if (!Number.isInteger(ch.idx) || ch.idx < 0) return 'chapter.idx must be a non-negative integer';
    if (!Number.isInteger(ch.charCount) || ch.charCount < 0) return 'chapter.charCount must be a non-negative integer';
  }
  for (const ck of body.chunks) {
    if (!Number.isInteger(ck.chapterIdx) || ck.chapterIdx < 0) return 'chunk.chapterIdx must be a non-negative integer';
    if (!Number.isInteger(ck.chunkIdx) || ck.chunkIdx < 0) return 'chunk.chunkIdx must be a non-negative integer';
    if (!Number.isInteger(ck.charStart) || !Number.isInteger(ck.charEnd) || ck.charStart < 0 || ck.charEnd < ck.charStart) {
      return 'chunk char offsets must be valid';
    }
    if (typeof ck.text !== 'string' || ck.text.length === 0) return 'chunk.text must be a non-empty string';
    if (ck.text.length > 10_000) return 'chunk.text is too long';
  }
  return null;
}

// --- binary uploads/downloads ---

app.put('/api/books/:id/source', async (c) => {
  return putBookFile(c, 'source');
});

app.put('/api/books/:id/cover', async (c) => {
  return putBookFile(c, 'cover');
});

async function putBookFile(c: Context<{ Bindings: Env }>, kind: 'source' | 'cover'): Promise<Response> {
  // ':id' always matches on this route; Context.param types it as optional.
  const bookId = c.req.param('id') ?? '';
  const row = await findBookRow(c.env.DB, bookId);
  if (!row) return errJson('Book not found', 404);

  const ext = uploadExt(c);
  if (!ext) {
    return errJson(
      `Unknown ${kind} extension: pass ?ext= or a known Content-Type (${kind === 'source' ? 'epub, txt' : 'jpg, png, gif, svg, webp'})`,
      400,
    );
  }
  const allowed = kind === 'source' ? SOURCE_EXTS : COVER_EXTS;
  if (!allowed.has(ext)) return errJson(`Unsupported ${kind} extension "${ext}"`, 400);

  const body = c.req.raw.body;
  if (!body) return errJson('Request body is required', 400);

  const key = kind === 'source' ? r2Keys.source(bookId, ext) : r2Keys.cover(bookId, ext);
  const contentType = c.req.header('Content-Type') ?? 'application/octet-stream';
  try {
    await c.env.BUCKET.put(key, body, { httpMetadata: { contentType } });
  } catch {
    return errJson('Upload failed — request body must have a known length', 400);
  }

  // Keep the row pointing at the actual object (ext may differ from default).
  if (kind === 'source' && row.source_key !== key) {
    await c.env.DB.prepare('UPDATE books SET source_key = ?, updated_at = ? WHERE id = ?')
      .bind(key, Date.now(), bookId)
      .run();
  }
  if (kind === 'cover' && row.cover_key !== key) {
    await c.env.DB.prepare('UPDATE books SET cover_key = ?, updated_at = ? WHERE id = ?')
      .bind(key, Date.now(), bookId)
      .run();
  }

  const bytes = Number(c.req.header('Content-Length'));
  return c.json({ key, bytes: Number.isInteger(bytes) && bytes >= 0 ? bytes : null }, 200);
}

app.get('/api/books/:id/source', async (c) => {
  const row = await findBookRow(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'Book not found' }, 404);
  const obj = await c.env.BUCKET.get(row.source_key);
  if (!obj) return c.json({ error: 'Source file missing from storage' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Length': String(obj.size),
      ETag: obj.httpEtag,
    },
  });
});

app.get('/api/books/:id/cover', async (c) => {
  const row = await findBookRow(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'Book not found' }, 404);
  if (!row.cover_key) return c.json({ error: 'Book has no cover' }, 404);
  const obj = await c.env.BUCKET.get(row.cover_key);
  if (!obj) return c.json({ error: 'Cover missing from storage' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, max-age=86400',
    },
  });
});

app.get('/api/books/:id/chapters/:chapterIdx/chunks', async (c) => {
  const bookId = c.req.param('id');
  const chapterIdx = parseIdx(c.req.param('chapterIdx'));
  if (chapterIdx === null) return c.json({ error: 'chapterIdx must be a non-negative integer' }, 400);
  const row = await findBookRow(c.env.DB, bookId);
  if (!row) return c.json({ error: 'Book not found' }, 404);
  const chunks = await c.env.DB.prepare(
    `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE book_id = ? AND chapter_idx = ? ORDER BY chunk_idx ASC`,
  )
    .bind(bookId, chapterIdx)
    .all<Parameters<typeof chunkFromRow>[0]>();
  return c.json({ chunks: chunks.results.map(chunkFromRow) });
});

app.delete('/api/books/:id', async (c) => {
  const bookId = c.req.param('id');
  const row = await findBookRow(c.env.DB, bookId);
  if (!row) return c.json({ error: 'Book not found' }, 404);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE books SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(now, now, bookId),
    c.env.DB.prepare('DELETE FROM progress WHERE book_id = ?').bind(bookId),
  ]);
  c.executionCtx.waitUntil(purgePrefix(c.env.BUCKET, r2Keys.bookPrefix(bookId)));
  return c.json({ ok: true });
});

async function purgePrefix(bucket: Env['BUCKET'], prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, cursor });
    if (listing.objects.length > 0) {
      await bucket.delete(listing.objects.map((o) => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

// --- audio (TTS) ---

app.post('/api/books/:id/chapters/:chapterIdx/chunks/:chunkIdx/audio', async (c) => {
  const bookId = c.req.param('id');
  const chapterIdx = parseIdx(c.req.param('chapterIdx'));
  const chunkIdx = parseIdx(c.req.param('chunkIdx'));
  if (chapterIdx === null || chunkIdx === null) {
    return c.json({ error: 'chapter and chunk indices must be non-negative integers' }, 400);
  }

  const chunk = await c.env.DB.prepare(
    `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE book_id = ? AND chapter_idx = ? AND chunk_idx = ?`,
  )
    .bind(bookId, chapterIdx, chunkIdx)
    .first<Parameters<typeof chunkFromRow>[0]>();
  if (!chunk) return c.json({ error: 'Chunk not found' }, 404);

  // Cache hit: never call OpenRouter (SPEC §5 step 2).
  if (chunk.audio_key) {
    const obj = await c.env.BUCKET.get(chunk.audio_key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(obj.size),
          'X-Cache': 'hit',
        },
      });
    }
  }

  // Resolve model/voice: request body, then synced settings.
  let body: { model?: unknown; voice?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty or non-JSON body is fine */
  }
  let settings: { model?: unknown; voice?: unknown } = {};
  try {
    const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('app')
      .first<{ value: string }>();
    if (row) settings = JSON.parse(row.value) as { model?: unknown; voice?: unknown };
  } catch {
    /* unparseable settings — treat as unset */
  }
  const model = typeof body.model === 'string' && body.model ? body.model : typeof settings.model === 'string' ? settings.model : null;
  const voice = typeof body.voice === 'string' && body.voice ? body.voice : typeof settings.voice === 'string' ? settings.voice : null;
  // Voice stays optional: models with a default voice are called without it,
  // and models that demand one surface a clear upstream error instead.
  if (!model) {
    return c.json({ error: 'No TTS model configured — pick one in Settings' }, 400);
  }

  let upstream: Response;
  try {
    upstream = await requestSpeech(c.env.OPENROUTER_API_KEY, { model, voice, input: chunk.text });
  } catch (err) {
    if (err instanceof TtsError) {
      const extra: Record<string, string> = {};
      if (err.retryAfter) extra['Retry-After'] = err.retryAfter;
      return errJson(err.message, err.status, extra);
    }
    throw err;
  }
  if (!upstream.body) {
    return errJson('OpenRouter returned an empty audio body', 502);
  }

  const key = r2Keys.audio(bookId, chapterIdx, chunkIdx);
  const contentLength = Number(upstream.headers.get('content-length'));
  const bytes = Number.isInteger(contentLength) && contentLength > 0 ? contentLength : null;
  const [toR2, toClient] = upstream.body.tee();

  // Persist in the background so the client stream starts immediately. If the
  // upload fails the row stays ungenerated and the next request regenerates.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        if (Number.isInteger(contentLength) && contentLength > 0) {
          // R2 needs a known-length body; FixedLengthStream provides one for a
          // tee branch (whose length is not directly visible).
          const fixed = new FixedLengthStream(contentLength);
          const putPromise = c.env.BUCKET.put(key, fixed.readable, {
            httpMetadata: { contentType: 'audio/mpeg' },
          });
          // workerd does not implement pipeTo() between TransformStreams
          // (tee branches are inter-transform streams), so pump by hand.
          const reader = toR2.getReader();
          const writer = fixed.writable.getWriter();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);
            }
            await writer.close();
          } finally {
            reader.releaseLock();
            writer.releaseLock();
          }
          await putPromise;
        } else {
          // R2 also needs a known length for stream bodies, and upstream
          // omitted Content-Length — buffer this one chunk's bytes instead.
          const data = await new Response(toR2).arrayBuffer();
          await c.env.BUCKET.put(key, data, { httpMetadata: { contentType: 'audio/mpeg' } });
        }
        await c.env.DB.prepare(
          'UPDATE chunks SET audio_key = ?, voice = ?, model = ?, bytes = ?, created_at = ? WHERE book_id = ? AND chapter_idx = ? AND chunk_idx = ?',
        )
          .bind(key, voice, model, bytes, Date.now(), bookId, chapterIdx, chunkIdx)
          .run();
      } catch (err) {
        console.error('Audio persistence failed (will regenerate on next request):', err);
      }
    })(),
  );

  const headers = new Headers({ 'Content-Type': 'audio/mpeg', 'X-Cache': 'miss' });
  if (bytes !== null) headers.set('Content-Length', String(bytes));
  return new Response(toClient, { headers });
});

app.get('/api/books/:id/chapters/:chapterIdx/chunks/:chunkIdx/audio', async (c) => {
  const bookId = c.req.param('id');
  const chapterIdx = parseIdx(c.req.param('chapterIdx'));
  const chunkIdx = parseIdx(c.req.param('chunkIdx'));
  if (chapterIdx === null || chunkIdx === null) {
    return c.json({ error: 'chapter and chunk indices must be non-negative integers' }, 400);
  }
  const chunk = await c.env.DB.prepare('SELECT audio_key FROM chunks WHERE book_id = ? AND chapter_idx = ? AND chunk_idx = ?')
    .bind(bookId, chapterIdx, chunkIdx)
    .first<{ audio_key: string | null }>();
  if (!chunk?.audio_key) return c.json({ error: 'Audio not generated yet' }, 404);
  const obj = await c.env.BUCKET.get(chunk.audio_key);
  if (!obj) return c.json({ error: 'Audio missing from storage' }, 404);
  return new Response(obj.body, {
    headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(obj.size) },
  });
});

// --- progress & settings ---

app.put('/api/progress/:bookId', async (c) => {
  let body: { chapterIdx?: unknown; charOffset?: unknown; chunkIdx?: unknown; audioPositionMs?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  if (!Number.isInteger(body.chapterIdx) || (body.chapterIdx as number) < 0) {
    return c.json({ error: 'chapterIdx must be a non-negative integer' }, 400);
  }
  if (!Number.isInteger(body.charOffset) || (body.charOffset as number) < 0) {
    return c.json({ error: 'charOffset must be a non-negative integer' }, 400);
  }
  if (body.chunkIdx !== null && !Number.isInteger(body.chunkIdx)) {
    return c.json({ error: 'chunkIdx must be an integer or null' }, 400);
  }
  if (body.audioPositionMs !== null && !Number.isInteger(body.audioPositionMs)) {
    return c.json({ error: 'audioPositionMs must be an integer or null' }, 400);
  }
  const bookId = c.req.param('bookId');
  const now = Date.now();
  const params: unknown[] = [
    bookId,
    body.chapterIdx,
    body.charOffset,
    body.chunkIdx ?? null,
    body.audioPositionMs ?? null,
    now,
  ];
  await c.env.DB.prepare(
    `INSERT INTO progress (book_id, chapter_idx, char_offset, chunk_idx, audio_position_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (book_id) DO UPDATE SET
       chapter_idx = excluded.chapter_idx,
       char_offset = excluded.char_offset,
       chunk_idx = excluded.chunk_idx,
       audio_position_ms = excluded.audio_position_ms,
       updated_at = excluded.updated_at`,
  )
    .bind(...params)
    .run();
  const progress: Progress = {
    bookId,
    chapterIdx: body.chapterIdx as number,
    charOffset: body.charOffset as number,
    chunkIdx: (body.chunkIdx as number | null) ?? null,
    audioPositionMs: (body.audioPositionMs as number | null) ?? null,
    updatedAt: now,
  };
  return c.json({ progress });
});

app.get('/api/settings', async (c) => {
  const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind('app')
    .first<{ value: string }>();
  let stored: Record<string, unknown> = {};
  if (row) {
    try {
      stored = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      stored = {};
    }
  }
  return c.json({ settings: { ...DEFAULT_SETTINGS, ...stored } });
});

app.put('/api/settings', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Body must be a JSON object' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Body must be a JSON object' }, 400);
  }
  await c.env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  )
    .bind('app', JSON.stringify(body))
    .run();
  return c.json({ settings: { ...DEFAULT_SETTINGS, ...body } });
});

// --- TTS models ---

app.get('/api/tts/models', async (c) => {
  try {
    const models = await fetchTtsModelsCached(c.env.OPENROUTER_API_KEY);
    return c.json({ models });
  } catch (err) {
    if (err instanceof TtsError) {
      const extra: Record<string, string> = {};
      if (err.retryAfter) extra['Retry-After'] = err.retryAfter;
      return errJson(err.message, err.status, extra);
    }
    throw err;
  }
});

export default app;
