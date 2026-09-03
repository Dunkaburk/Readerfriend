/**
 * Plain-text normalization — the load-bearing function of the project (§4.3, §13.2).
 *
 * Chunks store char offsets into a chapter's "normalized plain text". The same
 * function must therefore be used in three places:
 *
 *   1. at import (worker, over a linkedom tree) to produce the text that is
 *      chunked and sent to TTS,
 *   2. at render (main thread, over the real DOM) to build the offset map used
 *      for read-along highlighting,
 *   3. in tests (over both linkedom and happy-dom trees) to prove 1 and 2 agree.
 *
 * The implementation walks a *minimal* structural DOM interface (nodeType,
 * nodeName, childNodes, nodeValue, getAttribute) that real DOM, linkedom and
 * happy-dom all satisfy, so one code path serves every parser.
 *
 * Normalization rules (§8.5):
 *   - concatenate the text content of block-level elements in document order,
 *   - collapse each run of whitespace to a single space, trim each block,
 *   - join blocks with "\n\n", drop blocks that are empty after trimming,
 *   - exclude <sup>, <figcaption>, and any element with
 *     epub:type="pagebreak" or epub:type="noteref".
 */

export const TEXT_NODE = 3;
export const ELEMENT_NODE = 1;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;

/** Minimal structural node — satisfied by DOM, linkedom, happy-dom. */
export interface MiniNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes?: ArrayLike<MiniNode>;
  getAttribute?(name: string): string | null;
  /** NamedNodeMap-style attribute list ({name, value}); elements only. */
  attributes?: ArrayLike<{ name: string; value: string | null }>;
}

export interface MiniElement extends MiniNode {
  getAttribute(name: string): string | null;
}

/**
 * A piece of the offset map (§9.4): `node` contributes the character range
 * [domStart, domEnd) of its text content, which corresponds to the plain-text
 * range [textStart, textEnd). Whitespace runs in the source collapse to a
 * single space, so a segment's DOM range may be longer than its text range.
 * `node` is null for the space synthesized from a <br>, which has no text node.
 */
export interface TextSegment {
  node: MiniNode | null;
  domStart: number;
  domEnd: number;
  textStart: number;
  textEnd: number;
}

/** A DOM range split per text node, as needed for span-wrapping fallbacks. */
export interface NodeRange {
  node: MiniNode;
  start: number;
  end: number;
}

/**
 * Block-level elements. Text nodes are grouped by the nearest block ancestor;
 * each group becomes one normalized block. Enter/exit of a block always
 * flushes the current group, which is what makes nested structures
 * (blockquote > p, td, li, …) produce one block per leaf container.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DETAILS', 'DD', 'DIV', 'DL', 'DT',
  'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'OL',
  'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);

/**
 * Subtrees that never contribute text. <sup>/<figcaption> are excluded per
 * spec (footnote markers, captions); the rest are non-prose or non-rendered
 * content. Exclusion happens both here and in the sanitizer — defense in
 * depth, and it keeps this module correct even when fed unsanitized DOM.
 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'HEAD', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
  'EMBED', 'VIDEO', 'AUDIO', 'CANVAS', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'BUTTON', 'FORM',
  'LINK', 'META',
]);

/** EPUB semantics: footnote references and page markers are not prose. */
const EXCLUDED_EPUB_TYPES = new Set(['pagebreak', 'noteref', 'footnote']);

/** True when the whole subtree of this element is excluded from plain text. */
export function isExcludedElement(el: MiniElement): boolean {
  const name = el.nodeName.toUpperCase();
  if (name === 'SUP' || name === 'FIGCAPTION') return true;
  const epubType = el.getAttribute?.('epub:type');
  if (epubType) {
    for (const part of epubType.split(/\s+/)) {
      if (EXCLUDED_EPUB_TYPES.has(part)) return true;
    }
  }
  return false;
}

/** HTML whitespace. NBSP is deliberately not included (see below). */
function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
}

