/**
 * Browser-side offset mapping (§9.4). The shared package's
 * buildOffsetMap/resolveRanges run directly on real DOM — MiniNode is
 * structurally satisfied by the browser (§13 trap 2: one normalization for
 * chunking and DOM offsets). This module adds the browser-specific pieces:
 * DOM Ranges, scroll targets, and click→text-offset lookup.
 */

import {
  buildOffsetMap,
  normalizeText,
  resolveRanges,
  type NodeRange,
  type TextSegment,
} from '@readerfriend/shared';

export type { NodeRange, TextSegment };

/** Build the offset map for a rendered chapter root. */
export function mapOffsets(root: Node): TextSegment[] {
  return buildOffsetMap(root as never);
}

/**
 * The normalized plain text of a rendered chapter root. Compare against the
 * stored chapter plainText in dev — a mismatch means highlighting will drift
 * progressively (§9.4).
 */
export function textOf(root: Node): string {
  return normalizeText(root as never);
}

/** DOM ranges covering plain-text [start, end), split per text node. */
export function domRangesFor(segments: TextSegment[], start: number, end: number): NodeRange[] {
  return resolveRanges(segments, start, end) as NodeRange[];
}

/** Build a browser Range from a per-text-node range. Returns null if empty. */
export function rangeFromNodeRange(nr: NodeRange): Range | null {
  const node = nr.node as unknown as CharacterData;
  if (!node || typeof node.nodeValue !== 'string') return null;
  const len = node.nodeValue.length;
  const start = Math.max(0, Math.min(nr.start, len));
  const end = Math.max(start, Math.min(nr.end, len));
  if (end <= start) return null;
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  return r;
}

/**
 * Locate the DOM point for a plain-text offset (for progress restore):
 * the start of the segment containing `charOffset`.
 */
export function pointForOffset(
  segments: TextSegment[],
  charOffset: number,
): { node: Node; offset: number } | null {
  // Binary search: segments are ordered by textStart.
  let lo = 0;
  let hi = segments.length - 1;
  let best: TextSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = segments[mid]!;
    if (seg.textStart <= charOffset) {
      best = seg;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!best || best.node === null) return null;
  // domStart + how far into this segment's text we are (proportional is fine —
  // the segment's dom range maps 1:1 except for collapsed whitespace).
  const span = best.textEnd - best.textStart;
  const into = span > 0 ? Math.min(1, (charOffset - best.textStart) / span) : 0;
  const domSpan = best.domEnd - best.domStart;
  return { node: best.node as unknown as Node, offset: Math.round(best.domStart + into * domSpan) };
}

/**
 * Find the chunk containing a plain-text offset. `chunks` are sorted by
 * chunkIdx and contiguous.
 */
export function chunkIndexForOffset(
  chunks: Array<{ chunkIdx: number; charStart: number; charEnd: number }>,
  charOffset: number,
): number | null {
  if (chunks.length === 0) return null;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = chunks[mid]!;
    if (charOffset < c.charStart) hi = mid - 1;
    else if (charOffset >= c.charEnd) lo = mid + 1;
    else return c.chunkIdx;
  }
  // Offsets can land exactly at the very end of the text; clamp to last chunk.
  const last = chunks[chunks.length - 1]!;
  return charOffset >= last.charEnd ? last.chunkIdx : null;
}

/** DOMRect for the caret point at `charOffset`, or null when unmappable. */
function rectForPoint(point: { node: Node; offset: number } | null): DOMRect | null {
  if (!point) return null;
  const node = point.node;
  if (!node.isConnected) return null;
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const len = (node.nodeValue ?? '').length;
    const r = document.createRange();
    r.setStart(node, Math.min(point.offset, len));
    r.setEnd(node, Math.min(point.offset, len));
    const rect = r.getBoundingClientRect();
    return rect.top === 0 && rect.bottom === 0 ? null : rect;
  }
  if (typeof (node as Element).getBoundingClientRect === 'function') {
    const rect = (node as Element).getBoundingClientRect();
    return rect.top === 0 && rect.bottom === 0 ? null : rect;
  }
  return null;
}

/**
 * Scroll the viewport so the text at `charOffset` sits `topInset` px from the
 * top (progress restore, §9.4 step 4). No-op when the offset cannot be mapped
 * to a connected node.
 */
