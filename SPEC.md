# Readerfriend — build specification

This document is the complete brief for building a personal ebook reader with AI-generated
audiobook narration. You are starting from an empty repository. Read the whole document before
writing code.

---

## 1. What we are building

A personal library application for reading and listening to books.

The user imports a book as an `.epub` or `.txt` file. It appears in their library. Tapping a book
opens a conventional reading interface — paginated or scrolling text, adjustable typography,
chapter navigation, saved reading position. The reader also has an **Audiobook** button. Pressing
it generates spoken narration for the current chapter using a text-to-speech model accessed
through OpenRouter, then plays it back.

While audio plays, the corresponding passage is highlighted in the text, so the user can read
along, listen with the screen off, or switch between the two without losing their place.

The library, reading position, and generated audio all sync between an Android phone and a web
browser.

### Who this is for

One person — the repository owner. There is no sign-up flow, no multi-tenancy, no user table, no
sharing. Authentication exists solely to stop strangers from spending the owner's API quota.

### The one hard constraint

**Recurring cost must be zero.** Every service used must have a permanent free tier that does not
expire, does not require a credit card on file for the free usage, and does not sleep the project
after inactivity. The only accepted spend is a one-time $10 OpenRouter credit purchase, which the
owner has already committed to. Do not introduce any service that bills monthly. If you believe a
paid service is genuinely necessary, stop and say so rather than adding it.

### Explicit non-goals

- Publishing to the Play Store or any app store.
- Supporting more than one user.
- PDF, MOBI, AZW, or DRM-protected books.
- Word-level audio/text alignment (see §9.4 — we do a cheaper approximation).
- Real-time streaming TTS. Generation is a background job, not a live stream.
- Server-side EPUB rendering.

---

## 2. Architecture

```
  Android app  ──┐                   ┌── D1        (metadata, chunk plan, progress)
  (Capacitor)    ├──►  Worker API  ──┤
  Web app      ──┘     (Hono)        ├── R2        (source files, generated audio)
  (Cloudflare Pages)                 │
                                     └── OpenRouter (TTS generation)
```

**One client codebase, two delivery targets.** The web app is a normal Vite + React SPA. The
Android app is that exact same build wrapped in Capacitor. There is no second UI implementation and
no React Native. Platform differences are isolated behind small adapter interfaces (§6.3).

**The Worker is thin.** It does four things: check the auth token, read and write D1, read and
write R2, and proxy TTS requests to OpenRouter so the API key never touches a client. It contains
no EPUB parsing, no rendering, no business logic beyond that.

**The client orchestrates generation.** There is no server-side job queue. When the user wants
audio for a chapter, the client walks that chapter's chunk list and requests them one at a time,
respecting rate limits. This avoids needing durable background jobs on the free tier entirely.

### Chosen services and why

| Concern | Service | Free tier |
|---|---|---|
| API compute | Cloudflare Workers | 100K requests/day, 10ms CPU per invocation |
| Database | Cloudflare D1 | 5 GB storage, 5M row reads/day, 100K row writes/day |
| Object storage | Cloudflare R2 | 10 GB-month, 1M Class A ops/mo, 10M Class B ops/mo, **zero egress fees** |
| Web hosting | Cloudflare Pages | 500 builds/month |
| TTS | OpenRouter | Free `:free` models, 20 req/min, 1000 req/day with $10 lifetime credit |

Zero egress on R2 is the reason for this stack over the alternatives — we are moving hundreds of
megabytes of audio to a phone. Supabase was considered and rejected: its free tier pauses projects
after inactivity and offers far less file storage.

### Chosen libraries

Verify current versions at implementation time; do not pin to what you remember.

- **React 18+ / TypeScript / Vite** — client.
- **Tailwind CSS** — styling.
- **Zustand** — client state. Do not reach for Redux.
- **React Router** — navigation.
- **Hono** — Worker framework. Small, first-class Cloudflare support.
- **JSZip** — EPUB extraction.
- **DOMPurify** — sanitising chapter HTML before rendering.
- **Dexie** — IndexedDB wrapper for the browser blob store.
- **Capacitor 6+** — Android wrapper.
- **Wrangler** — Worker/D1/R2 tooling.