interface BlockAccumulator {
  text: string;
  segments: Array<{ node: MiniNode | null; domStart: number; domEnd: number; textStart: number; textEnd: number }>;
}

interface WalkContext {
  blocks: BlockAccumulator[];
  current: BlockAccumulator;
}

function newBlock(): BlockAccumulator {
  return { text: '', segments: [] };
}

function appendTextNode(ctx: WalkContext, node: MiniNode): void {
  const value = node.nodeValue;
  if (!value) return;
  const b = ctx.current;
  let i = 0;
  while (i < value.length) {
    if (isWs(value[i]!)) {
      let j = i;
      while (j < value.length && isWs(value[j]!)) j++;
      // Collapse to one space; drop at block start or when already ending in space.
      if (b.text.length > 0 && !b.text.endsWith(' ')) {
        b.text += ' ';
        b.segments.push({ node, domStart: i, domEnd: j, textStart: b.text.length - 1, textEnd: b.text.length });
      }
      i = j;
    } else {
      let j = i;
      while (j < value.length && !isWs(value[j]!)) j++;
      b.text += value.slice(i, j);
      b.segments.push({ node, domStart: i, domEnd: j, textStart: b.text.length - (j - i), textEnd: b.text.length });
      i = j;
    }
  }
}

/** Append a single collapsed space with no backing text node (for <br>). */
function appendSyntheticSpace(ctx: WalkContext): void {
  const b = ctx.current;
  if (b.text.length > 0 && !b.text.endsWith(' ')) {
    b.text += ' ';
    b.segments.push({ node: null, domStart: 0, domEnd: 0, textStart: b.text.length - 1, textEnd: b.text.length });
  }
}

interface FinishedBlock {
  text: string; // trimmed
  segments: TextSegment[]; // block-local offsets, trimmed region only
}

function flushBlock(ctx: WalkContext): void {
  const b = ctx.current;
  ctx.current = newBlock();
  const trimmed = b.text.trim();
  if (trimmed.length === 0) return;
  const left = b.text.length - b.text.trimStart().length;
  const limit = trimmed.length;
  const segments: TextSegment[] = [];
  for (const seg of b.segments) {
    // Shift into trimmed coordinates; drop anything the trim removed.
    const ns = seg.textStart - left;
    const ne = seg.textEnd - left;
    if (ne <= 0 || ns >= limit) continue;
    segments.push({
      node: seg.node,
      domStart: seg.domStart,
      domEnd: seg.domEnd,
      textStart: Math.max(ns, 0),
      textEnd: Math.min(ne, limit),
    });
  }
  ctx.blocks.push({ text: trimmed, segments });
}

/**
 * Walk a DOM-like tree and return the normalized plain text. If `segments`
 * array is provided, it is filled with the offset map covering the whole text.
 */
export function extractText(root: MiniNode, segments?: TextSegment[]): string {
  const ctx: WalkContext = { blocks: [], current: newBlock() };
  walk(root, ctx);
  flushBlock(ctx);

  const parts: string[] = [];
  if (segments) segments.length = 0;
  let globalOffset = 0;
  for (const block of ctx.blocks) {
    if (parts.length > 0) globalOffset += 2; // the "\n\n" separator, no segment covers it
    if (segments) {
      for (const seg of block.segments) {
        segments.push({
          node: seg.node,
          domStart: seg.domStart,
          domEnd: seg.domEnd,
          textStart: globalOffset + seg.textStart,
          textEnd: globalOffset + seg.textEnd,
        });
      }
    }
    parts.push(block.text);
    globalOffset += block.text.length;
  }
  return parts.join('\n\n');
}

