/**
 * Settings (§6.1): narration (model/voice/speed), reading (theme, typography,
 * sentence highlighting), sync status, and storage usage with a clear-cached-
 * audio action (§15: usage display only, no automatic eviction).
 */

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { TtsModel } from '@readerfriend/shared';
import { db } from '../db/dexie';
import { api, ApiError } from '../api/client';
import { blobStore } from '../adapters/blobStore.dexie';
import { useSettingsStore } from '../state/settings';
import { useNarration } from '../state/narration';
import { useSyncStatus, runSync, resetSyncWatermark } from '../sync/engine';
import { dropCachedChunkAudio } from '../audio/audioStore';
import { BackLink } from './ReaderScreen';

export function SettingsScreen() {
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pb-16 pt-8">
      <BackLink />
      <h1 className="mt-4 font-serif text-3xl text-fg">Settings</h1>
      <NarrationSection />
      <ReadingSection />
      <SyncSection />
      <StorageSection />
    </div>
  );
}

// --- narration ---

function NarrationSection() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [models, setModels] = useState<TtsModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getModels()
      .then((res) => {
        if (alive) setModels(res.models);
      })
      .catch((err: unknown) => {
        if (alive) {
          setModelsError(
            err instanceof ApiError ? err.message : 'Could not load the model list (offline?)',
          );
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const selected = models?.find((m) => m.id === settings.model) ?? null;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Narration</h2>

      <label className="mt-3 block text-sm text-fg" htmlFor="tts-model">
        Voice model
      </label>
      {modelsError ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{modelsError}</p>
      ) : null}
      {models && models.length === 0 ? (
        <p className="mt-1 text-xs text-muted">No speech models are available right now.</p>
      ) : null}
      <select
        id="tts-model"
        value={settings.model ?? ''}
        onChange={(ev) => update({ model: ev.target.value || null, voice: null })}
        className="mt-1 h-11 w-full rounded-md border border-black/15 bg-surface px-3 text-sm text-fg outline-none focus:border-accent dark:border-white/20"
      >
        <option value="">Not set — pick a model to enable narration</option>
        {settings.model && !models?.some((m) => m.id === settings.model) ? (
          <option value={settings.model}>{settings.model} (saved, no longer listed)</option>
        ) : null}
        {(models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.free ? ' — free' : ''}
          </option>
        ))}
      </select>

      {/* Free models rotate without notice (§13) and occasionally a working
          model lags behind the listing — allow typing a slug directly. */}
      <label className="mt-3 block text-sm text-fg" htmlFor="tts-model-custom">
        Custom model ID — for a model that is missing from the list
      </label>
      <input
        id="tts-model-custom"
        type="text"
        value={settings.model && !models?.some((m) => m.id === settings.model) ? settings.model : ''}
        onChange={(ev) => update({ model: ev.target.value || null })}
        placeholder="e.g. fish-audio/s2.1-pro-free:free"
        spellCheck={false}
        className="mt-1 h-11 w-full rounded-md border border-black/15 bg-surface px-3 text-sm text-fg outline-none focus:border-accent dark:border-white/20"
      />

      {selected && selected.voices.length > 0 ? (
        <>
          <label className="mt-3 block text-sm text-fg" htmlFor="tts-voice">
            Voice
          </label>
          <select
            id="tts-voice"
            value={settings.voice ?? ''}
            onChange={(ev) => update({ voice: ev.target.value || null })}
            className="mt-1 h-11 w-full rounded-md border border-black/15 bg-surface px-3 text-sm text-fg outline-none focus:border-accent dark:border-white/20"
          >
            <option value="">Not set</option>
            {selected.voices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label className="mt-3 block text-sm text-fg" htmlFor="tts-voice-manual">
            Voice ID
          </label>
          <input
            id="tts-voice-manual"
            type="text"
            value={settings.voice ?? ''}
            onChange={(ev) => update({ voice: ev.target.value || null })}
            placeholder="Model-specific voice id…"
            spellCheck={false}
            className="mt-1 h-11 w-full rounded-md border border-black/15 bg-surface px-3 text-sm text-fg outline-none focus:border-accent dark:border-white/20"
          />
        </>
      )}

      <label className="mt-3 block text-sm text-fg" htmlFor="tts-speed">
        Playback speed — {settings.speed.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0')}×
      </label>
      <input
        id="tts-speed"
        type="range"
        min={0.75}
        max={2}
        step={0.25}
        value={settings.speed}
        onChange={(ev) => {
          const rate = Number(ev.target.value);
          update({ speed: rate });
          // Apply immediately when narration is running.
          const n = useNarration.getState();
          if (n.active) n.setRate(rate);
        }}
        className="mt-2 w-full accent-[var(--accent)]"
      />
    </section>
  );
}

// --- reading ---

const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' },
] as const;