Do **not** use `epub.js`. It renders into an iframe, which makes the read-along highlighting in §9.4
impractical. We parse EPUBs ourselves — the format is a ZIP with an XML manifest, and the subset we
need is small.

---

## 3. Repository layout

pnpm workspaces monorepo.

```
/
├── apps/
│   └── web/                 Vite + React client. Also the Capacitor source.
│       ├── src/
│       ├── android/         Generated by `npx cap add android`. Committed.
│       ├── capacitor.config.ts
│       └── vite.config.ts
├── workers/
│   └── api/                 Cloudflare Worker (Hono)
│       ├── src/
│       ├── migrations/      D1 SQL migrations
│       └── wrangler.toml
├── packages/
│   └── shared/              Types + pure logic shared by client and worker
│       └── src/
│           ├── types.ts
│           ├── chunking.ts
│           └── epub/
├── README.md
└── pnpm-workspace.yaml
```

Capacitor lives inside `apps/web` rather than a separate app package. Fewer moving parts, and the
Android project needs the web build output anyway.

`packages/shared` must be dependency-light and must not import anything browser- or Worker-specific,
since both sides consume it.

---

## 4. Data model

### 4.1 D1 schema

Write this as a numbered migration in `workers/api/migrations/`.

```sql
CREATE TABLE books (
  id            TEXT PRIMARY KEY,          -- uuid v4, generated client-side
  title         TEXT NOT NULL,
  author        TEXT,
  language      TEXT,                       -- BCP-47 if the EPUB declares one
  source_format TEXT NOT NULL,              -- 'epub' | 'txt'
  source_key    TEXT NOT NULL,              -- R2 key of the original file
  cover_key     TEXT,                       -- R2 key of extracted cover image
  char_count    INTEGER NOT NULL,
  chapter_count INTEGER NOT NULL,
  added_at      INTEGER NOT NULL,           -- epoch ms
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER                     -- soft delete, so sync can propagate removals
);

CREATE TABLE chapters (
  book_id     TEXT NOT NULL,
  idx         INTEGER NOT NULL,             -- 0-based position in spine order
  title       TEXT,
  href        TEXT,                         -- path inside the EPUB, for debugging
  char_count  INTEGER NOT NULL,
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE chunks (
  book_id     TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL,
  chunk_idx   INTEGER NOT NULL,             -- 0-based within the chapter
  char_start  INTEGER NOT NULL,             -- offset into chapter normalized plain text
  char_end    INTEGER NOT NULL,             -- exclusive
  text        TEXT NOT NULL,                -- exact string sent to the TTS model
  audio_key   TEXT,                         -- R2 key, NULL until generated
  voice       TEXT,
  model       TEXT,
  duration_ms INTEGER,
  bytes       INTEGER,
  created_at  INTEGER,
  PRIMARY KEY (book_id, chapter_idx, chunk_idx)
);

CREATE TABLE progress (
  book_id           TEXT PRIMARY KEY,
  chapter_idx       INTEGER NOT NULL,
  char_offset       INTEGER NOT NULL,        -- into chapter plain text
  chunk_idx         INTEGER,                 -- last chunk played, if listening
  audio_position_ms INTEGER,                 -- position within that chunk
  updated_at        INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                        -- JSON
);

CREATE INDEX idx_chunks_pending ON chunks (book_id, chapter_idx) WHERE audio_key IS NULL;
```

Storage sanity check: a 100,000-word novel is roughly 550 KB of text. Forty books is ~22 MB in the
`chunks.text` column — trivially within D1's 5 GB. Chunk rows are ~275 per book, far under the
100K/day write limit.

### 4.2 R2 key layout

