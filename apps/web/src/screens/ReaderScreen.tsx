/**
 * The reader (§6.1, §9.4, §10): chapter text with user typography, chrome
 * hidden while reading and revealed by tapping non-text space, chunk +
 * interpolated-sentence highlighting over the shared offset map, tap-to-play,
 * and progress restore + persistence (local immediately, server debounced
 * §6.4). While narration runs, it owns progress writes and the highlight.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db, type ChapterContentRow, type StoredChunk } from '../db/dexie';
import { api } from '../api/client';
import { useSettingsStore } from '../state/settings';
import { useNarration } from '../state/narration';
import { PlayerBar } from '../audio/PlayerBar';
import { loadChapter, useReaderData } from '../reader/useReaderData';
import {
  chunkIndexForOffset,
  mapOffsets,
  offsetAtEvent,
  offsetAtViewportTop,
  scrollOffsetIntoViewIfNeeded,
  scrollToOffset,
  textOf,
  type TextSegment,
} from '../reader/offsets';
import { clearSentenceHighlight, highlightChunk, highlightSentence } from '../reader/highlight';
import { chunkOffsetToMs, sentenceStartForOffset, sentenceWindowAt } from '../reader/sentences';
import { dropResourceCache, resolveChapterImages } from '../reader/resources';
import { TocDrawer } from '../reader/TocDrawer';
import { AppearanceDrawer } from '../reader/AppearanceDrawer';

interface Active {
  /** Offset into the chapter's normalized plain text. */
  offset: number;
  chunkIdx: number | null;
}

