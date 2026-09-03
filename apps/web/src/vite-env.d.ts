/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Worker API, e.g. http://localhost:8787. */
  readonly VITE_API_BASE?: string;
  /** Convenience default for the bearer token; normally pasted in Settings. */
  readonly VITE_APP_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