```
books/{bookId}/source.epub          original uploaded file
books/{bookId}/cover.{ext}          extracted cover image
books/{bookId}/audio/{chapterIdx}/{chunkIdx}.mp3
```

Audio keys are deterministic. Anything can reconstruct a key from the chunk's coordinates without
a lookup.

### 4.3 Why the chunk plan lives in the database

This is the single most important design decision in the project. Read it carefully.

Audio files are addressed by `(bookId, chapterIdx, chunkIdx)`. If two devices independently
computed different chunk boundaries for the same book, their chunk indices would refer to different
text, and the phone would play the wrong audio for what the browser highlights.

Therefore the chunk plan is computed **exactly once**, at import time, on the importing device, and
written to D1 as the canonical record. Every other device reads it. No device ever recomputes it.
This also means the chunking algorithm can be changed later without invalidating existing books.

The consequence for the reader: chunks store `char_start`/`char_end` as offsets into the chapter's
**normalized plain text**, not into HTML. At render time the client builds a mapping from those
plain-text offsets back to DOM ranges (§9.4). Plain-text normalization must therefore be
deterministic — same input EPUB, same output string, always. Specify it precisely and test it.

---

## 5. Worker API

Base path `/api`. All routes require `Authorization: Bearer <token>` except `/api/health`.

### Auth

A single shared secret, set via `wrangler secret put APP_TOKEN`. The Worker compares the bearer
token against it using a constant-time comparison. The client stores the token after the user pastes
it once on first launch. That is the entire auth system.

Do not build OAuth, magic links, or a user table.

### Endpoints

```
GET    /api/health
         → 200 { ok: true }

GET    /api/library?since=<epoch_ms>
         → 200 { books: Book[], progress: Progress[], serverTime: number }
         Returns books changed since the timestamp, including soft-deleted ones.
         Omit `since` for a full sync.

POST   /api/books
         Body: { book: BookMeta, chapters: ChapterMeta[], chunks: ChunkPlan[] }
         Creates a book and its full chunk plan in one transaction.
         → 201 { book: Book }
         Idempotent on book id: a repeat call with the same id returns 200 and changes nothing.

PUT    /api/books/:id/source
         Raw body: the original file bytes. Content-Type from the client.
         Worker streams it to R2 at books/{id}/source.epub.
         → 200 { key: string, bytes: number }

PUT    /api/books/:id/cover
         Same shape as above, for the cover image.

GET    /api/books/:id/source
         → 200 with the file bytes, or 302 to a signed R2 URL. Streamed, not buffered.

GET    /api/books/:id/chapters/:idx/chunks
         → 200 { chunks: Chunk[] }   (includes text and audio_key)

DELETE /api/books/:id
         Soft delete. Sets deleted_at, deletes R2 objects under books/{id}/.
         → 200 { ok: true }

POST   /api/books/:id/chapters/:chapterIdx/chunks/:chunkIdx/audio
         Body: { voice?: string, model?: string }
         The core TTS endpoint. Behaviour:
           1. Look up the chunk in D1. 404 if absent.
           2. If audio_key is set and the object exists in R2, return the audio immediately
              with `X-Cache: hit`. Do not call OpenRouter.
           3. Otherwise call OpenRouter TTS with the chunk's stored text.
           4. Tee the response stream: one branch to R2, one branch to the client.
           5. Update the chunk row with audio_key, voice, model, bytes.
           6. Return audio/mpeg with `X-Cache: miss`.
         → 200 audio/mpeg
         → 429 if OpenRouter rate-limits, with Retry-After passed through when present.

GET    /api/books/:id/chapters/:chapterIdx/chunks/:chunkIdx/audio
         Fetch already-generated audio only. 404 if not yet generated.
         Never calls OpenRouter. Used by a second device to pull audio the first device made.

PUT    /api/progress/:bookId
         Body: Progress (without updated_at)
         Last-write-wins on updated_at. Single user, so no conflict resolution beyond that.
         → 200 { progress: Progress }

GET    /api/settings  /  PUT /api/settings
         Synced app settings (voice, model, theme, font size).
```

