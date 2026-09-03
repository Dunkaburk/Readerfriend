/**
 * Builds a small valid EPUB fixture for manual/E2E testing and writes it to
 * tmp/smoke-book.epub. Run: node scripts/make-fixture-epub.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// jszip resolves from the shared package (pnpm workspace does not hoist to root).
const jszipUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'shared', 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
);
const { default: JSZip } = await import(jszipUrl.href);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const paragraphs = (n) =>
  Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1} of chapter text. The quick brown fox jumps over the lazy dog while the rain in Spain falls mainly on the plain, and the quick brown fox keeps jumping.</p>`).join('\n');

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>TOC</title></head>
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="ch1.xhtml">The Beginning</a></li>
        <li><a href="ch2.xhtml">The End</a></li>
      </ol>
    </nav>
  </body>
</html>`;

const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:smoke-book</dc:identifier>
    <dc:title>The Smoke Test Book</dc:title>
    <dc:creator>Ada Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const chapter = (title, n) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    ${paragraphs(n)}
  </body>
</html>`;

// 1x1 red PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC',
  'base64',
);

const zip = new JSZip();
zip.file('mimetype', 'application/epub+zip');
zip.file('META-INF/container.xml', container);
zip.file('OEBPS/content.opf', opf);
zip.file('OEBPS/nav.xhtml', nav);
zip.file('OEBPS/style.css', 'body { font-family: serif; }');
zip.file('OEBPS/ch1.xhtml', chapter('The Beginning', 8));
zip.file('OEBPS/ch2.xhtml', chapter('The End', 5));
zip.file('OEBPS/cover.png', png);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'smoke-book.epub');
mkdirSync(dirname(out), { recursive: true });
const bytes = await zip.generateAsync({ type: 'nodebuffer' });
writeFileSync(out, bytes);
console.log(`Wrote ${out} (${bytes.length} bytes)`);