export function ReaderScreen() {
  const { bookId } = useParams();
  const [retryKey, setRetryKey] = useState(0);
  const readerState = useReaderData(bookId, retryKey);
  const data = readerState.status === 'ready' ? readerState.data : null;
  const settings = useSettingsStore((s) => s.settings);
  const narration = useNarration();

  const [chapterIdx, setChapterIdx] = useState<number | null>(null);
  const [chapter, setChapter] = useState<{
    content: ChapterContentRow;
    chunks: StoredChunk[];
  } | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  /** Reading position, used for progress persistence. */
  const [active, setActive] = useState<Active | null>(null);
  /** The narrated chunk when audio is off (tap/restore); the player drives it when on. */
  const [narratedChunk, setNarratedChunk] = useState<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const segmentsRef = useRef<TextSegment[]>([]);
  /** Bumped once offsets are mapped for the current chapter. */
  const [mappedAt, setMappedAt] = useState(0);
  /** One-shot progress restore (first chapter opened only). */
  const pendingRestoreRef = useRef<{ chapterIdx: number; charOffset: number; chunkIdx: number | null } | null>(
    null,
  );
  /** One-shot audiobook resume position from saved progress. */
  const audioRestoreRef = useRef<number | null>(null);
  /** Time of the user's last manual scroll (auto-follow pauses briefly). */
  const lastUserScrollRef = useRef(0);

  const narratingHere = narration.active && narration.bookId === bookId && narration.chapterIdx === chapterIdx;
  const shownChunk = narratingHere ? narration.chunkIdx : narratedChunk;

  const chapterMeta = useMemo(
    () => data?.chapters.find((c) => c.idx === chapterIdx) ?? null,
    [data, chapterIdx],
  );

  // dangerouslySetInnerHTML must be identity-stable across re-renders: React
  // 19 diffs props with `===` and re-sets innerHTML whenever the prop object
  // is new — a fresh literal here would re-parse the chapter on every render
  // (narration ticks, chrome toggles) and replace all text nodes, killing the
  // offset map and any active highlights.
  const chapterHtml = useMemo(
    () => (chapter ? { __html: chapter.content.html } : null),
    [chapter],
  );

  // Pick the initial chapter from saved progress once book data arrives.
  const bookKey = data?.book.id;
  useEffect(() => {
    if (!data) return;
    const idx = data.initialProgress?.chapterIdx ?? data.chapters[0]?.idx ?? 0;
    setChapter(null);
    setChapterIdx(idx);
    pendingRestoreRef.current = data.initialProgress
      ? {
          chapterIdx: data.initialProgress.chapterIdx,
          charOffset: data.initialProgress.charOffset,
          chunkIdx: data.initialProgress.chunkIdx,
        }
      : null;
    audioRestoreRef.current = data.initialProgress?.audioPositionMs ?? null;
    setActive(null);
    setNarratedChunk(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // Load chapter content + chunks when the chapter changes.
  useEffect(() => {
    if (!bookId || chapterIdx === null) return;
    let alive = true;
    if (import.meta.env.DEV) console.info(`[reader] load start idx=${chapterIdx}`);
    void loadChapter(bookId, chapterIdx).then((row) => {
      if (!alive) return;
      if (import.meta.env.DEV) {
        const h1 = row.content ? (row.content.html.match(/<h1[^>]*>([^<]*)<\/h1>/) ?? [])[1] : null;
        console.info(
          `[reader] load done idx=${chapterIdx} htmlLen=${row.content?.html.length} h1=${h1} chunks=${row.chunks.length}`,
        );
      }
      setChapter(row.content ? { content: row.content, chunks: row.chunks } : null);
    });
    return () => {
      alive = false;
    };
  }, [bookId, chapterIdx]);

  // Map offsets once the chapter HTML is in the DOM (§9.4 step 1).
  const sourceKey = data?.book.sourceKey;
  useEffect(() => {
    const root = contentRef.current;
    if (!root || !chapter || !bookId || !sourceKey) return;
    segmentsRef.current = mapOffsets(root);
    if (import.meta.env.DEV) {
      // Console-debugging hook: lets a probe compare the live map against the
      // current DOM (node identity) when taps or highlights misbehave.
      const w = window as unknown as { __rfSegments?: TextSegment[]; __rfRoot?: Element };
      w.__rfSegments = segmentsRef.current;
      w.__rfRoot = root;
    }

    // §9.4 guard: rendered text must equal the stored plainText, or
    // highlighting drifts progressively through the chapter.
    if (import.meta.env.DEV) {
      const rendered = textOf(root);
      const stored = chapter.content.plainText;
      const drift = rendered !== stored;
      console.info(
        `[reader] mapped chapter ${chapter.content.idx}: segments=${segmentsRef.current.length} rendered=${rendered.length} stored=${stored.length} drift=${drift}`,
      );
      if (drift) {
        // First divergence point — the single most useful fact for pinning
        // down a parser disagreement between import and render.
        let i = 0;
        while (i < rendered.length && i < stored.length && rendered[i] === stored[i]) i++;
        console.warn('[reader] rendered text differs from stored plainText — chunk mapping will drift', {
          bookId,
          chapterIdx: chapter.content.idx,
          firstDivergenceAt: i,
          renderedAround: JSON.stringify(rendered.slice(Math.max(0, i - 40), i + 40)),
          storedAround: JSON.stringify(stored.slice(Math.max(0, i - 40), i + 40)),
        });
      }
    }

    const href = chapterMeta?.href ?? null;
    void resolveChapterImages(bookId, sourceKey, href, root);
    setMappedAt((n) => n + 1);
  }, [chapter, bookId, sourceKey, chapterMeta]);

  // Restore reading position once, right after the first chapter maps.
  useEffect(() => {
    if (!mappedAt || !chapter) return;
    const restore = pendingRestoreRef.current;
    pendingRestoreRef.current = null;
    const root = contentRef.current;
    if (restore && restore.chapterIdx === chapter.content.idx && root) {
      scrollToOffset(segmentsRef.current, restore.charOffset);
      setActive({
        offset: restore.charOffset,
        chunkIdx: restore.chunkIdx ?? chunkIndexForOffset(chapter.chunks, restore.charOffset),
      });
      setNarratedChunk(restore.chunkIdx);
    } else {
      window.scrollTo({ top: 0 });
      setActive({ offset: 0, chunkIdx: chapter.chunks[0]?.chunkIdx ?? null });
      setNarratedChunk(null);
    }
  }, [mappedAt, chapter]);

  // Track reading position while scrolling (debounced; the highlight does not
  // follow free scrolling — it follows narration / taps).
  useEffect(() => {
    if (!chapter) return;
    let timer: number | undefined;
    const onScroll = () => {
      lastUserScrollRef.current = Date.now();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const segments = segmentsRef.current;
        if (segments.length === 0) return;
        const offset = offsetAtViewportTop(segments, 80);
        if (offset === null) return;
        setActive({ offset, chunkIdx: chunkIndexForOffset(chapter.chunks, offset) });
      }, 150);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
    };
  }, [chapter]);

  // Paint the narrated chunk (§9.4 baseline).
  useEffect(() => {
    const root = contentRef.current;
    if (!root || !chapter) return;
    if (shownChunk === null) return;
    const chunk = chapter.chunks.find((c) => c.chunkIdx === shownChunk);
    if (!chunk) return;
    return highlightChunk(root, segmentsRef.current, chunk.charStart, chunk.charEnd);
  }, [shownChunk, chapter, mappedAt]);

  // Follow the narration with auto-scroll (§9.4 step 4), pausing briefly
  // after any manual scroll so we never fight the reader.
  useEffect(() => {
    if (!narratingHere || shownChunk === null || !chapter) return;
    if (Date.now() - lastUserScrollRef.current < 4000) return;
    const chunk = chapter.chunks.find((c) => c.chunkIdx === shownChunk);
    if (!chunk) return;
    scrollOffsetIntoViewIfNeeded(segmentsRef.current, chunk.charStart);
  }, [narratingHere, shownChunk, chapter]);

  // Interpolated sentence highlight (§9.4 enhancement), behind the setting.
  const sentenceOn = settings.sentenceHighlight;
  useEffect(() => {
    const root = contentRef.current;
    if (!root || !chapter) return;
    if (!sentenceOn || !narratingHere || shownChunk === null) {
      clearSentenceHighlight(root);
      return;
    }
    const chunk = chapter.chunks.find((c) => c.chunkIdx === shownChunk);
    if (!chunk) return;
    const win = sentenceWindowAt(chunk, narration.positionMs, narration.durationMs);
    if (!win) return;
    highlightSentence(root, segmentsRef.current, win.start, win.end);
  }, [sentenceOn, narratingHere, shownChunk, chapter, narration.positionMs, narration.durationMs, mappedAt]);

  // Stop narration when leaving the chapter or the book (predictable: one
  // chapter narrates at a time).
  useEffect(() => {
    const id = bookId;
    return () => {
      const n = useNarration.getState();
      if (n.active && n.bookId === id) n.stop();
    };
  }, [bookId]);

  // Persist progress locally (immediately, debounced) and to the server
  // (debounced ~5s, §6.4 — last-write-wins, no conflict UI). While narrating
  // this chapter, the narration store owns progress writes.
  useEffect(() => {
    if (!bookId || !chapter || !active || narratingHere) return;
    const t = window.setTimeout(() => {
      void db.progress.put({
        bookId,
        chapterIdx: chapter.content.idx,
        charOffset: active.offset,
        chunkIdx: active.chunkIdx,
        audioPositionMs: null,
        updatedAt: Date.now(),
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [bookId, chapter, active, narratingHere]);

  useEffect(() => {
    if (!bookId || !chapter || !active || narratingHere || data?.book.pendingSync) return;
    const t = window.setTimeout(() => {
      void api
        .putProgress(bookId, {
          chapterIdx: chapter.content.idx,
          charOffset: active.offset,
          chunkIdx: active.chunkIdx,
          audioPositionMs: null,
        })
        .catch(() => {
          // Offline; the library sync reconciles progress later (§6.4).
        });
    }, 5000);
    return () => window.clearTimeout(t);
  }, [bookId, chapter, active, narratingHere, data?.book.pendingSync]);

  // Release this book's object URLs when leaving the book.
  useEffect(() => {
    const id = bookId;
    return () => {
      if (id) dropBookResources(id);
    };
  }, [bookId]);

  const goToChapter = useCallback((idx: number) => {
    useNarration.getState().stop(); // one chapter narrates at a time
    setTocOpen(false);
    setChapter(null);
    setActive(null);
    setNarratedChunk(null);
    setChapterIdx(idx);
  }, []);

  const startNarration = useCallback(
    (startChunkIdx: number | null, explicitStartMs?: number) => {
      if (!bookId || !chapter || chapterIdx === null) return;
      const chunk = startChunkIdx ?? active?.chunkIdx ?? chapter.chunks[0]?.chunkIdx ?? 0;
      const startMs = explicitStartMs ?? audioRestoreRef.current ?? undefined;
      audioRestoreRef.current = null;
      void useNarration
        .getState()
        .start(
          bookId,
          chapterIdx,
          chapterMeta?.title ?? `Chapter ${chapterIdx + 1}`,
          chapter.chunks,
          chunk,
          startMs,
        );
    },
    [bookId, chapter, chapterIdx, active, chapterMeta],
  );

  const onAudiobook = useCallback(() => {
    const n = useNarration.getState();
    if (n.active) {
      if (n.bookId === bookId && n.chapterIdx === chapterIdx) {
        n.toggle();
        return;
      }
      n.stop();
    }
    startNarration(narratedChunk);
  }, [bookId, chapterIdx, narratedChunk, startNarration]);

  // Tap-to-play (§9.4): tapping mapped text starts (or seeks) audio at the
  // chunk containing it. A miss — margins, inter-paragraph whitespace —
  // toggles chrome (§6.1).
  const onTap = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>) => {
      const target = ev.target as Element | null;
      if (target?.closest('a')) return; // let links work
      const offset = offsetAtEvent(ev.nativeEvent, segmentsRef.current);
      if (offset === null || !chapter) {
        setChromeVisible((v) => !v);
        return;
      }
      const idx = chunkIndexForOffset(chapter.chunks, offset);
      const n = useNarration.getState();
      if (import.meta.env.DEV) {
        console.info(
          '[reader] tap: offset=%s chunk=%s narrating=%s',
          offset,
          idx,
          n.active && n.bookId === bookId && n.chapterIdx === chapterIdx,
        );
      }
      setActive({ offset, chunkIdx: idx });
      setNarratedChunk(idx);
      if (idx === null) return;
      if (n.active && n.bookId === bookId && n.chapterIdx === chapterIdx) {
        // Sentence-level seek (§9.4): to the start of the tapped sentence. A
        // sibling chunk's position is estimated from the playing chunk's
        // duration (same constant-rate approximation as the highlight).
        const chunk = chapter.chunks.find((c) => c.chunkIdx === idx);
        if (chunk) {
          const sentStart = sentenceStartForOffset(chunk, offset);
          n.seekToChunkPosition(idx, chunkOffsetToMs(chunk, sentStart, n.durationMs));
        } else {
          n.seekToChunk(idx);
        }
      } else {
        startNarration(idx);
      }
    },
    [chapter, bookId, chapterIdx, startNarration],
  );

  if (!data) {
    return (
      <div className="mx-auto min-h-dvh max-w-3xl px-5 pt-10">
        <BackLink />
        {readerState.status === 'hydrating' ? (
          <p className="mt-6 text-sm text-muted">
            Downloading “{readerState.book.title}” from your library…
          </p>
        ) : readerState.status === 'error' ? (
          <>
            <p className="mt-6 text-sm text-fg">This book could not be opened: {readerState.message}</p>
            <button
              type="button"
              onClick={() => setRetryKey((n) => n + 1)}
              className="mt-3 h-11 rounded-md border border-black/15 px-4 text-sm text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
            >
              Try again
            </button>
          </>
        ) : readerState.status === 'loading' ? (
          <p className="mt-6 text-sm text-muted">Loading…</p>
        ) : (
          <p className="mt-6 text-sm text-muted">Book not found on this device.</p>
        )}
      </div>
    );
  }

  const chapters = data.chapters;
  const canPrev = chapterIdx !== null && chapters.some((c) => c.idx === chapterIdx - 1);
  const canNext = chapterIdx !== null && chapters.some((c) => c.idx === chapterIdx + 1);

  return (
    <div className="min-h-dvh">
      {/* Top chrome (§6.1) */}
      <header
        className={
          'fixed inset-x-0 top-0 z-30 h-14 border-b border-black/10 bg-surface/95 backdrop-blur transition-transform duration-150 dark:border-white/10 ' +
          (chromeVisible ? 'translate-y-0' : '-translate-y-full')
        }
      >
        <div className="mx-auto flex h-full max-w-4xl items-center gap-1 px-2">
          <Link
            to="/"
            className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-sm text-accent"
            aria-label="Back to library"
          >
            ←
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-sm text-fg">
            {chapterMeta?.title ?? (chapterIdx !== null ? `Chapter ${chapterIdx + 1}` : data.book.title)}
          </h1>
          <button
            type="button"
            onClick={() => setAppearanceOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded text-muted hover:text-fg"
            aria-label="Reading appearance"
          >
            Aa
          </button>
          <button
            type="button"
            onClick={() => setTocOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded text-muted hover:text-fg"
            aria-label="Table of contents"
          >
            ☰
          </button>
        </div>
      </header>

      {/* Chapter text */}
      <main
        className="mx-auto w-full"
        style={{
          fontFamily: settings.fontFamily === 'serif' ? 'var(--font-serif)' : undefined,
          fontSize: `${settings.fontSize}px`,
          lineHeight: settings.lineHeight,
          paddingInline: `max(1rem, ${settings.marginWidth}px)`,
        }}
      >
        {chapter && chapterHtml ? (
          <div
            ref={contentRef}
            className="rf-chapter"
            style={{ maxWidth: 'min(70ch, 100%)' }}
            dangerouslySetInnerHTML={chapterHtml}
            onClick={onTap}
          />
        ) : (
          <p className="py-20 text-center text-sm text-muted">Loading chapter…</p>
        )}
      </main>

      {/* Bottom chrome */}
      <footer
        className={
          'fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-surface/95 backdrop-blur transition-transform duration-150 dark:border-white/10 ' +
          (chromeVisible ? 'translate-y-0' : 'translate-y-full')
        }
      >
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-2 px-4">
          <button
            type="button"
            onClick={() => goToChapter(chapterIdx! - 1)}
            disabled={!canPrev}
            className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-sm text-fg disabled:opacity-30"
            aria-label="Previous chapter"
          >
            ← Chap
          </button>
          <p className="flex-1 text-center text-xs text-muted tabular-nums">
            {chapterIdx !== null ? `${chapterIdx + 1} / ${chapters.length}` : ''}
          </p>
          <button
            type="button"
            onClick={onAudiobook}
            disabled={!chapter || chapter.chunks.length === 0}
            className="flex h-11 items-center rounded-full bg-accent px-4 text-sm font-medium text-white disabled:opacity-50"
            title={narratingHere && narration.playing ? 'Pause narration' : 'Start narration'}
          >
            {narratingHere && narration.playing ? '⏸ Audiobook' : '▶ Audiobook'}
          </button>
          <button
            type="button"
            onClick={() => goToChapter(chapterIdx! + 1)}
            disabled={!canNext}
            className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-sm text-fg disabled:opacity-30"
            aria-label="Next chapter"
          >
            Chap →
          </button>
        </div>
      </footer>

      <TocDrawer
        open={tocOpen}
        chapters={chapters}
        currentIdx={chapterIdx ?? 0}
        onSelect={goToChapter}
        onClose={() => setTocOpen(false)}
      />

      <AppearanceDrawer open={appearanceOpen} onClose={() => setAppearanceOpen(false)} />

      <PlayerBar />
    </div>
  );
}

/** Release this book's cached EPUB resource URLs (session-scoped). */
function dropBookResources(bookId: string): void {
  dropResourceCache(bookId);
}

export function BackLink() {
  return (
    <Link to="/" className="inline-flex h-11 items-center text-sm text-accent underline underline-offset-4">
      ← Library
    </Link>
  );
}