### OpenRouter integration

OpenRouter exposes TTS at `POST https://openrouter.ai/api/v1/audio/speech`. It is compatible with
the OpenAI audio-speech API and returns **raw audio bytes**, not JSON.

```ts
const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,           // e.g. a Fish Audio S2.1 Pro free variant — resolve the exact slug at build time
    input: chunk.text,
    voice,           // required by most providers; omitting it is rejected unless the
                     // provider declares a default
    response_format: "mp3",
  }),
});
```

**Do not hardcode a model slug from memory.** Fetch `https://openrouter.ai/api/v1/models`, filter
for models whose output modalities include speech, and surface the list in the settings UI. Free
models rotate in and out without notice, so the app must degrade gracefully when the configured
model disappears. Default to a `:free` variant; make the choice user-configurable and persisted in
`settings`.

Voice IDs are model-specific. Read them from the models API rather than hardcoding.

---

## 6. Client architecture

### 6.1 Screens

**Library** — grid of cover thumbnails with title and author. Progress indicator per book. An
import button. Long-press or overflow menu for delete. Empty state that explains how to import.

**Reader** — the chapter text, a top bar (back, chapter title, table of contents, settings), and a
bottom bar with the Audiobook button. Tap the centre of the screen to toggle chrome visibility.

**Player** — a bar that slides up from the bottom when audio is active: play/pause, skip back/forward
by chunk, 15-second seek, speed control, chapter position. Expandable to a full-screen player with
cover art.

**Settings** — voice and model selection, playback speed, theme (light/sepia/dark), font family,
font size, line height, margin width, sync status, storage usage, and a "clear cached audio" action.

### 6.2 Import pipeline

Triggered by a file picker (web: `<input type="file">`; Android: Capacitor Filesystem/FilePicker).

1. Read the file into memory.
2. **Parse** (§8). Produces: metadata, cover image, ordered chapter list, and per-chapter
   normalized plain text.
3. **Chunk** (§9.1). Produces the chunk plan.
4. Generate a UUID for the book.
5. `POST /api/books` with metadata, chapters, and chunk plan.
6. `PUT /api/books/:id/source` and `/cover`.
7. Write the source file and cover into the local blob store so the book is readable offline
   immediately.
8. Navigate to the library, which now shows the book.

Import must show progress and must not block the UI thread. Parse and chunk in a Web Worker.

If steps 5–6 fail (offline), queue the book locally and retry on next connection. Local-first: the
book is usable before it has synced.

### 6.3 Platform adapters

Two interfaces, two implementations each. Everything else in the app is platform-agnostic.

```ts
interface BlobStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  usage(): Promise<{ bytes: number; count: number }>;
}
```
- Web: IndexedDB via Dexie. Request persistent storage with `navigator.storage.persist()` so the
  browser does not evict hundreds of megabytes of audio.
- Android: Capacitor Filesystem, `Directory.Data`, files not backed up to cloud.

```ts
interface AudioPlayer {
  loadQueue(items: { url: string; durationMs?: number }[], startIndex: number): void;
  play(): void;  pause(): void;  seek(ms: number): void;
  setRate(rate: number): void;
  on(event: "position" | "chunkChange" | "ended" | "error", cb: Fn): void;
}
```
- Web: two `HTMLAudioElement`s ping-ponging for near-gapless playback of consecutive chunks,
  plus the MediaSession API for OS media controls and lock-screen metadata.
- Android: same, but background playback needs a foreground service or the WebView will suspend
  audio when the screen locks. **Research the current Capacitor plugin landscape at implementation
  time** — recommendations here go stale fast. Verify against a real device that audio survives
  screen-off and app-backgrounded before calling this milestone done.

### 6.4 Sync

Simple, because there is one user.

- On app open and on regaining connectivity: `GET /api/library?since=<lastSyncMs>`, merge into
  local state, store `serverTime` as the new watermark.