function ReadingSection() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Reading</h2>

      <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => update({ theme: t.id })}
            aria-pressed={settings.theme === t.id}
            className={
              'h-11 rounded-md px-4 text-sm ' +
              (settings.theme === t.id
                ? 'bg-accent text-white'
                : 'border border-black/15 text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Typeface">
        {(
          [
            { id: 'serif', label: 'Serif' },
            { id: 'sans', label: 'Sans' },
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => update({ fontFamily: f.id })}
            aria-pressed={settings.fontFamily === f.id}
            className={
              'h-11 rounded-md px-4 text-sm ' +
              (settings.fontFamily === f.id
                ? 'bg-accent text-white'
                : 'border border-black/15 text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5')
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      <RangeRow
        id="font-size"
        label={`Font size — ${settings.fontSize}px`}
        min={14}
        max={28}
        step={1}
        value={settings.fontSize}
        onChange={(fontSize) => update({ fontSize })}
      />
      <RangeRow
        id="line-height"
        label={`Line height — ${settings.lineHeight.toFixed(2)}`}
        min={1.3}
        max={2.2}
        step={0.05}
        value={settings.lineHeight}
        onChange={(lineHeight) => update({ lineHeight })}
      />
      <RangeRow
        id="margin-width"
        label={`Margin width — ${settings.marginWidth}px`}
        min={12}
        max={64}
        step={4}
        value={settings.marginWidth}
        onChange={(marginWidth) => update({ marginWidth })}
      />

      <label className="mt-3 flex h-11 items-center gap-3 text-sm text-fg">
        <input
          type="checkbox"
          checked={settings.sentenceHighlight}
          onChange={(ev) => update({ sentenceHighlight: ev.target.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Highlight the current sentence while listening
      </label>
    </section>
  );
}

function RangeRow(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <>
      <label className="mt-3 block text-sm text-fg" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(ev) => props.onChange(Number(ev.target.value))}
        className="mt-2 w-full accent-[var(--accent)]"
      />
    </>
  );
}

// --- sync ---

function SyncSection() {
  const token = useSettingsStore((s) => s.token);
  const setToken = useSettingsStore((s) => s.setToken);
  const [draft, setDraft] = useState(token);
  const [saved, setSaved] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const status = useSyncStatus();
  const pendingUploads = useLiveQuery(() => db.outbox.count(), []) ?? 0;

  const save = (): void => {
    setToken(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const syncNow = async (): Promise<void> => {
    setSyncMsg('Syncing…');
    await runSync();
    const s = useSyncStatus.getState();
    if (s.lastError) {
      setSyncMsg(`Sync failed: ${s.lastError}`);
      return;
    }
    const when = s.lastPullAt ? new Date(s.lastPullAt).toLocaleTimeString() : null;
    setSyncMsg(
      pendingUploads > 0
        ? `${pendingUploads} upload${pendingUploads === 1 ? '' : 's'} still queued${when ? ` — last pull ${when}` : ''}`
        : when
          ? `Synced${when === null ? '' : ` at ${when}`}`
          : 'Synced',
    );
  };

  const fullResync = async (): Promise<void> => {
    await resetSyncWatermark();
    await syncNow();
  };

  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Sync</h2>
      <p className="mt-2 text-xs text-muted">
        {status.online ? 'Online' : 'Offline — changes will sync when you reconnect'}
        {status.pulling ? ' · syncing…' : ''}
        {status.lastError ? ` · last error: ${status.lastError}` : ''}
      </p>

      <label className="mt-3 block text-sm text-fg" htmlFor="token">
        Access token
      </label>
      <p className="mt-1 text-xs text-muted">
        The shared bearer token configured on the Worker (<code>APP_TOKEN</code> secret).
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id="token"
          type="password"
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          placeholder="Paste token…"
          autoComplete="off"
          spellCheck={false}
          className="h-11 min-w-60 flex-1 rounded-md border border-black/15 bg-surface px-3 text-sm text-fg outline-none focus:border-accent dark:border-white/20"
        />
        <button
          type="button"
          onClick={save}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-white hover:opacity-90"
        >
          {saved ? 'Saved ✓' : 'Save'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void syncNow()}
          className="h-11 rounded-md border border-black/15 px-4 text-sm text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
        >
          Sync now
        </button>
        <button
          type="button"
          onClick={() => void fullResync()}
          className="h-11 rounded-md border border-black/15 px-4 text-sm text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
        >
          Full resync
        </button>
      </div>
      {syncMsg && <p className="mt-2 text-xs text-muted">{syncMsg}</p>}
    </section>
  );
}

// --- storage ---

function StorageSection() {
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
  const [quota, setQuota] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const u = await blobStore.usage();
      if (!alive) return;
      setUsage(u);
      try {
        const est = await navigator.storage?.estimate?.();
        if (alive && est?.quota) setQuota(est.quota);
      } catch {
        // estimate is best-effort
      }
    })();
    return () => {
      alive = false;
    };
  }, [msg]);

  const clearAudio = async (): Promise<void> => {
    for (const book of await db.books.toArray()) {
      await dropCachedChunkAudio(book.id);
    }
    setConfirming(false);
    setMsg('Cached audio cleared — it will re-download or re-generate on the next listen.');
    setUsage(await blobStore.usage());
  };

  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Storage</h2>
      <p className="mt-2 text-sm text-fg">
        {usage ? formatBytes(usage.bytes) : '…'} used by books, covers and audio
        {usage ? ` across ${usage.count} file${usage.count === 1 ? '' : 's'}` : ''}
        {quota ? ` of about ${formatBytes(quota)} available` : ''}.
      </p>
      <p className="mt-1 text-xs text-muted">
        Audio is cached per chunk as it plays; clearing it frees space but re-downloads or
        re-generates on the next listen.
      </p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={usage !== null && usage.count === 0}
          className="mt-3 h-11 rounded-md border border-black/15 px-4 text-sm text-fg hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/5"
        >
          Clear cached audio
        </button>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg">Remove all cached audio from this device?</span>
          <button
            type="button"
            onClick={() => void clearAudio()}
            className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-white hover:opacity-90"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="h-11 rounded-md border border-black/15 px-4 text-sm text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
          >
            Keep
          </button>
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </section>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
