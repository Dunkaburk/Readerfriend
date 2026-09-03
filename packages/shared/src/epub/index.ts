/**
 * EPUB parsing (§8). Pure functions over a Uint8Array; runs in the import
 * worker. Produces, per chapter: sanitized render HTML and normalized plain
 * text (via the same pipeline the renderer reproduces: sanitize → parse →
 * normalize), plus metadata and the cover image.
 *
 * Deliberately NOT epub.js — no iframe rendering, we control the DOM.
 */

import JSZip from 'jszip';
import { normalizeText, type MiniElement, type MiniNode } from '../text';
import { sanitizeToHtml } from '../sanitize';
import {
  allByLocalName,
  attr,
  elementLocalName,
  firstByLocalName,
  iterateElements,
  parseFragment,
  parseXmlDoc,
} from './dom';
import { resolveZipPath, zipDirOf, zipEntryText, zipLookup } from './zip';

export class BookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookParseError';
  }
}

export interface ParsedChapter {
  idx: number;
  title: string;
  /** Zip path of the source document, for debugging and resource resolution. */
  href: string | null;
  /** Sanitized HTML fragment, exactly as it will be rendered. */
  html: string;
  /** Normalized plain text — the chunking and highlight contract. */
  plainText: string;
}

export interface ParsedCover {
  blob: Blob;
  /** File extension for the R2 key: jpg | png | gif | svg | webp. */
  ext: string;
}

export interface ParsedBook {
  title: string;
  author: string | null;
  language: string | null;
  cover: ParsedCover | null;
  chapters: ParsedChapter[];
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
}

interface TocEntry {
  /** Zip path of the target document ('' for same-document fragments). */
  path: string;
  fragment: string | null;
  title: string;
}

const MEDIA_TYPE_EXTS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

function textContentTrimmed(el: MiniElement | null): string | null {
  if (!el) return null;
  let text = '';
  const collect = (node: MiniNode): void => {
    if (node.nodeType === 3) {
      if (node.nodeValue) text += node.nodeValue;
      return;
    }
    const children = node.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) collect(child);
    }
  };
  collect(el);
  text = text.replace(/\s+/g, ' ').trim();
  return text || null;
}

function firstDescendantText(root: MiniNode, local: string): string | null {
  const el = firstByLocalName(root, local);
  return el ? textContentTrimmed(el) : null;
}

function splitProperties(properties: string | null): string[] {
  return properties ? properties.split(/\s+/).filter(Boolean) : [];
}

async function buildToc(
  zip: JSZip,
  opfDir: string,
  manifestItems: ManifestItem[],
): Promise<TocEntry[]> {
  // EPUB 3 nav document first.
  const navItem = manifestItems.find((item) => item.properties.includes('nav'));
  if (navItem) {
    const navPath = resolveZipPath(opfDir, navItem.href);
    const entry = zipLookup(zip, navPath);
    if (entry) {
      const html = await zipEntryText(entry);
      const entries = extractNavToc(html, zipDirOf(navPath));
      if (entries.length > 0) return entries;
    }
  }
  // EPUB 2 NCX fallback, honouring spine@toc when present.
  const ncxItem = manifestItems.find((item) => item.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxPath = resolveZipPath(opfDir, ncxItem.href);
    const entry = zipLookup(zip, ncxPath);
    if (entry) {
      const xml = await zipEntryText(entry);
      return extractNcxToc(xml, zipDirOf(ncxPath));
    }
  }
  return [];
}

function extractNavToc(html: string, baseDir: string): TocEntry[] {
  const doc = parseFragment(html);
  const navs = allByLocalName(doc, 'nav');
  let nav: MiniElement | null = null;
  for (const candidate of navs) {
    const epubType = (attr(candidate, 'epub:type') ?? '').split(/\s+/);
    if (epubType.includes('toc')) {
      nav = candidate;
      break;
    }
  }
  if (!nav) {
    // Some EPUB 3s omit the semantic attribute; the first nav with a list wins.
    for (const candidate of navs) {
      if (firstByLocalName(candidate, 'ol')) {
        nav = candidate;
        break;
      }
    }
  }
  if (!nav) return [];
  const entries: TocEntry[] = [];
  for (const a of allByLocalName(nav, 'a')) {
    const href = attr(a, 'href');
    const title = textContentTrimmed(a);
    if (!href || !title) continue;
    const [rawPath, rawFragment] = splitRawHref(href);
    entries.push({
      path: rawPath ? resolveZipPath(baseDir, rawPath) : '',
      fragment: rawFragment,
      title,
    });
  }
  return entries;
}