- Reading progress: debounce local changes by ~5 seconds, then `PUT /api/progress/:bookId`.
  Last-write-wins on `updated_at`. If two devices disagree, the newer timestamp wins silently. Do
  not build a conflict UI.
- Audio: never synced eagerly. When the reader opens a chapter, check the local blob store first;
  on a miss, check `chunks.audio_key`; if set, `GET` the audio and cache it locally; if null, the
  chunk is ungenerated.
- Soft deletes propagate via `deleted_at`; clients remove local copies when they see it.

---

## 7. Offline behaviour

The app must be fully usable on a plane.

- Any book whose source file is in the local blob store is readable offline.
- Any chunk whose audio is in the local blob store is playable offline.
- Progress updates queue and flush on reconnect.
- Import works offline and queues the upload.
- The only thing that requires connectivity is generating *new* audio.

Register a service worker for the web build so the app shell loads offline. Make sure it does not
try to cache audio blobs — those live in IndexedDB, not the HTTP cache.

---

## 8. EPUB parsing

Implement in `packages/shared/src/epub/`. Pure functions over a `Uint8Array`.

1. Unzip with JSZip.
2. Read `META-INF/container.xml` → find the OPF path.
3. Parse the OPF:
   - `<metadata>` → title (`dc:title`), author (`dc:creator`), language (`dc:language`).
   - `<manifest>` → id → href/media-type map.
   - `<spine>` → ordered list of manifest ids. This defines chapter order.
   - Cover: the manifest item with `properties="cover-image"`, or the `<meta name="cover">`
     pointer, or the first image in the first spine document as a fallback.
4. Table of contents: prefer the EPUB 3 nav document (`properties="nav"`); fall back to the EPUB 2
   NCX. Use it for chapter titles. If neither yields a title, fall back to the first `<h1>`–`<h3>`
   in the document, then to "Chapter N".
5. For each spine document, extract:
   - **Rendered HTML**: sanitize with DOMPurify (allow structural tags, `<img>`, `<a>`, and inline
     formatting; strip scripts and event handlers). Rewrite `src` and `href` attributes that point
     to zip-internal resources into blob URLs created from the zip entries. Rewrite internal
     anchor links into in-app navigation.
   - **Normalized plain text**: the text the TTS model receives and the offsets are measured
     against. This must be deterministic. Define it as: concatenate the text content of block-level
     elements in document order, collapse each run of whitespace to a single space, trim each
     block, join blocks with `\n\n`, drop blocks that are empty after trimming. Exclude `<sup>`
     footnote markers, `<figcaption>`, and any element with `epub:type="pagebreak"` or
     `epub:type="noteref"`. Write unit tests that pin this behaviour.

Handle the messy real-world cases: missing `dc:creator`, spine items with `linear="no"`, EPUBs
where the OPF is not at the root, XHTML with namespaces, and files that are actually ZIP archives
with a `.epub` extension but no `container.xml` (reject with a clear error).

For `.txt` input: treat the whole file as one book. Split into chapters on lines matching a
conservative heading pattern (e.g. `^\s*(chapter|part|book)\s+[ivxlcdm\d]`, case-insensitive) or on
runs of three or more blank lines; if nothing matches, produce a single chapter. Normalization is
the same collapse-whitespace rule.

---

## 9. The audiobook pipeline

### 9.1 Chunking

This is where the rate limits bite, so the sizing is deliberate.

OpenRouter's free tier allows **20 requests per minute** always, and **1000 requests per day** once
$10 in lifetime credits has been purchased. A 100,000-word novel is ~550,000 characters.

- One request per sentence: ~5,000 requests. Impossible.
- One request per paragraph: ~2,000 requests. Still over the daily cap for a single book.
- **~2,000 characters per chunk: ~275 requests per book.** About 3.5 books per day, and ~14 minutes
  of wall-clock time per book at the per-minute ceiling. This is the target.

Algorithm:

