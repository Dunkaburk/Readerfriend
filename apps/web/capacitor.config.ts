/**
 * Capacitor configuration (SPEC §3, M5). The Android platform is generated
 * later with `npx cap add android` — see the README's Android section.
 *
 * Kept dependency-free on purpose: `tsc --noEmit` runs before @capacitor/cli
 * is installed. Once it is, you can tighten this with the CapacitorConfig
 * type from '@capacitor/cli'.
 */

const config = {
  appId: 'app.readerfriend',
  appName: 'Readerfriend',
  // Vite's build output (apps/web/dist) — the same bundle the web app deploys.
  webDir: 'dist',
  server: {
    // The SPA does its own routing; Capacitor must serve index.html for every
    // path. androidScheme https keeps IndexedDB persistent across installs.
    androidScheme: 'https',
  },
};

export default config;
