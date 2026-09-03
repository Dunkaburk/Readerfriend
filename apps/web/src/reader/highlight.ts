/**
 * Read-along highlighting (§9.4 step 3). Prefers the CSS Custom Highlight
 * API (no DOM mutation, cheap to move); falls back to injected <span>
 * wrappers. Two layers: the narrated chunk (soft tint) and, when the
 * interpolated-sentence setting is on, the sentence within it (stronger).
 */

import { domRangesFor } from './offsets';
import type { NodeRange, TextSegment } from '@readerfriend/shared';

export const HIGHLIGHT_NAME = 'rf-chunk';
export const SENTENCE_HIGHLIGHT_NAME = 'rf-sentence';

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
  has(name: string): boolean;
  clear?(): void;
}

let supportsApi: boolean | null = null;

function supportsHighlightApi(): boolean {
  if (supportsApi === null) {
    const css = CSS as unknown as { highlights?: HighlightRegistryLike };
    const ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    supportsApi = typeof css.highlights?.set === 'function' && typeof ctor === 'function';
  }
  return supportsApi;
}

function rangesFor(nodeRanges: NodeRange[]): Range[] {
  const out: Range[] = [];
  for (const nr of nodeRanges) {
    const r = toRange(nr);
    if (r) out.push(r);
  }
  return out;
}

function toRange(nr: NodeRange): Range | null {
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

/** Paint plain-text [start, end) under `name`; returns a disposer. */
function paintNamed(
  name: string,
  root: Node,
  segments: TextSegment[],
  start: number,
  end: number,
  spanAttr: string,
): () => void {
  const nodeRanges = domRangesFor(segments, start, end);
  if (nodeRanges.length === 0) return () => undefined;

  if (supportsHighlightApi()) {
    const ranges = rangesFor(nodeRanges);
    if (ranges.length === 0) return () => undefined;
    const ctor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
    (CSS as unknown as { highlights: HighlightRegistryLike }).highlights.set(name, new ctor(...ranges));
    return () => {
      (CSS as unknown as { highlights: HighlightRegistryLike }).highlights.delete(name);
    };
  }

  // Fallback: wrap each per-text-node range in a span.
  for (const nr of nodeRanges) {
    const r = toRange(nr);
    if (!r) continue;
    try {
      const span = document.createElement('span');
      span.setAttribute(spanAttr, '');
      r.surroundContents(span);
    } catch {
      // surroundContents cannot split element boundaries; per-text-node
      // ranges should not hit this, but a failed wrap is harmless.
    }
  }
  return () => clearSpans(root, spanAttr);
}

/**
 * Highlight the narrated chunk. One chunk painted at a time — the previous
 * paint is cleared first.
 */
export function highlightChunk(root: Node, segments: TextSegment[], start: number, end: number): () => void {
  clearChunkHighlight(root);
  return paintNamed(HIGHLIGHT_NAME, root, segments, start, end, 'data-rf-hl');
}

/** Highlight the interpolated sentence within the narrated chunk (§9.4). */
export function highlightSentence(root: Node, segments: TextSegment[], start: number, end: number): void {
  clearSentenceHighlight(root);
  paintNamed(SENTENCE_HIGHLIGHT_NAME, root, segments, start, end, 'data-rf-hl-sent');
}

/** Remove the current chunk highlight, whichever mechanism painted it. */
export function clearChunkHighlight(root: Node): void {
  if (supportsHighlightApi()) {
    (CSS as unknown as { highlights: HighlightRegistryLike }).highlights.delete(HIGHLIGHT_NAME);
    return;
  }
  clearSpans(root, 'data-rf-hl');
}

/** Remove the current sentence highlight. */
export function clearSentenceHighlight(root: Node): void {
  if (supportsHighlightApi()) {
    (CSS as unknown as { highlights: HighlightRegistryLike }).highlights.delete(SENTENCE_HIGHLIGHT_NAME);
    return;
  }
  clearSpans(root, 'data-rf-hl-sent');
}

function clearSpans(root: Node, attr: string): void {
  const el = root as Element;
  if (!el.querySelectorAll) return;
  const spans = Array.from(el.querySelectorAll(`span[${attr}]`));
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    span.remove();
    parent.normalize(); // re-merge adjacent text nodes
  }
}