```
target = 2000 chars, hard max = 4000 chars

For each chapter's normalized plain text:
  Split into paragraphs on "\n\n".
  Accumulate paragraphs into a chunk until adding the next would exceed `target`.
  If a single paragraph exceeds `hard max`, split it at sentence boundaries using
    Intl.Segmenter(lang, { granularity: "sentence" }).
  If a single sentence still exceeds `hard max` (rare, malformed input), split on
    the nearest whitespace before the limit.
  Never split mid-word. Never split mid-sentence unless forced by the rule above.
  Record char_start and char_end as offsets into the chapter's plain text.
```

`Intl.Segmenter` is available in modern browsers and Android WebView — use it rather than a regex or
an NLP dependency. Keep a crude regex fallback for environments that lack it.

Make `target` a constant in `packages/shared/src/chunking.ts` with a comment explaining the
arithmetic above, so a future reader understands why it is not 500 or 10,000.

### 9.2 Generation

Triggered by the Audiobook button, or automatically as a pre-fetch.

A `GenerationQueue` singleton on the client:

- Works on one chunk at a time, in order.
- Rate limits itself to **well under** 20 requests/minute — use 12/minute (one every 5 seconds) to
  leave headroom for the other device.
- On `429`, honours `Retry-After` if present, otherwise backs off exponentially starting at 30
  seconds, up to 5 minutes.
- Persists its state so a queue survives an app restart.
- Surfaces progress in the UI: "Generating chapter 3 — 14 of 47 chunks."
- Is cancellable.
- Tracks a rough daily request count in local storage and warns the user when approaching 1000.

**Prefetch policy:** when playback starts, generate the current chunk first, then continue
generating ahead of the playhead, staying at least 5 chunks (~10 minutes of audio) in front of it.
Do not generate the whole book up front — it wastes quota on chapters the user may never reach.

Offer a "generate whole chapter" and "generate whole book" action in the UI for users who want to
prepare for an offline trip, with a clear warning about the time it will take.

### 9.3 Playback

- The queue is the chapter's chunk list, in order.
- Chunk audio comes from the local blob store if present, otherwise from the API, and is written to
  the blob store on arrival.
- Ping-pong two audio elements: while chunk *n* plays, chunk *n+1* is preloaded into the other
  element. Swap on `ended`.
- Wire up MediaSession: title, author, cover art, play/pause/next/previous/seek handlers.
- Playback rate control: 0.75× to 2.0× in 0.25 steps. `HTMLAudioElement.preservesPitch` should be
  true.
- Persist position every few seconds into `progress`.
- Handle the "chunk not yet generated" case gracefully: pause, show a spinner with generation
  progress, resume automatically when the chunk arrives.

### 9.4 Read-along highlighting

The TTS endpoint returns audio bytes with **no word timings**. Word-level alignment would require a
forced-alignment pass and is out of scope. We do the following instead.

**Baseline — chunk-level highlighting.** Since chunks store `char_start`/`char_end` into the
chapter plain text, and the reader renders that same chapter, we can map offsets to DOM ranges:

1. After rendering a chapter, walk the DOM with a `TreeWalker` over text nodes, accumulating a
   running plain-text offset using the *same* normalization rules as §8. Build an array of
   `{ node, domStart, domEnd, textStart, textEnd }`.
2. Given a chunk's `char_start`/`char_end`, binary-search that array to produce a DOM `Range`.
3. Wrap or highlight the range using CSS Custom Highlight API where available, falling back to
   injected `<span>` wrappers.
4. Scroll it into view if it is off-screen and the user has not manually scrolled recently.

Test that the offset mapping round-trips exactly. If plain-text extraction and DOM traversal ever
disagree, highlighting drifts progressively through the chapter — the bug will look like "it works
at the start and gets worse."

**Enhancement — interpolated sentence highlighting.** Once chunk-level works, refine it. A chunk is
a few sentences; we know its total audio duration and each sentence's character offsets within it.
Assume speech rate is roughly constant and interpolate:

