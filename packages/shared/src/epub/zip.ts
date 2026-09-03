/**
 * Zip path helpers for EPUB href resolution.
 *
 * EPUB hrefs are relative to the OPF's directory; zip entry names are
 * percent-encoded by spec but real-world files are inconsistent, so lookups
 * try exact, decoded, and case-insensitive matches before giving up.
 */

import type JSZip from 'jszip';

/** Resolve `href` relative to `baseDir` (a zip directory or ''), returning a
 * normalized zip path without a leading slash. */
export function resolveZipPath(baseDir: string, href: string): string {
  // Strip fragment; query strings do not occur in EPUB hrefs.
  const [pathPart] = href.split('#');
  const raw = pathPart ?? '';
  if (raw.startsWith('/')) return normalizeZipPath(raw.slice(1));
  const segments: string[] = [];
  const base = baseDir.split('/').filter(Boolean);
  for (const part of [...base, ...raw.split('/')]) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

function normalizeZipPath(p: string): string {
  const segments: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

/** Directory part of a zip path ('' when there is none). */
export function zipDirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function tryKeys(zip: JSZip, ...candidates: string[]): JSZip.JSZipObject | null {
  for (const key of candidates) {
    const entry = zip.files[key];
    if (entry && !entry.dir) return entry;
  }
  return null;
}

/** Look up a zip entry by path, tolerating percent-encoding and case drift. */
export function zipLookup(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const exact = tryKeys(zip, path);
  if (exact) return exact;
  let decoded: string | null = null;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = null;
  }
  if (decoded && decoded !== path) {
    const viaDecoded = tryKeys(zip, decoded);
    if (viaDecoded) return viaDecoded;
  }
  // Case-insensitive scan.
  const target = (decoded ?? path).toLowerCase();
  for (const key of Object.keys(zip.files)) {
    if (key.toLowerCase() === target) {
      const entry = zip.files[key];
      if (entry && !entry.dir) return entry;
    }
  }
  return null;
}

/** Read a zip entry as text, honouring UTF-16 BOMs (rare but real). */
export async function zipEntryText(entry: JSZip.JSZipObject): Promise<string> {
  const bytes = await entry.async('uint8array');
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Strip the fragment from an href, percent-decoding the path part. */
export function splitHref(href: string): { path: string; fragment: string | null } {
  const hashIdx = href.indexOf('#');
  const rawPath = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? null : href.slice(hashIdx + 1);
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // keep raw
  }
  return { path, fragment };
}
