/**
 * Reader data contract (§7, §9.4): a book imported through the same parse +
 * chunk path the import worker uses must be readable from the local mirror:
 * the stored plainText equals the normalized rendered text (the §13 trap-2
 * invariant, exercised end-to-end through Dexie), chunks tile each chapter,
 * and a saved progress offset resolves to a DOM point and a chunk for
 * restore.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
// parseEpub lives in the epub subpath (linkedom stays out of the main entry).
import { parseEpub } from '@readerfriend/shared/epub';
import { planChapterChunks, r2Keys } from '@readerfriend/shared';
import { db, type StoredBook, type StoredChunk } from '../src/db/dexie';
import { loadChapter } from '../src/reader/useReaderData';
import { chunkIndexForOffset, mapOffsets, pointForOffset, textOf } from '../src/reader/offsets';

const BOOK_ID = '11111111-2222-3333-4444-555555555555';

async function buildEpubBytes(): Promise<Uint8Array> {
  const chapter = (title: string, paras: number) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    ${Array.from(
      { length: paras },
      (_, i) =>
        `<p>Paragraph ${i + 1} of ${title}. The quick brown fox jumps over the lazy dog
         while the rain&nbsp;in Spain falls mainly on the plain &amp; the fox keeps running.</p>`,
    ).join('\n')}
  </body>
</html>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:reader-data-test</dc:identifier>
    <dc:title>Reader Data Test</dc:title>
    <dc:creator>Ada Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`,
  );
  zip.file('OEBPS/ch1.xhtml', chapter('One', 12));
  zip.file('OEBPS/ch2.xhtml', chapter('Two', 6));
  return zip.generateAsync({ type: 'uint8array' });
}

/** Seed Dexie exactly the way importService + the import worker do. */
async function seedBook(): Promise<void> {
  const parsed = await parseEpub(await buildEpubBytes());
  const charCount = parsed.chapters.reduce((n, c) => n + c.plainText.length, 0);
  const book: StoredBook = {
    id: BOOK_ID,
    title: parsed.title,
    author: parsed.author ?? null,
    language: parsed.language ?? null,
    sourceFormat: 'epub',
    sourceKey: r2Keys.source(BOOK_ID, 'epub'),
    coverKey: null,
    charCount,
    chapterCount: parsed.chapters.length,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    pendingSync: 0,
  };
  await db.books.put(book);
  for (const ch of parsed.chapters) {
    await db.chapters.put({ ...ch, bookId: BOOK_ID });
    await db.chapterContent.put({ bookId: BOOK_ID, idx: ch.idx, html: ch.html, plainText: ch.plainText });
    const plans = planChapterChunks(ch.plainText, parsed.language ?? undefined);
    const rows: StoredChunk[] = plans.map((c, chunkIdx) => ({
      ...c,
      chunkIdx,
      chapterIdx: ch.idx,
      bookId: BOOK_ID,
    }));
    await db.chunks.bulkPut(rows);
  }
}

describe('reader data (local mirror → offset map)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('loads a chapter and its chunk plan through loadChapter', async () => {
    await seedBook();
    const { content, chunks } = await loadChapter(BOOK_ID, 1);
    expect(content).not.toBeNull();
    expect(content!.idx).toBe(1);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.chunkIdx).toBe(0);
    expect(chunks[chunks.length - 1]!.text.length).toBeGreaterThan(0);
  });

  it('maps every stored chapter exactly: plainText === normalized rendered text', async () => {
    await seedBook();
    const chapters = await db.chapters.where('bookId').equals(BOOK_ID).sortBy('idx');
    for (const meta of chapters) {
      const { content } = await loadChapter(BOOK_ID, meta.idx);
      const root = document.createElement('div');
      root.innerHTML = content!.html;
      document.body.appendChild(root);
      try {
        expect(textOf(root), `chapter ${meta.idx}`).toBe(content!.plainText);
        const segments = mapOffsets(root);
        expect(segments.length).toBeGreaterThan(0);
      } finally {
        root.remove();
      }
    }
  });

  it('chunks tile each chapter and any progress offset restores into a chunk', async () => {
    await seedBook();
    const chapters = await db.chapters.where('bookId').equals(BOOK_ID).sortBy('idx');
    for (const meta of chapters) {
      const { content, chunks } = await loadChapter(BOOK_ID, meta.idx);
      const textLen = content!.plainText.length;
      expect(chunks[0]!.charStart).toBe(0);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.charStart).toBe(chunks[i - 1]!.charEnd);
      }
      expect(chunks[chunks.length - 1]!.charEnd).toBe(textLen);

      // Saved progress at a few offsets: restore must find chunk + DOM point.
      for (const offset of [0, Math.floor(textLen / 3), Math.floor((2 * textLen) / 3)]) {
        const chunkIdx = chunkIndexForOffset(chunks, offset);
        expect(chunkIdx, `chapter ${meta.idx} offset ${offset}`).not.toBeNull();
        const root = document.createElement('div');
        root.innerHTML = content!.html;
        try {
          const segments = mapOffsets(root);
          expect(pointForOffset(segments, offset), `chapter ${meta.idx} offset ${offset}`).not.toBeNull();
        } finally {
          root.remove();
        }
      }
    }
  });

  it('persists and reads back progress for restore', async () => {
    await seedBook();
    await db.progress.put({
      bookId: BOOK_ID,
      chapterIdx: 1,
      charOffset: 123,
      chunkIdx: 0,
      audioPositionMs: null,
      updatedAt: Date.now(),
    });
    const progress = await db.progress.get(BOOK_ID);
    expect(progress).toMatchObject({ chapterIdx: 1, charOffset: 123, chunkIdx: 0 });
  });
});