function walk(node: MiniNode, ctx: WalkContext): void {
  switch (node.nodeType) {
    case TEXT_NODE:
      appendTextNode(ctx, node);
      return;
    case ELEMENT_NODE: {
      const el = node as MiniElement;
      const name = node.nodeName.toUpperCase();
      if (SKIP_TAGS.has(name)) return;
      if (isExcludedElement(el)) return;
      if (name === 'BR') {
        appendSyntheticSpace(ctx);
        return;
      }
      if (BLOCK_TAGS.has(name)) {
        flushBlock(ctx);
        visitChildren(node, ctx);
        flushBlock(ctx);
      } else {
        visitChildren(node, ctx);
      }
      return;
    }
    case DOCUMENT_NODE:
    case DOCUMENT_FRAGMENT_NODE:
      visitChildren(node, ctx);
      return;
    default:
      return; // comments, doctype, processing instructions
  }
}

function visitChildren(node: MiniNode, ctx: WalkContext): void {
  const children = node.childNodes;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child) walk(child, ctx);
  }
}

/** Convenience wrapper: the normalized plain text of a tree. */
export function normalizeText(root: MiniNode): string {
  return extractText(root);
}

/**
 * Build the offset map for a rendered chapter (§9.4 step 1). Walks text nodes
 * with the same rules as normalization and returns the segment list, whose
 * textStart/textEnd run over [0, normalizeText(root).length).
 */
export function buildOffsetMap(root: MiniNode): TextSegment[] {
  const segments: TextSegment[] = [];
  extractText(root, segments);
  return segments;
}

/**
 * Map a plain-text range [start, end) to node-local DOM ranges by binary
 * search over the offset map. Whitespace-only segments (node === null) are
 * skipped: they have no backing text node.
 */
export function resolveRanges(segments: TextSegment[], start: number, end: number): NodeRange[] {
  if (end <= start || segments.length === 0) return [];
  // First segment whose textEnd > start.
  let lo = 0;
  let hi = segments.length - 1;
  let first = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid]!;
    if (seg.textEnd > start) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const out: NodeRange[] = [];
  for (let i = first; i >= 0 && i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.textStart >= end) break;
    if (!seg.node) continue; // synthesized <br> space
    // Clamp both ends into the requested range; within a segment the mapping
    // is linear (segments never contain internal collapses).
    const domStart = seg.domStart + Math.max(0, start - seg.textStart);
    const domEnd = seg.domEnd - Math.max(0, seg.textEnd - end);
    if (domEnd > domStart) out.push({ node: seg.node, start: domStart, end: domEnd });
  }
  return out;
}

/** Collapse whitespace runs in a plain string to single spaces and trim. */
export function collapseWhitespace(s: string): string {
  return s.replace(/[ \n\t\r\f]+/g, ' ').trim();
}

/**
 * The whitespace-collapsed text of the first <h1>–<h3> in the tree (used for
 * chapter titles when the TOC has no entry). Skips excluded subtrees.
 */
export function firstHeadingText(root: MiniNode): string | null {
  function search(node: MiniNode): MiniNode | null {
    if (node.nodeType === ELEMENT_NODE) {
      const el = node as MiniElement;
      const name = el.nodeName.toUpperCase();
      if (SKIP_TAGS.has(name) || isExcludedElement(el)) return null;
      if (/^H[123]$/.test(name)) return el;
    }
    const children = node.childNodes;
    if (!children) return null;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const found = search(child);
      if (found) return found;
    }
    return null;
  }
  const heading = search(root);
  if (!heading) return null;
  let text = '';
  collectText(heading, (s) => {
    text += s;
  });
  return collapseWhitespace(text) || null;
}

/** Concatenate descendant text of a node, skipping excluded subtrees. */
export function collectText(root: MiniNode, emit: (s: string) => void): void {
  function walk(node: MiniNode): void {
    if (node.nodeType === TEXT_NODE) {
      if (node.nodeValue) emit(node.nodeValue);
      return;
    }
    if (node.nodeType === ELEMENT_NODE) {
      const el = node as MiniElement;
      const name = el.nodeName.toUpperCase();
      if (SKIP_TAGS.has(name) || isExcludedElement(el)) return;
    }
    const children = node.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) walk(child);
    }
  }
  walk(root);
}