```
sentenceStartMs ≈ chunkDurationMs * (sentenceCharStart / chunkCharLength)
```

Highlight the sentence whose interpolated window contains the current playback position. This is an
approximation and will drift within a chunk when a sentence contains numerals, abbreviations, or
long pauses. Because chunks are only ~2,000 characters, drift stays bounded and resets at every
chunk boundary. It looks convincing and costs nothing.

Ship the baseline first. Put the interpolation behind a setting so it can be turned off if it feels
wrong.

**Tap-to-play.** Tapping any paragraph should start audio from the chunk containing it. This falls
out of the same offset mapping and is the feature that makes read-along feel good — do not skip it.

---

## 10. Design direction

Reading apps live or die on typography. This should not look like a dashboard.

- **Text is the interface.** Chrome recedes; the page is mostly book. Hide the top and bottom bars
  while reading and reveal on tap.
- **Typography:** a real serif for body text (Literata, Source Serif, or Charter — bundle the font,
  do not depend on a CDN at read time). Default 18px, line height 1.6, measure capped around 70
  characters. Font size, line height, and margin width are all user-adjustable and persisted.
- **Three themes:** light (near-white, not pure white), sepia, and dark (dark grey, not black —
  pure black on OLED causes smearing during scroll). Follow the system preference by default.
- **Restraint in colour.** One accent, used for the highlight and for interactive affordances.
  Nothing else is coloured.
- **Highlight styling:** a soft background tint, not a hard border or a colour inversion. It should
  be legible for minutes at a time without fatiguing.
- **Motion:** transitions under 200ms. No spring physics, no page-curl animation.
- **Touch targets** at least 44px. The player controls will be used one-handed in the dark.

---

## 11. Build order

Each milestone should end with the app in a working, committable state. Do not build ahead.

### M0 — Scaffold
pnpm workspace, three packages, TypeScript config, ESLint/Prettier, Vite dev server running, Hono
Worker running under `wrangler dev`, D1 database created with the migration applied, R2 bucket
created. `GET /api/health` returns 200 from a deployed Worker.

*Done when:* both dev servers start, `wrangler deploy` succeeds, and the health check answers.

### M1 — Local-only reader
No server involvement at all. Import an EPUB from disk, parse it, store it in IndexedDB, list it in
a library, open it, read it with working chapter navigation, typography settings, themes, and a
persisted reading position.

*Done when:* three structurally different real EPUBs (grab public-domain ones from Standard Ebooks —
they are well-formed — plus at least one messier file from Project Gutenberg) import and read
correctly, and closing and reopening the app returns to the exact reading position.

### M2 — Sync
Add the Worker, D1 schema, R2 upload/download, bearer auth, and the library/progress sync. Books
imported on one device appear on the other.

*Done when:* a book imported in the browser appears in the browser on another machine (or an
incognito window with the token pasted) with correct metadata and cover, and reading progress
propagates in both directions.

### M3 — TTS generation
Model/voice discovery from the OpenRouter models API, the settings UI for choosing them, the TTS
proxy endpoint with R2 caching, the client generation queue with rate limiting, and the generation
progress UI.

*Done when:* pressing Audiobook on a chapter generates all its audio, a second press returns
instantly from cache without hitting OpenRouter (verify via `X-Cache`), and a rate-limit response is
handled without losing queue state.

### M4 — Playback and read-along
Audio queue, ping-pong playback, MediaSession, player UI, speed control, chunk-level highlighting,
tap-to-play. Then interpolated sentence highlighting.

*Done when:* a full chapter plays end to end without audible gaps at chunk boundaries, the
highlight tracks correctly from the first paragraph to the last (no drift), and tapping a paragraph
jumps audio to the right place.

### M5 — Android
Capacitor init, Android platform, file picker, Filesystem blob store, background audio, media
notification, release APK signed with a local keystore.

