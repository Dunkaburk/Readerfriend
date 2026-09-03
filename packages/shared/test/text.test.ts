import { describe, expect, it } from 'vitest';
import { parseFragment } from '../src/epub/dom';
import {
  buildOffsetMap,
  collapseWhitespace,
  extractText,
  firstHeadingText,
  normalizeText,
  resolveRanges,
} from '../src/text';

describe('normalizeText', () => {
  it('extracts paragraph text and joins blocks with blank lines', () => {
    const text = normalizeText(parseFragment('<p>First paragraph.</p><p>Second one.</p>'));
    expect(text).toBe('First paragraph.\n\nSecond one.');
  });

  it('collapses whitespace runs to single spaces within a block', () => {
    const text = normalizeText(
      parseFragment('<p>Hello\n\t <em>  wide </em> \n world</p>'),
    );
    expect(text).toBe('Hello wide world');
  });

  it('does not insert a space between adjacent inline elements', () => {
    const text = normalizeText(parseFragment('<p>foo<em>bar</em>baz</p>'));
    expect(text).toBe('foobarbaz');
  });

  it('keeps words whole across inline boundaries', () => {
    const text = normalizeText(parseFragment('<p>some<em>thing</em></p>'));
    expect(text).toBe('something');
  });

  it('trims blocks and drops empty ones', () => {
    const text = normalizeText(
      parseFragment('<div>   </div><p>  Kept  </p><p></p><p>Also kept</p>'),
    );
    expect(text).toBe('Kept\n\nAlso kept');
  });

  it('produces one block per leaf container when nested', () => {
    const text = normalizeText(
      parseFragment('<blockquote><p>A</p><p>B</p></blockquote><li>C</li>'),
    );
    expect(text).toBe('A\n\nB\n\nC');
  });

  it('excludes sup elements (footnote markers)', () => {
    const text = normalizeText(parseFragment('<p>Word<sup>1</sup> next.</p>'));
    expect(text).toBe('Word next.');
  });

  it('excludes figcaption and elements with epub:type pagebreak/noteref', () => {
    const html =
      '<p>Before.</p>' +
      '<figure><img src="a.png"/><figcaption>Plate 1</figcaption></figure>' +
      '<p>Mid<span epub:type="pagebreak" id="p12">12</span>dle.</p>' +
      '<p>Ref<a epub:type="noteref" href="#n1"><sup>2</sup></a> done.</p>';
    const text = normalizeText(parseFragment(html));
    expect(text).toBe('Before.\n\nMiddle.\n\nRef done.');
  });

  it('treats br as a space, never fusing words', () => {
    const text = normalizeText(parseFragment('<p>line<br/>break</p>'));
    expect(text).toBe('line break');
  });

  it('keeps NBSP as a real character (it is not HTML whitespace)', () => {
    const text = normalizeText(parseFragment('<p>a b</p>'));
    expect(text).toBe('a b');
  });

  it('is deterministic for the same input', () => {
    const html = '<div><p>One <i>1</i></p><section><p>Two</p></section></div>';
    expect(normalizeText(parseFragment(html))).toBe(normalizeText(parseFragment(html)));
  });

  it('handles text directly inside a block root', () => {
    const text = normalizeText(parseFragment('<div>Loose text<p>Inner</p>More</div>'));
    expect(text).toBe('Loose text\n\nInner\n\nMore');
  });

  it('ignores comments and doctype-ish nodes', () => {
    const text = normalizeText(parseFragment('<p>A<!-- hidden -->B</p>'));
    expect(text).toBe('AB');
  });

  it('drops script/style content even if present in source', () => {
    const text = normalizeText(
      parseFragment('<script>var x = 1;</script><style>p{color:red}</style><p>Safe</p>'),
    );
    expect(text).toBe('Safe');
  });
});

describe('buildOffsetMap + resolveRanges', () => {
  const html =
    '<h2>The Start</h2><p>Alpha <em>bravo</em> charlie.</p>' +
    '<p>Delta echo<br/>foxtrot <sup>3</sup>golf.</p>';
  const doc = parseFragment(html);
  const map = buildOffsetMap(doc);
  const text = extractText(doc);

  it('the map covers exactly the normalized text', () => {
    expect(text).toBe('The Start\n\nAlpha bravo charlie.\n\nDelta echo foxtrot golf.');
    // Every segment's text slice concatenates to the full text minus the
    // "\n\n" separators; <br>-derived spaces have no text node and read as ' '.
    let reconstructed = '';
    let expected = '';
    for (const seg of map) {
      reconstructed += seg.node
        ? (seg.node.nodeValue ?? '').slice(seg.domStart, seg.domEnd).replace(/\s+/g, ' ')
        : ' ';
      expected += text.slice(seg.textStart, seg.textEnd);
      expect(seg.textEnd - seg.textStart).toBeGreaterThan(0);
    }
    expect(collapseWhitespace(reconstructed)).toBe(collapseWhitespace(expected));
  });

  it('maps a chunk range to the exact DOM text it covers', () => {
    // "bravo charlie." — inline element boundary plus plain text.
    const start = text.indexOf('bravo');
    const end = text.indexOf('charlie.') + 'charlie.'.length;
    const ranges = resolveRanges(map, start, end);
    const dom = ranges.map((r) => (r.node.nodeValue ?? '').slice(r.start, r.end)).join('');
    expect(collapseWhitespace(dom)).toBe('bravo charlie.');
  });

  it('maps a range spanning a block boundary', () => {
    const start = text.indexOf('charlie.');
    const end = text.indexOf('foxtrot') + 'foxtrot'.length;
    const ranges = resolveRanges(map, start, end);
    const dom = ranges.map((r) => (r.node.nodeValue ?? '').slice(r.start, r.end)).join('');
    // The "\n\n" separator between blocks has no DOM text, and the <br>-space
    // likewise — span-based fallback highlighting reads exactly this. (A CSS
    // Custom Highlight built as one Range from first to last node covers both.)
    expect(collapseWhitespace(dom)).toBe('charlie.Delta echofoxtrot');
  });

  it('round-trips every word boundary without drift', () => {
    // The §9.4 failure mode: works at the start, drifts through the chapter.
    // Walk the text word by word; each word's DOM slice must read back exactly.
    const wordRe = /[A-Za-z']+|[.]/g;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const ranges = resolveRanges(map, start, end);
      expect(ranges.length).toBeGreaterThan(0);
      const dom = ranges.map((r) => (r.node.nodeValue ?? '').slice(r.start, r.end)).join('');
      expect(dom).toBe(m[0]);
    }
  });

  it('returns empty for empty or inverted ranges', () => {
    expect(resolveRanges(map, 5, 5)).toEqual([]);
    expect(resolveRanges(map, 10, 4)).toEqual([]);
  });

  it('handles out-of-bounds ends gracefully', () => {
    const ranges = resolveRanges(map, text.length - 4, text.length + 100);
    const dom = ranges.map((r) => (r.node.nodeValue ?? '').slice(r.start, r.end)).join('');
    expect(dom).toBe(text.slice(text.length - 4));
  });
});

describe('firstHeadingText', () => {
  it('finds the first h1–h3 and skips excluded subtrees', () => {
    const doc = parseFragment(
      '<div><figure><figcaption><h3>nope</h3></figcaption></figure><h2> Real Title </h2><p>x</p></div>',
    );
    expect(firstHeadingText(doc)).toBe('Real Title');
  });

  it('returns null when there is no heading', () => {
    expect(firstHeadingText(parseFragment('<p>Just text</p>'))).toBeNull();
  });
});
