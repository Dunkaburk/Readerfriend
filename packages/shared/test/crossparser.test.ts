/**
 * The §13.2 drift guard.
 *
 * Parse time (worker): sanitize the raw chapter with the shared sanitizer over
 * a linkedom tree, store the string, normalize a linkedom parse of it.
 *
 * Render time (browser): put the stored string through DOMPurify, insert into
 * a real DOM, build the offset map with the same shared normalizer.
 *
 * If the two parsers ever disagree, chunk highlighting drifts progressively
 * through a chapter — this test stands in happy-dom for the browser and fails
 * the moment the pipelines diverge on any fixture below.
 */

import DOMPurify from 'dompurify';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { sanitizeToHtml, ALLOWED_TAGS } from '../src/sanitize';
import { buildOffsetMap, normalizeText, resolveRanges } from '../src/text';
import { parseFragment } from '../src/epub/dom';

const chapterBodies: string[] = [
  // simple paragraphs
  `<h1>Title</h1><p>One two three.</p><p>Four five.</p>`,
  // inline formatting, entities, adjacent inline elements
  `<p>She said &ldquo;go <em>now</em>&rdquo; &amp; left&hellip;</p><p><b>Bold</b><i>Italic</i><span> tail</span></p>`,
  // br handling and sup exclusion mid-paragraph
  `<p>line one<br/>line two<sup>1</sup> continues.</p>`,
  // nested structure: blockquote, lists, sections
  `<section><blockquote><p>Quoted.</p></blockquote><ol><li>One</li><li>Two</li></ol></section><p>After.</p>`,
  // epub:type exclusions
  `<p>Before<span epub:type="pagebreak">12</span> after.</p><p>note<a epub:type="noteref"><sup>1</sup></a> end</p>`,
  // attributes dropped, ids kept, table cells
  `<div class="calibre" style="margin:1em"><p id="para1">Cell text.</p></div><table><tr><td>A</td><td>B</td></tr></table>`,
  // irregular whitespace and empty blocks
  `<div>   </div><p>   Leading and trailing   </p><p>  </p><p>Real   words\t\t here</p>`,
  // internal links become data-rf-href
  `<p><a href="other.xhtml#x">link</a> and <a href="#anchor">same doc</a></p>`,
];

const san = { resolveLink: (href: string) => (href.startsWith('#') ? href : `b/${href}`) };

/** Worker-side pipeline. */
function workerNormalize(body: string): string {
  const doc = parseFragment(body);
  const stored = sanitizeToHtml(doc, san);
  return normalizeText(parseFragment(stored));
}

/** Render-side pipeline (happy-dom stands in for the browser). */
function renderNormalize(body: string): string {
  const window = new Window();
  const purify = DOMPurify(window as unknown as typeof globalThis);
  const stored = sanitizeToHtml(parseFragment(body), san);
  const clean = purify.sanitize(stored, {
    ALLOWED_TAGS: [...ALLOWED_TAGS].map((t) => t.toLowerCase()),
    ADD_ATTR: ['epub:type', 'data-rf-href', 'id', 'dir', 'lang', 'src', 'alt', 'colspan', 'rowspan', 'start', 'title', 'href'],
    ALLOW_UNKNOWN_PROTOCOLS: true,
  });
  const div = window.document.createElement('div');
  div.innerHTML = clean;
  return normalizeText(div);
}

describe('worker pipeline and render pipeline agree', () => {
  for (const [i, body] of chapterBodies.entries()) {
    it(`fixture ${i + 1} produces identical plain text`, () => {
      const viaWorker = workerNormalize(body);
      const viaRender = renderNormalize(body);
      expect(viaRender).toBe(viaWorker);
    });
  }

  it('a long realistic chapter normalizes identically', () => {
    const paras: string[] = [];
    for (let i = 0; i < 60; i++) {
      paras.push(
        `<p>Paragraph ${i} with <em>emphasis</em>, some&mdash;dashes, an<span epub:type="pagebreak">${i}</span> inline span, and words to fill it out.</p>`,
      );
    }
    const body = `<h2>Chapter</h2>${paras.join('')}`;
    expect(renderNormalize(body)).toBe(workerNormalize(body));
  });

  it('the render-side offset map round-trips against worker plain text', () => {
    const body = chapterBodies[1]!;
    const stored = sanitizeToHtml(parseFragment(body), san);
    const workerText = normalizeText(parseFragment(stored));

    const window = new Window();
    const div = window.document.createElement('div');
    div.innerHTML = stored;
    const map = buildOffsetMap(div);

    // Every 7-char window of the plain text must map to DOM slices that read
    // back the same characters. Whitespace-insensitive: block separators and
    // <br> spaces exist in plain text but have no text node backing, which is
    // the intended representation (exact whitespace round-trip is pinned in
    // text.test.ts's word-level test).
    for (let start = 0; start < workerText.length; start += 3) {
      const end = Math.min(start + 7, workerText.length);
      const ranges = resolveRanges(map, start, end);
      const dom = ranges.map((r) => (r.node.nodeValue ?? '').slice(r.start, r.end)).join('');
      const strip = (s: string) => s.replace(/\s+/g, '');
      expect(strip(dom)).toBe(strip(workerText.slice(start, end)));
    }
  });
});
