/**
 * Chapter HTML sanitizer (§8.5).
 *
 * Runs at import time in the worker, where there is no DOM for DOMPurify, so
 * this is implemented as a pure tree→string serializer over the same minimal
 * node interface the normalizer uses. It is allowlist-based: anything not
 * explicitly allowed is unwrapped (children kept, tag dropped), which strips
 * scripts, event handlers, styling and layout by construction.
 *
 * The stored HTML is sanitized AGAIN at render time with DOMPurify (aligned
 * allowlist) as defense in depth; for already-clean input that pass is a no-op,
 * which keeps the parse-time and render-time trees — and therefore the plain
 * text offsets — identical.
 */

import {
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
  ELEMENT_NODE,
  TEXT_NODE,
  isExcludedElement,
  type MiniElement,
  type MiniNode,
} from './text';

/** Tags kept in the rendered HTML. */
export const ALLOWED_TAGS = new Set([
  // structure
  'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'CENTER',
  'BLOCKQUOTE', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'PRE', 'HR',
  'DETAILS', 'SUMMARY',
  // inline
  'SPAN', 'A', 'EM', 'STRONG', 'I', 'B', 'U', 'S', 'DEL', 'INS', 'SUP', 'SUB', 'SMALL', 'BIG',
  'CODE', 'Q', 'CITE', 'ABBR', 'DFN', 'KBD', 'SAMP', 'VAR', 'MARK', 'TIME', 'RUBY', 'BR', 'WBR',
  'IMG',
]);

/** Tags removed together with their entire content. */
export const DROP_WITH_CONTENT = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO',
  'AUDIO', 'CANVAS', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'HEAD', 'META', 'LINK',
  'TITLE',
]);

/** Attributes allowed on every element. */
const GLOBAL_ATTRS = new Set(['id', 'epub:type', 'dir', 'lang']);
/** Attributes allowed on specific elements. */
const TAG_ATTRS: Record<string, Set<string>> = {
  IMG: new Set(['src', 'alt']),
  A: new Set(['href', 'title', 'data-rf-href']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan']),
  OL: new Set(['start']),
};

export interface SanitizeContext {
  /**
   * Map a raw href to a book-relative link target ("Text/ch2.xhtml#frag").
   * Return null to drop the link (the anchor is unwrapped). External links
   * (http/https/mailto) bypass this and are kept as plain hrefs.
   */
  resolveLink: (rawHref: string) => string | null;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

function serializeAttributes(el: MiniElement, ctx: SanitizeContext): string {
  let out = '';
  const name = el.nodeName.toUpperCase();
  const allowed = TAG_ATTRS[name];
  const attrs = el.attributes;
  if (!attrs) return out;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (!attr) continue;
    const attrName = attr.name.toLowerCase();
    if (!GLOBAL_ATTRS.has(attrName) && !(allowed && allowed.has(attrName))) continue;

    if (attrName === 'href') {
      const raw = (attr.value ?? '').trim();
      if (isExternalHref(raw)) {
        out += ` href="${escapeAttr(raw)}"`;
      } else {
        // Internal link → in-app navigation target. Never emit href itself.
        const target = ctx.resolveLink(raw);
        if (target) out += ` data-rf-href="${escapeAttr(target)}"`;
      }
      continue;
    }
    const value = attr.value ?? '';
    if (value === '' && attrName !== 'epub:type' && attrName !== 'dir' && attrName !== 'lang') continue;
    out += ` ${attrName}="${escapeAttr(value)}"`;
  }
  return out;
}

function serializeNode(node: MiniNode, ctx: SanitizeContext): string {
  switch (node.nodeType) {
    case TEXT_NODE:
      return node.nodeValue ? escapeText(node.nodeValue) : '';
    case COMMENT_NODE:
      return '';
    case ELEMENT_NODE: {
      const el = node as MiniElement;
      const name = el.nodeName.toUpperCase();
      if (DROP_WITH_CONTENT.has(name)) return '';
      if (isExcludedElement(el)) {
        // Footnote refs / pagebreaks / noterefs: drop the whole subtree — the
        // normalizer excludes them from plain text, so the rendered DOM must
        // not contain them either.
        return '';
      }
      if (!ALLOWED_TAGS.has(name)) {
        // Unknown tag: unwrap — serialize children only. This is what strips
        // layout cruft, custom namespaced tags and anything unexpected.
        return serializeChildren(el, ctx);
      }
      const tag = name.toLowerCase();
      const attrs = serializeAttributes(el, ctx);
      if (name === 'BR' || name === 'HR' || name === 'IMG' || name === 'WBR') {
        return `<${tag}${attrs}>`;
      }
      return `<${tag}${attrs}>${serializeChildren(el, ctx)}</${tag}>`;
    }
    case DOCUMENT_NODE:
    case DOCUMENT_FRAGMENT_NODE:
      return serializeChildren(node, ctx);
    default:
      return '';
  }
}

function serializeChildren(node: MiniNode, ctx: SanitizeContext): string {
  let inner = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) inner += serializeNode(child, ctx);
    }
  }
  return inner;
}

/**
 * Serialize a DOM-like tree to sanitized HTML. Unknown tags are unwrapped
 * (children kept); disallowed subtrees are dropped entirely; text and attribute
 * values are escaped. Returns a fragment string.
 */
export function sanitizeToHtml(root: MiniNode, ctx: SanitizeContext): string {
  return serializeNode(root, ctx);
}
