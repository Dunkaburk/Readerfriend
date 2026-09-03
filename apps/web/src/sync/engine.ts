/**
 * Sync engine (§6.4). One user, so merging is simple:
 *
 * - Pull: `GET /api/library?since=<watermark>` merges book metadata (including
 *   soft-deleted rows) and reading progress into the local mirror; `serverTime`
 *   becomes the new watermark. Books synced this way are metadata-only until
 *   the reader hydrates their content (see sync/hydrate.ts).
 * - Progress: last-write-wins on `updated_at`, no conflict UI.
 * - Settings: the local store is authoritative while it has unsynced edits;
 *   otherwise the server copy wins. Pushes are debounced and echo-guarded.
 *
 * Triggers: app start, regaining connectivity, window focus, and the manual
 * "Sync now" action in Settings.
 */

import { create } from 'zustand';
import { r2Keys } from '@readerfriend/shared';
import type { Book, Progress } from '@readerfriend/shared';
import { api } from '../api/client';
import { blobStore } from '../adapters/blobStore.dexie';
import { db } from '../db/dexie';
import { useSettingsStore } from '../state/settings';
import { useLibraryStore } from '../state/library';
import { flushOutbox } from './outbox';

const WATERMARK_KEY = 'sync.watermark';
const LAST_PULL_KEY = 'sync.lastPullAt';

interface SyncStatus {
  online: boolean;
  pulling: boolean;
  lastPullAt: number | null;
  lastError: string | null;
}

/** Live sync state for the Settings/Library UI. */
export const useSyncStatus = create<SyncStatus>()(() => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pulling: false,
  lastPullAt: null,
  lastError: null,
}));

function setSync(patch: Partial<SyncStatus>): void {
  useSyncStatus.setState(patch);
}

async function getKvNumber(key: string): Promise<number> {
  const row = await db.kv.get(key);
  return typeof row?.value === 'number' ? row.value : 0;
}

/** Remove every local trace of a book the server has soft-deleted. */
async function applyServerDelete(bookId: string): Promise<void> {
  for (const key of await blobStore.list(r2Keys.bookPrefix(bookId))) {
    await blobStore.delete(key);
  }
  await db.transaction('rw', db.books, db.chapters, db.chapterContent, db.chunks, db.progress, async () => {
    await db.books.delete(bookId);
    await db.chapters.where('bookId').equals(bookId).delete();
    await db.chapterContent.where('bookId').equals(bookId).delete();
    await db.chunks.where('bookId').equals(bookId).delete();
    await db.progress.delete(bookId);
  });
  // Pending uploads are moot once another device deleted the book.
  const entries = await db.outbox.where('bookId').equals(bookId).toArray();
  await db.outbox.bulkDelete(entries.map((e) => e.id!).filter((id) => Number.isInteger(id)));
}

/**
 * Pull library + progress changes since the watermark and merge them into
 * the local mirror. Throws on network/auth failure so callers can show it.
 */
export async function pullLibrary(): Promise<{ merged: number; deleted: number }> {
  const since = await getKvNumber(WATERMARK_KEY);
  const res = await api.getLibrary(since);

  let merged = 0;
  let deleted = 0;
  for (const serverBook of res.books) {
    if (serverBook.deletedAt !== null) {
      const existed = (await db.books.get(serverBook.id)) !== undefined;
      await applyServerDelete(serverBook.id);
      if (existed) deleted += 1;
      continue;
    }
    await upsertServerBook(serverBook);
    merged += 1;
  }

  for (const p of res.progress) {
    await mergeServerProgress(p);
  }

  await db.kv.put({ key: WATERMARK_KEY, value: res.serverTime });
  await db.kv.put({ key: LAST_PULL_KEY, value: Date.now() });
  setSync({ lastPullAt: Date.now(), lastError: null });

  // Keep a visible library grid current after a background merge.
  await useLibraryStore.getState().refresh();
  return { merged, deleted };
}

