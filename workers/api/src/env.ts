/// <reference types="@cloudflare/workers-types" />

/** Worker bindings (SPEC §5, §12). */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Shared bearer token, set via `wrangler secret put APP_TOKEN`. */
  APP_TOKEN: string;
  /** OpenRouter key, set via `wrangler secret put OPENROUTER_API_KEY`. */
  OPENROUTER_API_KEY: string;
}