export function scrollToOffset(segments: TextSegment[], charOffset: number, topInset = 24): void {
  const rect = rectForPoint(pointForOffset(segments, charOffset));
  if (!rect) return;
  window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - topInset) });
}

/**
 * §9.4 step 4: bring the narrated text into view, but only when it is fully
 * off-screen — never fight the user's own scrolling.
 */
export function scrollOffsetIntoViewIfNeeded(segments: TextSegment[], charOffset: number, inset = 96): void {
  const rect = rectForPoint(pointForOffset(segments, charOffset));
  if (!rect) return;
  if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
  window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - inset) });
}

/**
 * Resolve the plain-text offset under a pointer event (tap-to-play, §9.4).
 * Uses the caret APIs; null when the tap did not land on mapped text (e.g.
 * padding or inter-paragraph whitespace) — the caller decides what a miss
 * means (toggle chrome).
 */
export function offsetAtEvent(ev: MouseEvent, segments: TextSegment[]): number | null {
  const target = ev.target as Node | null;
  const doc = ev.target instanceof Document ? ev.target : (target?.ownerDocument ?? document);
  const caret = caretPoint(doc, ev.clientX, ev.clientY);
  if (!caret) {
    if (import.meta.env.DEV) console.info(`[reader] caret: none at ${ev.clientX},${ev.clientY}`);
    return null;
  }
  const offset = offsetForDomPoint(segments, caret.node, caret.offset);
  if (import.meta.env.DEV && offset === null) {
    console.info(
      '[reader] caret miss at %s,%s: nodeType=%s connected=%s inMap=%s domOffset=%s text=%o',
      ev.clientX,
      ev.clientY,
      caret.node.nodeType,
      caret.node.isConnected,
      segments.some((s) => s.node === (caret.node as never)),
      caret.offset,
      (caret.node.nodeValue ?? '').slice(0, 40),
    );
  }
  return offset;
}

/**
 * The plain-text offset of the first text visible at/above `topPx` viewport
 * space — used to track reading position while scrolling. Segments are in
 * document order, so a linear scan finds the first segment whose box extends
 * past the top threshold.
 */
export function offsetAtViewportTop(segments: TextSegment[], topPx: number): number | null {
  for (const seg of segments) {
    const node = seg.node as unknown as Node | null;
    if (!node || !node.isConnected) continue;
    const rect = segmentRect(node, seg.domStart, seg.domEnd);
    if (!rect) continue;
    if (rect.bottom > topPx) {
      const into =
        rect.height > 0 ? Math.min(1, Math.max(0, (topPx - rect.top) / rect.height)) : 0;
      return Math.round(seg.textStart + into * (seg.textEnd - seg.textStart));
    }
  }
  // Scrolled past everything: the end of the text.
  const last = segments[segments.length - 1];
  return last ? last.textEnd : null;
}

function segmentRect(node: Node, domStart: number, domEnd: number): DOMRect | null {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const r = document.createRange();
    r.setStart(node, Math.min(domStart, (node.nodeValue ?? '').length));
    r.setEnd(node, Math.min(domEnd, (node.nodeValue ?? '').length));
    return r.getBoundingClientRect();
  }
  const el = node as Element;
  return typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
}

function caretPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const modern = doc as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  };
  if (modern.caretPositionFromPoint) {
    const pos = modern.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
    return null;
  }
  const legacy = doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null };
  if (legacy.caretRangeFromPoint) {
    const r = legacy.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

/**
 * Text offset of a (node, domOffset) point via the map; null when the point
 * is outside the map. Exported for the offset round-trip test (§9.4).
 */
export function offsetForDomPoint(
  segments: TextSegment[],
  node: Node,
  domOffset: number,
): number | null {
  // Linear scan is fine (segments per chapter are thousands at most, taps are rare).
  for (const seg of segments) {
    if (seg.node === (node as never)) {
      if (domOffset >= seg.domStart && domOffset <= seg.domEnd) {
        const domSpan = seg.domEnd - seg.domStart;
        const into = domSpan > 0 ? (domOffset - seg.domStart) / domSpan : 0;
        return Math.round(seg.textStart + into * (seg.textEnd - seg.textStart));
      }
    }
  }
  return null;
}
