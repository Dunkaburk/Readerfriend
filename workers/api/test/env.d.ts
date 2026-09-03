/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from 'cloudflare:test';
import type { Env as ApiEnv } from '../src/env';

// vitest-pool-workers types `env` as `Cloudflare.Env`; extend the global
// declaration with the worker's bindings (declaration merging).
declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
