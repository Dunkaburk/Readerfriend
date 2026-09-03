import { describe, expect, it } from 'vitest';
import { parseTxt, splitTxtChapters } from '../src/epub/txt';
import { BookParseError, parseEpub } from '../src/epub';
import {
  CONTAINER_XML,
  PNG_BYTES,
  epub3Opf,
  makeEpub,
  xhtmlDoc,
} from './helpers';

describe('parseEpub — EPUB 3 with nav', () => {
  const files = () => ({
    'META-INF/container.xml': CONTAINER_XML,
    'OEBPS/content.opf': epub3Opf({
      title: 'The Test Book',
      author: 'Jane Coder',
      language: 'en-GB',
      manifest: `
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
        <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
        <item id="style" href="style.css" media-type="text/css"/>
      `,
      spine: `<itemref idref="c1"/><itemref idref="c2"/>`,
    }),
    'OEBPS/nav.xhtml': xhtmlDoc(
      'TOC',
      `<nav epub:type="toc"><ol>
         <li><a href="text/ch1.xhtml">The Beginning</a></li>
         <li><a href="text/ch2.xhtml#mid">The Middle</a></li>
       </ol></nav>`,
    ),
    'OEBPS/text/ch1.xhtml': xhtmlDoc(
      'c1',
      `<h1>The Beginning</h1><p>First  chapter   text.</p><p>Second para.</p>`,
    ),
    'OEBPS/text/ch2.xhtml': xhtmlDoc(
      'c2',
      `<h2>Deep In</h2><p>More words.</p><img src="pic.png" alt="a picture"/>`,
    ),
    'OEBPS/images/cover.png': PNG_BYTES,
    'OEBPS/text/pic.png': PNG_BYTES,
  });

  it('extracts metadata, chapters in spine order, and the cover', async () => {
    const book = await parseEpub(await makeEpub(files()));
    expect(book.title).toBe('The Test Book');
    expect(book.author).toBe('Jane Coder');
    expect(book.language).toBe('en-GB');
    expect(book.chapters.length).toBe(2);
    expect(book.chapters[0]?.title).toBe('The Beginning');
    // The chapter's own <h1> is part of its body text — TTS announces it.
    expect(book.chapters[0]?.plainText).toBe(
      'The Beginning\n\nFirst chapter text.\n\nSecond para.',
    );
    expect(book.cover?.ext).toBe('png');
    expect(await book.cover?.blob.arrayBuffer()).toBeTruthy();
  });

  it('uses the heading when a TOC entry only targets a fragment', async () => {
    const book = await parseEpub(await makeEpub(files()));
    // ch2 has no fragment-less TOC entry; falls back to its first heading.
    expect(book.chapters[1]?.title).toBe('Deep In');
  });

  it('sanitizes chapter HTML: scripts gone, images kept with raw src', async () => {
    const messy = files();
    messy['OEBPS/text/ch2.xhtml'] = xhtmlDoc(
      'c2',
      `<p onclick="evil()">Safe</p><script>alert(1)</script>` +
        `<div style="color:red">Styled</div><img src="pic.png" onerror="evil()"/>`,
    );
    const book = await parseEpub(await makeEpub(messy));
    const html = book.chapters[1]!.html;
    expect(html).toContain('<p>Safe</p>');
    expect(html).toContain('<img src="pic.png">');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('style');
    expect(html).not.toContain('color:red');
  });

  it('rewrites internal links to data-rf-href and keeps external ones', async () => {
    const messy = files();
    messy['OEBPS/text/ch2.xhtml'] = xhtmlDoc(
      'c2',
      `<p><a href="ch1.xhtml#note">internal</a> and <a href="https://example.com">out</a></p>`,
    );
    const book = await parseEpub(await makeEpub(messy));
    const html = book.chapters[1]!.html;
    // Internal hrefs resolve to book-relative zip paths.
    expect(html).toContain('data-rf-href="OEBPS/text/ch1.xhtml#note"');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="ch1');
  });
});

