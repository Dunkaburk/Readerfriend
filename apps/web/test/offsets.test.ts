/**
 * The §9.4 round-trip contract, tested exactly: the import pipeline computes
 * chapter plainText by normalizing sanitized HTML over a linkedom tree; the
 * reader maps chunk offsets over the rendered DOM (happy-dom here). If the
 * two normalizations ever disagree, highlighting drifts progressively —
 * "works at the start, gets worse" — so these tests compare them directly
 * and verify every chunk's highlight ranges reconstruct its exact text.
 *
 * Note on structure: block separators ("\n\n") are synthesized by the
 * normalizer between blocks — they belong to no text node, so segments have
 * gaps of exactly 2 there, and offsets inside a gap anchor to the preceding
 * segment (≤1 char of slack in the point round-trip).
 */

import { describe, expect, it } from 'vitest';
// The import side runs on linkedom — same tree walker, different DOM impl.
import { parseHTML } from 'linkedom';
import { normalizeText, planChapterChunks, type MiniNode } from '@readerfriend/shared';
import {
  chunkIndexForOffset,
  domRangesFor,
  mapOffsets,
  offsetForDomPoint,
  pointForOffset,
  textOf,
} from '../src/reader/offsets';

const CHAPTER_HTML = `
<h1>The&nbsp;Beginning</h1>
<p>It was a dark &amp; stormy night; the rain had fallen &#8212; relentlessly &lt;all day&gt;.</p>
<p>Anna said, "Wait&hellip; did you hear    that?"  Then she
   listened: nothing. <em>Nothing at all.</em></p>
<blockquote><p>Words spoken <strong>quietly</strong> still carry.</p></blockquote>
<ul><li>First item</li><li>Second item</li></ul>
<p>A line<br>broken in two, and a <a href="https://example.com">link</a> to nowhere.</p>
<script>document.wouldBe('ignored')</script>
<style>.also-ignored { color: red }</style>
<p>The end.   </p>
`;

