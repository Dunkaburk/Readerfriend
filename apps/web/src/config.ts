/** Client configuration (SPEC §12). */
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

/**
 * Token baked in at build time is a convenience for a personal deployment;
 * the live token lives in localStorage and can be changed in Settings.
 */
export const DEFAULT_TOKEN = import.meta.env.VITE_APP_TOKEN ?? '';
