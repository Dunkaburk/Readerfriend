/**
 * Typed fetch wrapper for the Worker API (§5). Adds the bearer token from the
 * settings store; never logs it. Audio responses stream — callers get the
 * raw Response.
 */

import type {
  AppSettings,
  ChunkListResponse,
  CreateBookRequest,
  LibraryResponse,
  ModelsResponse,
} from '@readerfriend/shared';
import { API_BASE } from '../config';
import { useSettingsStore } from '../state/settings';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function authHeader(): Record<string, string> {
  const token = useSettingsStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { ...authHeader(), ...(init?.headers ?? {}) },
  });
  return res;
}

/** Read an error response into an ApiError without leaking anything. */
export async function toApiError(res: Response): Promise<ApiError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) detail = body.error;
  } catch {
    // Non-JSON body — fall back to the status line.
  }
  const retryAfter = res.headers.get('Retry-After');
  const retryAfterMs = retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
  return new ApiError(detail || `Request failed (${res.status})`, res.status, retryAfterMs);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export const api = {
  health(): Promise<boolean> {
    return request('/api/health').then((r) => r.ok);
  },

  getLibrary(since = 0): Promise<LibraryResponse> {
    return requestJson(`/api/library?since=${encodeURIComponent(since)}`);
  },

  createBook(body: CreateBookRequest): Promise<200 | 201> {
    return request('/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (r.status === 201 || r.status === 200) return r.status;
      throw await toApiError(r);
    });
  },

  putSource(bookId: string, ext: string, blob: Blob): Promise<void> {
    return request(`/api/books/${bookId}/source?ext=${encodeURIComponent(ext)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }).then(async (r) => {
      if (!r.ok) throw await toApiError(r);
    });
  },

  putCover(bookId: string, ext: string, blob: Blob): Promise<void> {
    return request(`/api/books/${bookId}/cover?ext=${encodeURIComponent(ext)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }).then(async (r) => {
      if (!r.ok) throw await toApiError(r);
    });
  },

  deleteBook(bookId: string): Promise<void> {
    return request(`/api/books/${bookId}`, { method: 'DELETE' }).then(async (r) => {
      if (!r.ok) throw await toApiError(r);
    });
  },

  /** Download a book's original file (second-device hydration, §6.4). */
  async getSource(bookId: string): Promise<Blob> {
    const r = await request(`/api/books/${bookId}/source`);
    if (!r.ok) throw await toApiError(r);
    return r.blob();
  },

  /** Download a book's cover image (second-device hydration, §6.4). */
  async getCover(bookId: string): Promise<Blob> {
    const r = await request(`/api/books/${bookId}/cover`);
    if (!r.ok) throw await toApiError(r);
    return r.blob();
  },

  getChunks(bookId: string, chapterIdx: number): Promise<ChunkListResponse> {
    return requestJson(`/api/books/${bookId}/chapters/${chapterIdx}/chunks`);
  },

  /** Generate (or cache-fetch) one chunk's audio. Streams the raw bytes. */
  generateAudio(
    bookId: string,
    chapterIdx: number,
    chunkIdx: number,
    opts: { model?: string | null; voice?: string | null } = {},
  ): Promise<Response> {
    return request(`/api/books/${bookId}/chapters/${chapterIdx}/chunks/${chunkIdx}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? undefined,
        voice: opts.voice ?? undefined,
      }),
    });
  },

  getCachedAudio(bookId: string, chapterIdx: number, chunkIdx: number): Promise<Response> {
    return request(`/api/books/${bookId}/chapters/${chapterIdx}/chunks/${chunkIdx}/audio`);
  },

  putProgress(
    bookId: string,
    update: { chapterIdx: number; charOffset: number; chunkIdx: number | null; audioPositionMs: number | null },
  ): Promise<void> {
    return request(`/api/progress/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    }).then(async (r) => {
      if (!r.ok) throw await toApiError(r);
    });
  },

  getSettings(): Promise<{ settings: AppSettings }> {
    return requestJson('/api/settings');
  },

  putSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings }> {
    return requestJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  getModels(): Promise<ModelsResponse> {
    return requestJson('/api/tts/models');
  },
};
