/**
 * Web implementation of BlobStore: IndexedDB via Dexie. Persistent storage is
 * requested once at startup (main.tsx) so the browser does not evict
 * hundreds of megabytes of audio (§6.3).
 */

import { db } from '../db/dexie';
import type { BlobStore } from './blobStore';

export const dexieBlobStore = {
  async put(key: string, data: Blob): Promise<void> {
    await db.blobs.put({ key, blob: data, size: data.size, createdAt: Date.now() });
  },

  async get(key: string): Promise<Blob | null> {
    const row = await db.blobs.get(key);
    return row?.blob ?? null;
  },

  async has(key: string): Promise<boolean> {
    const row = await db.blobs.get(key);
    return row !== undefined;
  },

  async delete(key: string): Promise<void> {
    await db.blobs.delete(key);
  },

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    await db.blobs.each(({ key }) => {
      if (key.startsWith(prefix)) keys.push(key);
    });
    return keys.sort();
  },

  async usage(): Promise<{ bytes: number; count: number }> {
    // navigator.storage.estimate() covers the whole origin quota cheaply;
    // fall back to summing blob rows if it is unavailable.
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === 'number') {
        const count = await db.blobs.count();
        return { bytes: est.usage, count };
      }
    }
    let bytes = 0;
    let count = 0;
    await db.blobs.each((row) => {
      bytes += row.size;
      count += 1;
    });
    return { bytes, count };
  },
} satisfies import('./blobStore').BlobStore;

export const blobStore = dexieBlobStore;