function extractNcxToc(xml: string, baseDir: string): TocEntry[] {
  let doc: MiniNode;
  try {
    doc = parseXmlDoc(xml);
  } catch {
    return [];
  }
  const entries: TocEntry[] = [];
  for (const point of allByLocalName(doc, 'navPoint')) {
    const label = firstByLocalName(point, 'navLabel');
    const title = label ? firstDescendantText(label, 'text') : null;
    const content = firstByLocalName(point, 'content');
    const href = content ? attr(content, 'src') : null;
    if (!href || !title) continue;
    const [rawPath, rawFragment] = splitRawHref(href);
    entries.push({
      path: rawPath ? resolveZipPath(baseDir, rawPath) : '',
      fragment: rawFragment,
      title,
    });
  }
  return entries;
}

function splitRawHref(href: string): [string, string | null] {
  const hashIdx = href.indexOf('#');
  return hashIdx === -1 ? [href, null] : [href.slice(0, hashIdx), href.slice(hashIdx + 1)];
}

/**
 * Resolve an internal link to a "zipPath#fragment" target stored in
 * data-rf-href. Fragment-only links stay fragment-only.
 */
export function resolveInternalLink(rawHref: string, chapterDir: string): string {
  const trimmed = rawHref.trim();
  if (trimmed.startsWith('#')) return trimmed;
  const hashIdx = trimmed.indexOf('#');
  const rawPath = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? null : trimmed.slice(hashIdx + 1);
  const path = resolveZipPath(chapterDir, rawPath);
  return fragment ? `${path}#${fragment}` : path;
}

function extForMediaType(mediaType: string, href: string): string {
  const known = MEDIA_TYPE_EXTS[mediaType.toLowerCase()];
  if (known) return known;
  const match = /\.([a-z0-9]+)$/i.exec(href);
  return match ? match[1]!.toLowerCase() : 'jpg';
}

async function extractCover(
  zip: JSZip,
  opfDir: string,
  opfDoc: MiniNode,
  manifestItems: ManifestItem[],
  firstChapterHtml: string | null,
  firstChapterDir: string,
): Promise<ParsedCover | null> {
  let item: ManifestItem | undefined;

  // 1. EPUB 3: manifest item with properties ~= "cover-image".
  item = manifestItems.find((it) => it.properties.includes('cover-image'));

  // 2. EPUB 2: <meta name="cover" content="manifest-id">.
  if (!item) {
    for (const meta of allByLocalName(opfDoc, 'meta')) {
      if (attr(meta, 'name') === 'cover') {
        const id = attr(meta, 'content');
        if (id) {
          item = manifestItems.find((it) => it.id === id);
          break;
        }
      }
    }
  }

  let href: string | null = item?.href ?? null;
  let mediaType: string | undefined = item?.mediaType;

  // 3. Fallback: the first image in the first spine document.
  if (!href && firstChapterHtml) {
    const doc = parseFragment(firstChapterHtml);
    for (const el of iterateElements(doc)) {
      if (elementLocalName(el) !== 'img') continue;
      const src = attr(el, 'src');
      if (!src) continue;
      href = resolveZipPath(firstChapterDir, src.split('#')[0] ?? src);
      mediaType = undefined;
      break;
    }
  }

  if (!href) return null;
  const path = resolveZipPath(opfDir, href);
  const entry = zipLookup(zip, path);
  if (!entry) return null;
  const bytes = await entry.async('uint8array');
  if (bytes.length === 0) return null;
  const ext = mediaType ? extForMediaType(mediaType, href) : extForMediaType('application/octet-stream', href);
  const type = MEDIA_TYPE_EXT_BY_EXT[ext] ?? 'image/jpeg';
  // Copy into a standalone Uint8Array: JSZip's buffer is pooled, and naming
  // the BlobPart type here would tie this module to the DOM lib.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return { blob: new Blob([copy], { type }), ext };
}

const MEDIA_TYPE_EXT_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function resolveChapterTitles(
  chapters: Array<{ href: string | null }>,
  toc: TocEntry[],
): Array<string | null> {
  const titles: Array<string | null> = chapters.map(() => null);
  // Only fragment-less TOC entries name chapters: an entry targeting
  // "ch2.xhtml#mid" is a section inside the chapter, not its title. Chapters
  // no top-level entry names fall back to their first heading, then "Chapter N".
  for (const entry of toc) {
    if (entry.fragment !== null || entry.path === '') continue;
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i]!;
      if (titles[i]) continue;
      if (chapter.href && chapter.href === entry.path) titles[i] = entry.title;
    }
  }
  return titles;
}

