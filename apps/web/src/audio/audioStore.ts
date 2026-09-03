/**
 * Chunk audio resolution (§6.4): local blob store first, then the server —
 * a cached GET when the chunk row says audio exists, a generating POST when
 * it does not — and cache whatever arrives locally. Audio is never synced
 * eagerly; it is fetched when played (or prefetched by the generation queue).
 */

import { r2Keys } from '@readerfriend/shared';
import { blobStore } from '../adapters/blobStore.dexie';
import { db } from '../db/dexie';
import { api, ApiError, toApiError } from '../api/client';
import { useSettingsStore } from '../state/settings';

export class ChunkNotGeneratedError extends Error {
  constructor() {
    super('Chunk has no audio yet');
    this.name = 'ChunkNotGeneratedError';
  }
}

function localKey(bookId: string, chapterIdx: number, chunkIdx: number): string {
  return r2Keys.audio(bookId, chapterIdx, chunkIdx);
}

/** The locally cached audio for a chunk, if any. */
export function getCachedChunkAudio(bookId: string, chapterIdx: number, chunkIdx: number): Promise<Blob | null> {
  return blobStore.get(localKey(bookId, chapterIdx, chunkIdx));
}

export async function putCachedChunkAudio(
  bookId: string,
  chapterIdx: number,
  chunkIdx: number,
  blob: Blob,
): Promise<void> {
  await blobStore.put(localKey(bookId, chapterIdx, chunkIdx), blob);
}

export async function dropCachedChunkAudio(bookId: string, chapterIdx?: number): Promise<void> {
  const prefix =
    chapterIdx === undefined
      ? r2Keys.bookPrefix(bookId) + 'audio/'
      : `${r2Keys.bookPrefix(bookId)}audio/${chapterIdx}/`;
  for (const key of await blobStore.list(prefix)) {
    await blobStore.delete(key);
  }
}

export type AudioOrigin = 'local' | 'server-cache' | 'generated';

/**
 * Resolve one chunk's audio per §6.4: local blob → GET (audio_key set) →
 * POST (generate). Throws ChunkNotGeneratedError only when the caller asked
 * not to generate and the server has nothing cached.
 */
export async function resolveChunkAudio(
  bookId: string,
  chapterIdx: number,
  chunkIdx: number,
  opts: { generate: boolean } = { generate: true },
): Promise<{ blob: Blob; origin: AudioOrigin }> {
  const key = localKey(bookId, chapterIdx, chunkIdx);

  const local = await blobStore.get(key);
  if (local) return { blob: local, origin: 'local' };

  // The chunk row's audio_key may be stale, so treat a 404 as "try generate".
  const row = await db.chunks.get([bookId, chapterIdx, chunkIdx]);
  if (row?.audioKey) {
    try {
      const r = await api.getCachedAudio(bookId, chapterIdx, chunkIdx);
      if (r.ok) {
        const blob = await r.blob();
        await blobStore.put(key, blob);
        return { blob, origin: 'server-cache' };
      }
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }

  if (!opts.generate) throw new ChunkNotGeneratedError();
  return { blob: await generateAndCache(bookId, chapterIdx, chunkIdx), origin: 'generated' };
}

/**
 * Generate one chunk (POST) and cache the bytes. The caller (generation
 * queue) owns rate limiting and the daily request count.
 */
export async function generateAndCache(
  bookId: string,
  chapterIdx: number,
  chunkIdx: number,
): Promise<Blob> {
  // Send the configured model/voice explicitly: the Worker also falls back to
  // its synced settings copy, but that may still be in the debounce window.
  const { model, voice } = useSettingsStore.getState().settings;
  const r = await api.generateAudio(bookId, chapterIdx, chunkIdx, { model, voice });
  if (r.status === 404) {
    // Unknown book/chunk, or the model produced nothing — not retryable here.
    throw new ChunkNotGeneratedError();
  }
  if (!r.ok) throw await toApiError(r);
  const blob = await r.blob();
  await blobStore.put(localKey(bookId, chapterIdx, chunkIdx), blob);
  // Mirror the server's generation state into the local chunk row so the
  // reader knows this chunk no longer needs generation.
  const key = r2Keys.audio(bookId, chapterIdx, chunkIdx);
  await db.chunks.update([bookId, chapterIdx, chunkIdx], {
    audioKey: key,
    bytes: blob.size,
    createdAt: Date.now(),
  });
  return blob;
}
