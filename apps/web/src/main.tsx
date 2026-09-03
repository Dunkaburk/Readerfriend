import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/literata';
import './index.css';
import { App } from './App';
import { applySystemThemeDefault } from './state/settings';
import { startOutboxTrigger } from './sync/outbox';
import { startSync } from './sync/engine';
import { generationQueue } from './audio/generationQueue';

applySystemThemeDefault();

// Ask for persistent storage so the browser does not evict books/audio (§6.3).
void navigator.storage?.persist?.().catch(() => undefined);

startOutboxTrigger();
startSync();
// Resume an interrupted generation queue from local state (§9.2).
void generationQueue.init();

// Offline app shell (§7) — production build only, so dev always sees fresh code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