/** Parse an EPUB file. Throws BookParseError with a user-presentable message. */
export async function parseEpub(bytes: Uint8Array): Promise<ParsedBook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new BookParseError('This file is not a valid EPUB (it is not a ZIP archive).');
  }

  const containerEntry = zipLookup(zip, 'META-INF/container.xml');
  if (!containerEntry) {
    throw new BookParseError(
      'This file has a .epub extension but no EPUB structure (META-INF/container.xml is missing).',
    );
  }
  const containerXml = await zipEntryText(containerEntry);
  let containerDoc: MiniNode;
  try {
    containerDoc = parseXmlDoc(containerXml);
  } catch {
    throw new BookParseError('EPUB container.xml is malformed.');
  }

  let opfPath: string | null = null;
  for (const rootfile of allByLocalName(containerDoc, 'rootfile')) {
    const fullPath = attr(rootfile, 'full-path');
    if (!fullPath) continue;
    if (zipLookup(zip, fullPath)) {
      opfPath = fullPath;
      break;
    }
    opfPath ??= fullPath;
  }
  if (!opfPath) throw new BookParseError('EPUB lists no root file (OPF) in container.xml.');
  const opfEntry = zipLookup(zip, opfPath);
  if (!opfEntry) throw new BookParseError(`EPUB package file "${opfPath}" is missing from the archive.`);

  const opfDoc = parseXmlDoc(await zipEntryText(opfEntry));
  const opfDir = zipDirOf(opfPath);

  const metadataEl = firstByLocalName(opfDoc, 'metadata');
  const title = (metadataEl && firstDescendantText(metadataEl, 'title')) ?? null;
  if (!title) throw new BookParseError('EPUB has no dc:title.');
  const author = (metadataEl && firstDescendantText(metadataEl, 'creator')) ?? null;
  const language = (metadataEl && firstDescendantText(metadataEl, 'language')) ?? null;

  const manifestEl = firstByLocalName(opfDoc, 'manifest');
  if (!manifestEl) throw new BookParseError('EPUB has no manifest.');
  const manifestItems: ManifestItem[] = [];
  for (const item of allByLocalName(manifestEl, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    manifestItems.push({
      id,
      href,
      mediaType: attr(item, 'media-type') ?? '',
      properties: splitProperties(attr(item, 'properties')),
    });
  }
  const byId = new Map(manifestItems.map((it) => [it.id, it]));

  const spineEl = firstByLocalName(opfDoc, 'spine');
  const itemrefs = spineEl ? allByLocalName(spineEl, 'itemref') : [];

  // First pass: chapter documents (href + raw text).
  interface RawChapter {
    href: string;
    text: string;
  }
  const rawChapters: RawChapter[] = [];
  for (const itemref of itemrefs) {
    if (attr(itemref, 'linear') === 'no') continue;
    const idref = attr(itemref, 'idref');
    if (!idref) continue;
    const item = byId.get(idref);
    if (!item || !/xhtml|html/i.test(item.mediaType)) continue;
    const path = resolveZipPath(opfDir, item.href);
    const entry = zipLookup(zip, path);
    if (!entry) continue;
    rawChapters.push({ href: path, text: await zipEntryText(entry) });
  }
  if (rawChapters.length === 0) {
    throw new BookParseError('EPUB contains no readable chapter documents.');
  }

  const toc = await buildToc(zip, opfDir, manifestItems);
  const tocTitles = resolveChapterTitles(rawChapters, toc);

  const chapters: ParsedChapter[] = [];
  for (let i = 0; i < rawChapters.length; i++) {
    const raw = rawChapters[i]!;
    const doc = parseFragment(raw.text);
    const chapterDir = zipDirOf(raw.href);
    const html = sanitizeToHtml(doc, {
      resolveLink: (rawHref) => resolveInternalLink(rawHref, chapterDir),
    });
    const plainText = normalizeText(parseFragment(html));
    const headingTitle = firstHeadingFromDoc(doc);
    const title = tocTitles[i] ?? headingTitle ?? `Chapter ${i + 1}`;
    chapters.push({ idx: i, title, href: raw.href, html, plainText });
  }

  const cover = await extractCover(
    zip,
    opfDir,
    opfDoc,
    manifestItems,
    chapters[0] ? chapters[0].html : null,
    chapters[0]?.href ? zipDirOf(chapters[0].href) : '',
  );

  return { title, author, language, cover, chapters };
}

function firstHeadingFromDoc(doc: MiniNode): string | null {
  for (const el of iterateElements(doc)) {
    if (/^H[1-3]$/.test(el.nodeName.toUpperCase())) {
      return textContentTrimmed(el);
    }
  }
  return null;
}

export { firstHeadingFromDoc };
export { parseTxt, splitTxtChapters } from './txt';
export { resolveZipPath, zipDirOf, zipEntryText, zipLookup, splitHref } from './zip';
