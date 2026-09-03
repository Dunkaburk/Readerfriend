/**
 * Client settings + the shared bearer token. Persisted to localStorage;
 * the server copy syncs in the sync engine (Task: Sync) and wins for
 * reading preferences.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_SETTINGS, type AppSettings } from '@readerfriend/shared';
import { DEFAULT_TOKEN } from '../config';

interface SettingsState {
  settings: AppSettings;
  token: string;
  setToken(token: string): void;
  /** Apply a settings patch locally; server sync is debounced by the caller. */
  update(patch: Partial<AppSettings>): void;
  replace(settings: AppSettings): void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: { ...DEFAULT_SETTINGS },
      token: DEFAULT_TOKEN,
      setToken: (token) => set({ token: token.trim() }),
      update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      replace: (settings) => set({ settings }),
    }),
    {
      name: 'readerfriend.settings',
      version: 1,
    },
  ),
);

/**
 * First-run default: follow the system preference (§10). Called once at
 * startup when nothing has been persisted yet.
 */
export function applySystemThemeDefault(): void {
  if (localStorage.getItem('readerfriend.settings') !== null) return;
  if (!window.matchMedia) return;
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    useSettingsStore.getState().update({ theme: 'dark' });
  }
}

/** Reflect the active theme onto <html data-theme> (§10 themes). */
export function applyThemeToDocument(theme: AppSettings['theme']): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    const colors: Record<AppSettings['theme'], string> = {
      light: '#faf9f7',
      sepia: '#f3ead7',
      dark: '#232323',
    };
    meta.content = colors[theme];
  }
}