async function upsertServerBook(serverBook: Book): Promise<void> {
  const existing = await db.books.get(serverBook.id);
  // Any book the server knows about has been created (create is idempotent
  // and rebuilds partial creates), so its upload is confirmed.
  await db.books.put({ ...serverBook, pendingSync: 0 });
  if (existing?.pendingSync === 1) await settlePendingAfterSync(serverBook.id);

  // Cover: fetch once so the library grid shows the real cover everywhere.
  if (serverBook.coverKey && !(await blobStore.has(serverBook.coverKey))) {
    try {
      const blob = await api.getCover(serverBook.id);
      await blobStore.put(serverBook.coverKey, blob);
    } catch {
      // Cover is cosmetic — the placeholder covers a miss.
    }
  }
}

async function settlePendingAfterSync(bookId: string): Promise<void> {
  const remaining = await db.outbox.where('bookId').equals(bookId).count();
  if (remaining === 0) await db.books.update(bookId, { pendingSync: 0 });
}

async function mergeServerProgress(server: Progress): Promise<void> {
  const local = await db.progress.get(server.bookId);
  if (!local || server.updatedAt > local.updatedAt) {
    await db.progress.put(server);
  }
}

// --- settings sync ---

let lastSyncedSettings: string | null = null;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function snapshotOf(settings: unknown): string {
  return JSON.stringify(settings);
}

async function pushSettings(): Promise<void> {
  const { settings } = useSettingsStore.getState();
  const snap = snapshotOf(settings);
  if (snap === lastSyncedSettings) return;
  try {
    await api.putSettings(settings);
    lastSyncedSettings = snap;
  } catch {
    // Offline or bad token: keep lastSyncedSettings unchanged so a later
    // trigger retries; local edits are safe in the store.
  }
}

/**
 * Reconcile settings with the server once: if this device has unsynced edits
 * it pushes them; otherwise the server copy wins (it may carry changes from
 * the other device).
 */
export async function syncSettings(): Promise<void> {
  const { settings } = useSettingsStore.getState();
  const localSnap = snapshotOf(settings);
  try {
    const { settings: serverSettings } = await api.getSettings();
    if (!serverSettings) return;
    const serverSnap = snapshotOf(serverSettings);
    if (lastSyncedSettings !== null && localSnap !== lastSyncedSettings) {
      // Unsynced local edits: push them; they win on this device.
      await api.putSettings(settings);
      lastSyncedSettings = localSnap;
      return;
    }
    if (serverSnap !== localSnap) {
      lastSyncedSettings = serverSnap;
      useSettingsStore.getState().replace(serverSettings);
    } else {
      lastSyncedSettings = serverSnap;
    }
  } catch {
    // Unreachable server: nothing to reconcile now.
  }
}

// --- orchestration ---

let syncing = false;

/**
 * One full sync round: flush pending uploads, pull library/progress changes,
 * reconcile settings. Safe to call concurrently — later calls no-op.
 */
export async function runSync(): Promise<void> {
  if (syncing) return;
  syncing = true;
  setSync({ pulling: true });
  try {
    await flushOutbox().catch(() => undefined);
    try {
      await pullLibrary();
    } catch (err) {
      setSync({ lastError: err instanceof Error ? err.message : String(err) });
    }
    await syncSettings();
  } finally {
    syncing = false;
    setSync({ pulling: false });
  }
}

/** Forget the incremental watermark so the next pull is a full merge. */
export async function resetSyncWatermark(): Promise<void> {
  await db.kv.delete(WATERMARK_KEY);
}

/** Wire the standard triggers. Call once at startup. */
export function startSync(): () => void {
  lastSyncedSettings = snapshotOf(useSettingsStore.getState().settings);

  const onOnline = (): void => {
    setSync({ online: true });
    void runSync();
  };
  const onOffline = (): void => setSync({ online: false });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  // Push debounced local settings edits (2s), echo-guarded.
  const unsubSettings = useSettingsStore.subscribe((state) => {
    const snap = snapshotOf(state.settings);
    if (snap === lastSyncedSettings) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushSettings(), 2000);
  });

  // First round shortly after startup (lets Dexie/settings settle).
  const t = setTimeout(() => void runSync(), 1500);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    unsubSettings();
    clearTimeout(t);
    clearTimeout(pushTimer);
  };
}
