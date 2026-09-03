-- Readerfriend initial schema (SPEC §4.1).

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
