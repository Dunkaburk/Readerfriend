/**
 * Chapter resource resolution: <img src> in sanitized HTML keeps the EPUB's
 * zip-relative path, so the reader loads the bytes from the locally stored
 * source file and swaps in object URLs (session-cached per book).
 */

import JSZip from 'jszip';
import { resolveZipPath, zipDirOf } from '@readerfriend/shared/epub';
import { blobStore } from '../adapters/blobStore.dexie';

const EXT_TO_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

let zipCache: { bookId: string; zip: JSZip } | null = null;
const urlCache = new Map<string, string>();

async function getZip(bookId: string, sourceKey: string): Promise<JSZip | null> {
  if (zipCache?.bookId === bookId) return zipCache.zip;
  const blob = await blobStore.get(sourceKey);
  if (!blob) return null;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  zipCache = { bookId, zip };
  return zip;
}

export function dropResourceCache(bookId: string | null): void {
  if (zipCache?.bookId === bookId || bookId === null) zipCache = null;
  for (const [key, url] of urlCache) {
    if (bookId === null || key.startsWith(`${bookId}::`)) {
      URL.revokeObjectURL(url);
      urlCache.delete(key);
    }
  }
}

/**
 * Rewrite every <img> in the rendered chapter to an object URL from the
 * source EPUB. Safe to call repeatedly; already-resolved images are skipped.
 */
export async function resolveChapterImages(
  bookId: string,
  sourceKey: string,
  chapterHref: string | null,
  root: HTMLElement,
): Promise<void> {
  const images = Array.from(root.querySelectorAll('img[src]'));
  if (images.length === 0) return;
  const zip = await getZip(bookId, sourceKey);
  if (!zip) return;
  const dir = chapterHref ? zipDirOf(chapterHref) : '';

  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) return;
      const zipPath = resolveZipPath(dir, src.split('#')[0] ?? src);
      const key = `${bookId}::${zipPath}`;
      let url = urlCache.get(key);
      if (!url) {
        const entry = zip.file(zipPath);
        if (!entry) return;
        const bytes = await entry.async('uint8array');
        const ext = zipPath.split('.').pop()?.toLowerCase() ?? '';
        // Copy into a plain ArrayBuffer: TS's BlobPart rejects the
        // SharedArrayBuffer-compatible view JSZip returns.
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        url = URL.createObjectURL(new Blob([copy], { type: EXT_TO_TYPE[ext] ?? 'application/octet-stream' }));
        urlCache.set(key, url);
      }
      img.setAttribute('src', url);
    }),
  );
}