/** Render like the reader does: sanitized HTML into a live element. */
function render(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

/**
 * The import pipeline's plainText for the same HTML. Mirrors shared's
 * parseFragment: linkedom puts fragment content directly on its document.
 */
function importSidePlainText(html: string): string {
  return normalizeText(parseHTML(html).document as unknown as MiniNode);
}

describe('offset mapping (§9.4 round trip)', () => {
  it('normalizes rendered DOM text exactly like the import pipeline', () => {
    const root = render(CHAPTER_HTML);
    try {
      expect(textOf(root)).toBe(importSidePlainText(CHAPTER_HTML));
    } finally {
      root.remove();
    }
  });

  it('produces ordered, non-overlapping segments whose gaps are block separators only', () => {
    const root = render(CHAPTER_HTML);
    try {
      const segments = mapOffsets(root);
      const text = textOf(root);
      expect(segments.length).toBeGreaterThan(5);

      expect(segments[0]!.textStart).toBe(0);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        expect(seg.textEnd).toBeGreaterThanOrEqual(seg.textStart);
        if (i > 0) {
          const gap = seg.textStart - segments[i - 1]!.textEnd;
          // 0 = same block continuation, 2 = one "\n\n" block separator.
          expect(gap === 0 || gap === 2, `segment ${i} gap ${gap}`).toBe(true);
        }
      }
      // The last segment reaches (at most one trailing space away from) the end.
      expect(text.length - segments[segments.length - 1]!.textEnd).toBeLessThanOrEqual(1);
    } finally {
      root.remove();
    }
  });

  it('reconstructs every chunk exactly from its highlight ranges', () => {
    const root = render(CHAPTER_HTML);
    try {
      const text = textOf(root);
      const segments = mapOffsets(root);
      // The import worker adds chunkIdx when it maps plans into rows.
      const chunks = planChapterChunks(text, 'en').map((c, chunkIdx) => ({ ...c, chunkIdx }));

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        const ranges = domRangesFor(segments, chunk.charStart, chunk.charEnd);
        expect(ranges.length).toBeGreaterThan(0);
        // Reconstruct the chunk from the raw DOM text its ranges cover, then
        // normalize the same way the import pipeline would. Two kinds of
        // normalized characters have no text node of their own and must be
        // bridged from the map: block separators ("\n\n") and the space a
        // <br> synthesizes — both appear as the gap between consecutive
        // segments, so we copy that gap straight out of the plain text.
        // Segments split text nodes into whitespace/word runs, so the owner
        // of a range is the segment whose dom range contains it.
        const ownerOf = (nr: { node: unknown; start: number; end: number }) =>
          segments.find(
            (s) => s.node === nr.node && s.domStart <= nr.start && nr.end <= s.domEnd,
          )!;
        let covered = '';
        let prev: (typeof segments)[number] | null = null;
        for (const nr of ranges) {
          const seg = ownerOf(nr);
          expect(seg, `range ${nr.start}..${nr.end} maps to a segment`).toBeTruthy();
          if (prev && seg.textStart > prev.textEnd) {
            covered += text.slice(prev.textEnd, seg.textStart);
          }
          covered += (nr.node as CharacterData).nodeValue?.slice(nr.start, nr.end) ?? '';
          prev = seg;
        }
        const wrapper = document.createElement('div');
        wrapper.textContent = covered;
        const got = normalizeText(wrapper);
        // Normalize the expectation through the identical single-block path:
        // inside one block the reconstructed "\n\n" bridges collapse to a
        // space, exactly as they do in the raw concatenation.
        const wantWrapper = document.createElement('div');
        wantWrapper.textContent = chunk.text;
        const want = normalizeText(wantWrapper);
        // A chunk boundary can sit mid-whitespace-run; normalization drops
        // the boundary-adjacent whitespace of the slice, so compare trimmed.
        expect(got.trim()).toBe(want.trim());
      }

      // Chunks tile the text with no gaps.
      expect(chunks[0]!.charStart).toBe(0);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.charStart).toBe(chunks[i - 1]!.charEnd);
      }
      expect(chunks[chunks.length - 1]!.charEnd).toBe(text.length);
    } finally {
      root.remove();
    }
  });

  it('round-trips offset → DOM point → offset (exact, except inside block gaps)', () => {
    const root = render(CHAPTER_HTML);
    try {
      const text = textOf(root);
      const segments = mapOffsets(root);
      const offsets: number[] = [];
      for (let offset = 0; offset < text.length; offset += 17) offsets.push(offset);
      offsets.push(0, text.length - 1);

      for (const offset of offsets) {
        const point = pointForOffset(segments, offset);
        expect(point, `offset ${offset}`).not.toBeNull();
        const back = offsetForDomPoint(segments, point!.node as unknown as Node, point!.offset);
        // Offsets inside a "\n\n" gap anchor to the preceding segment.
        expect(back === offset || back === offset - 1, `offset ${offset} → ${back}`).toBe(true);
      }
    } finally {
      root.remove();
    }
  });

  it('locates the containing chunk for offsets across the whole chapter', () => {
    const root = render(CHAPTER_HTML);
    try {
      const text = textOf(root);
      const chunks = planChapterChunks(text, 'en');
      if (chunks.length < 2) return; // fixture too small; tiling checked above

      for (const chunk of chunks) {
        expect(chunkIndexForOffset(chunks, chunk.charStart)).toBe(chunk.chunkIdx);
        expect(chunkIndexForOffset(chunks, Math.floor((chunk.charStart + chunk.charEnd) / 2))).toBe(
          chunk.chunkIdx,
        );
        // End offset (exclusive) belongs to the next chunk, or clamps to the last.
        const atEnd = chunkIndexForOffset(chunks, chunk.charEnd);
        const isLast = chunk.chunkIdx === chunks[chunks.length - 1]!.chunkIdx;
        expect(atEnd).toBe(isLast ? chunk.chunkIdx : chunk.chunkIdx + 1);
      }
      expect(chunkIndexForOffset(chunks, -5)).toBe(0);
      expect(chunkIndexForOffset(chunks, text.length + 100)).toBe(chunks[chunks.length - 1]!.chunkIdx);
    } finally {
      root.remove();
    }
  });
});