describe('parseEpub — messy real-world shapes', () => {
  it('handles an EPUB 2 with NCX, OPF at root, missing creator, and a linear="no" item', async () => {
    const files = {
      'META-INF/container.xml': CONTAINER_XML.replace('OEBPS/content.opf', 'content.opf'),
      'content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Old Style</dc:title>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c3" linear="no"/>
    <itemref idref="c2"/>
  </spine>
</package>`,
      'toc.ncx': `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head/>
  <docTitle><text>Old Style</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel>
      <content src="chapter1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel>
      <content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`,
      'chapter1.xhtml': '<html><body><h1>Chapter One</h1><p>Hello.</p></body></html>',
      'chapter2.xhtml': '<html><body><p>Body two.</p></body></html>',
      'chapter3.xhtml': '<html><body><p>Skipped (linear no).</p></body></html>',
      'cover.jpg': PNG_BYTES,
    };
    const book = await parseEpub(await makeEpub(files));
    expect(book.author).toBeNull();
    expect(book.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    // The chapter's own <h1> is part of its body text, as in the EPUB 3 tests.
    expect(book.chapters[0]!.plainText).toBe('Chapter One\n\nHello.');
    expect(book.cover?.ext).toBe('jpg');
  });

  it('falls back to "Chapter N" titles when TOC and headings are absent', async () => {
    const files = {
      'META-INF/container.xml': CONTAINER_XML.replace('OEBPS/content.opf', 'content.opf'),
      'content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Untitled-ish</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="a.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="b.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
      'a.xhtml': '<html><body><p>One</p></body></html>',
      'b.xhtml': '<html><body><p>Two</p></body></html>',
    };
    const book = await parseEpub(await makeEpub(files));
    expect(book.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('resolves spine hrefs relative to a nested OPF directory', async () => {
    const files = {
      'META-INF/container.xml': CONTAINER_XML.replace(
        'OEBPS/content.opf',
        'books/deep/content.opf',
      ),
      'books/deep/content.opf': epub3Opf({
        title: 'Nested',
        manifest: `<item id="c1" href="../text/a.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/>`,
      }),
      'books/text/a.xhtml': '<html><body><p>Nested OPF.</p></body></html>',
    };
    const book = await parseEpub(await makeEpub(files));
    expect(book.chapters[0]!.plainText).toBe('Nested OPF.');
    expect(book.chapters[0]!.href).toBe('books/text/a.xhtml');
  });

  it('rejects a ZIP with no container.xml with a clear error', async () => {
    const bytes = await makeEpub({ 'random.txt': 'just a zip' });
    await expect(parseEpub(bytes)).rejects.toBeInstanceOf(BookParseError);
    await expect(parseEpub(bytes)).rejects.toThrow(/container\.xml/);
  });

  it('rejects non-zip bytes', async () => {
    const bytes = new TextEncoder().encode('this is definitely not a zip file at all');
    await expect(parseEpub(bytes)).rejects.toBeInstanceOf(BookParseError);
  });
});

describe('parseTxt', () => {
  it('splits on heading lines', () => {
    const raw = [
      'Once upon a time there was some opening prose.',
      '',
      'CHAPTER I',
      'The first chapter begins here.',
      '',
      'Chapter 2',
      'Another one starts.',
    ].join('\n');
    const book = parseTxt(raw);
    expect(book.chapters.length).toBe(3);
    expect(book.chapters[0]!.title).toBe('Chapter 1'); // no heading → fallback
    expect(book.chapters[1]!.title).toBe('CHAPTER I');
    expect(book.chapters[2]!.title).toBe('Chapter 2');
    expect(book.chapters[1]!.plainText).toBe('The first chapter begins here.');
  });

  it('splits on runs of three or more blank lines', () => {
    const raw = 'Part one text.\n\n\n\nPart two text.';
    const book = parseTxt(raw);
    expect(book.chapters.length).toBe(2);
    expect(book.chapters[0]!.plainText).toBe('Part one text.');
    expect(book.chapters[1]!.plainText).toBe('Part two text.');
  });

  it('produces a single chapter when nothing matches', () => {
    const raw = 'Just\nsome\nlines\nwithout\nstructure.';
    const book = parseTxt(raw);
    expect(book.chapters.length).toBe(1);
    expect(book.chapters[0]!.plainText).toBe('Just some lines without structure.');
  });

  it('normalizes like every other format (collapse whitespace, join blocks)', () => {
    const raw = 'First  para.\n\n\nSecond   para.';
    const book = parseTxt(raw);
    expect(book.chapters[0]!.plainText).toBe('First para.\n\nSecond para.');
  });

  it('splitTxtChapters keeps boundaries stable for Gutenberg-style files', () => {
    const raw = [
      'CHAPTER I.',
      '',
      'Content one.',
      '',
      '',
      'More of chapter one after blanks — no split, only 2 blanks.',
      '',
      '',
      '',
      'CHAPTER II.',
      'Content two.',
    ].join('\n');
    const chapters = splitTxtChapters(raw);
    expect(chapters.length).toBe(2);
  });
});
