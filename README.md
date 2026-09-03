# Readerfriend

A personal ebook reader with AI-generated audiobook narration. Import an EPUB or
TXT file, read it in a quiet, typography-first interface, and press **Audiobook**
to have the current chapter narrated by a TTS model — with the text highlighted
as it is read aloud. Your library, reading position and generated audio sync
between your phone and your browser.

Built for one person (the repository owner). No accounts, no multi-tenancy —
auth is a single shared bearer token that keeps strangers from spending your
OpenRouter quota. Recurring cost is **zero**: everything runs on permanent free
tiers; the only spend is a one-time $10 OpenRouter credit (already committed)
that unlocks the 1000-requests/day TTS cap.

## Architecture

```
  Android app  ──┐                   ┌── D1        (metadata, chunk plan, progress)
  (Capacitor)    ├──►  Worker API  ──┤
  Web app      ──┘     (Hono)        ├── R2        (source files, generated audio)
  (Cloudflare Pages)                 │
                                     └── OpenRouter (TTS generation)
```

- `apps/web` — Vite + React SPA. Also the Capacitor source for Android (§ M5).
- `workers/api` — a thin Cloudflare Worker (Hono): auth, D1, R2, and a TTS
  proxy so the OpenRouter key never touches a client.
- `packages/shared` — types + pure logic (normalization, chunking, EPUB
  parsing) shared by both sides.

**The chunk plan is computed exactly once, at import, on the importing device**
(`SPEC.md` §4.3) and stored in D1 as the canonical record. Every other device —
including the original device on later reads — treats it as read-only. This is
what makes audio addresses (`book, chapter, chunk`) mean the same text on every
device.

## Setup from scratch

Prerequisites: Node ≥ 22, pnpm (`corepack enable`), and a Cloudflare account
with Wrangler logged in (`pnpm dlx wrangler login`).

```sh
pnpm install
```

### 1. Create the Cloudflare resources

```sh
cd workers/api
pnpm dlx wrangler d1 create readerfriend          # paste the printed database_id
pnpm dlx wrangler r2 bucket create readerfriend-media
```

Put the returned `database_id` into `workers/api/wrangler.toml`
(`[[d1_databases]] database_id = "..."`). The R2 bucket name is already wired.

### 2. Apply the D1 migration

```sh
pnpm dlx wrangler d1 migrations apply readerfriend --remote
pnpm dlx wrangler d1 migrations apply readerfriend --local   # for `wrangler dev`
```

### 3. Set the secrets

```sh
pnpm dlx wrangler secret put APP_TOKEN            # openssl rand -hex 32
pnpm dlx wrangler secret put OPENROUTER_API_KEY   # sk-or-... from openrouter.ai
```

The token is the only credential the app asks for; generate it once, then paste
it into the app's Settings on each device (or build it in via `VITE_APP_TOKEN`,
see `apps/web/.env.example`). `OPENROUTER_API_KEY` lives only in the Worker —
never ship it to a client.

For local development, copy the same values into `workers/api/.dev.vars`
(gitignored):

```toml
APP_TOKEN = "dev-token-..."
OPENROUTER_API_KEY = "sk-or-..."
```

### 4. Run

```sh
pnpm dev        # web on :5173, worker on :8787 (root script)
pnpm dev:web    # or individually
pnpm dev:api
```

Point `VITE_API_BASE` (in `apps/web/.env`) at the Worker; the default is
`http://localhost:8787`. On first launch, pick a **voice model** and **voice**
in Settings — the list comes from OpenRouter's models API (free variants are
marked). Free models rotate without notice; if the configured one disappears,
pick a new one in Settings and generation continues.

### 5. Deploy

```sh
pnpm deploy      # wrangler deploy (Worker + secrets already set)
```

Host the web app on Cloudflare Pages: build `apps/web` (`pnpm --filter web
build`) and serve `apps/web/dist`, with `VITE_API_BASE` set to the deployed
Worker URL at build time.

## Tests

```sh
pnpm test        # Vitest across shared, web and worker
pnpm typecheck   # strict TS, all packages
```

The Worker tests run through Miniflare against real D1/R2; OpenRouter is
stubbed. The web tests cover EPUB/normalization/chunking, the plain-text ↔ DOM
offset mapping, the generation queue's rate limiting and backoff, playback
swap logic, audio resolution, and the sync engine's merge rules.

## How sync works (one user, deliberately simple)

- On start, on reconnect and on focus, the client pulls
  `GET /api/library?since=<watermark>` and merges book metadata + reading
  progress into its local mirror; `serverTime` becomes the new watermark.
- Progress is last-write-wins on `updated_at` (no conflict UI).
- Books imported on another device arrive as metadata only; their content
  (source file, rendered chapters, and the canonical chunk plan) is downloaded
  the first time you open them.
- Settings (voice, model, theme, typography) sync through
  `GET/PUT /api/settings`: local edits push after a 2s debounce; otherwise the
  server copy wins.
- Uploads and deletes made offline queue in a local outbox and flush on
  reconnect. Everything except *generating new audio* works offline.

## Audio pipeline notes

- Chunks are ~2,000 characters (≈275 requests for a 100k-word novel).
- The client self-rate-limits generation to **12 requests/minute** (one every
  5s) — comfortably under OpenRouter's free 20/min — honours `Retry-After` on
  429 with exponential backoff up to 5 minutes, persists its queue across
  restarts, and warns near the ~1000/day cap.
- While playing, it prefetches ≥ 5 chunks (~10 min of audio) ahead of the
  playhead. "Generate whole chapter / whole book" actions (expanded player)
  exist for offline trips, with a time warning.
- Read-along highlighting maps chunk offsets onto the DOM; interpolated
  sentence highlighting (constant-rate approximation, §9.4) is behind a
  setting. Tap any paragraph to play from there.
- Audio caches in IndexedDB per chunk as you listen; Settings → Storage shows
  usage and can clear it.

## Android (M5)

Capacitor wraps the same web build. The platform is generated on demand:

```sh
cd apps/web
pnpm dlx cap add android       # creates android/ (committed)
pnpm build && pnpm dlx cap sync
pnpm dlx cap open android      # build/sign the APK in Android Studio
```

`capacitor.config.ts` is committed and points at `dist/`. Background audio
(a WebView suspends it when the screen locks) needs a foreground-service
plugin — research current options when picking this milestone up, and verify
screen-off playback on real hardware before calling it done.

## Decisions (SPEC §15)

- **Continuous scroll** reader, not pagination — simpler, and required for
  highlight-and-scroll-into-view to feel right.
- **No automatic eviction** of R2 audio; Settings shows usage instead. The
  owner will revisit at the 10 GB mark.
- **No on-device TTS fallback** (`speechSynthesis`) for now — revisit if
  generation quota becomes a daily pain point.
- **Second-device hydration** re-parses the downloaded source for *rendering*
  but always reads the chunk plan from the server (never recomputed, §13.1).
- Progress writes are local-first (immediate) and server-debounced (~5 s);
  narration writes take over while audio plays.

The full build brief — including the data model, the TTS endpoint contract and
the offline behaviour — lives in [`SPEC.md`](SPEC.md).