*Done when:* the APK installs on a real device, plays audio with the screen locked for at least ten
minutes, shows correct media notification controls, and syncs with the web app.

### M6 — Polish
Service worker and offline shell, storage usage display and cache eviction, bulk generation with
warnings, daily quota tracking, error states, empty states, and a README covering setup from
scratch.

---

## 12. Configuration

`workers/api/wrangler.toml`:

```toml
name = "readerfriend-api"
main = "src/index.ts"
compatibility_date = "2024-09-23"   # set to today's date at scaffold time

[[d1_databases]]
binding = "DB"
database_name = "readerfriend"
database_id = "..."

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "readerfriend-media"
```

Secrets, set with `wrangler secret put`:
- `OPENROUTER_API_KEY`
- `APP_TOKEN` — the shared bearer token

Client env (`apps/web/.env`):
- `VITE_API_BASE` — Worker URL

Commit a `.env.example`. Never commit real values. The README must document generating a token
(`openssl rand -hex 32`), setting the secrets, and applying migrations.

---

## 13. Traps

Things that will cost hours if discovered late.

1. **Chunk boundaries must never be recomputed.** §4.3. If you find yourself calling the chunking
   function anywhere other than import, stop.
2. **Plain-text normalization is load-bearing.** The same function must be used for chunking and
   for the DOM offset map. Extract it into one place and unit-test it against fixture EPUBs.
3. **Never put the OpenRouter key in the client.** It only exists as a Worker secret. Do not proxy
   it, log it, or return it in an error message.
4. **Worker CPU limit is 10ms on the free tier.** That is CPU time, not wall time — awaiting a
   `fetch` is free. But do not buffer audio into memory or transform it in the Worker. Stream it:
   use `response.body.tee()` to send one branch to R2 and one to the client.
5. **Browsers evict IndexedDB.** Call `navigator.storage.persist()` on first import and tell the
   user if it is denied.
6. **Free models rotate out without notice.** The configured model may 404 tomorrow. Handle it with
   a clear message and a prompt to pick a new one, not a crash.
7. **Voice is usually required.** Omitting it is rejected unless the provider declares a default
   voice. Always send one.
8. **The TTS endpoint returns bytes, not JSON.** Do not call `.json()` on the response.
9. **Android background audio does not work by default.** A WebView audio element suspends when the
   app is backgrounded. This needs a foreground service. Budget real time for M5 and test on
   hardware, not an emulator.
10. **Cloudflare's free-plan terms discourage serving large media through the CDN.** At personal
    scale this is a non-issue, but do not build anything that would attract traffic.
11. **Blob URLs from JSZip leak.** Revoke them when a chapter unmounts, or memory climbs steadily
    through a long reading session.
12. **Do not add a monthly-billed dependency.** If a task seems to need one, raise it instead.

---

## 14. Quality bar

- TypeScript strict mode, no `any` outside genuinely untyped third-party boundaries.
- Unit tests for: EPUB parsing (against committed fixture files), plain-text normalization,
  chunking, and the offset-to-DOM-range mapping. These four are where correctness bugs hide and
  where they are cheapest to catch.
- No test framework beyond Vitest.
- Every network call has an error path that reaches the UI. No silent failures.
- Loading states everywhere something can take more than 300ms.
- The app must never lose a reading position. When in doubt about a write, write.

---

## 15. Open questions

Decide these during implementation and note the decision in the README:

- Paginated reader or continuous scroll? Continuous scroll is far simpler and interacts better with
  highlight-and-scroll-into-view. Recommend starting there; pagination can come later.
- Should generated audio be evictable from R2 automatically once the 10 GB budget is approached, or
  should the app simply warn? The owner has said they will cross that bridge later — build the
  usage display in M6, but not automatic eviction.
- Whether to expose the on-device TTS engines (`speechSynthesis` in the browser, Android's native
  TTS) as a zero-cost fallback mode. Quality is worse but it is instant, offline, and unlimited.
  Worth adding after M4 if it is cheap.
