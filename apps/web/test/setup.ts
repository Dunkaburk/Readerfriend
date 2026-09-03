/**
 * Global test setup. Runs before test modules are imported, so the fake
 * IndexedDB globals exist before Dexie resolves its domDeps at import time.
 */

import { beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const globals = globalThis as unknown as { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange };
globals.indexedDB = new IDBFactory();
globals.IDBKeyRange = IDBKeyRange;

const { db } = await import('../src/db/dexie');

beforeEach(async () => {
  await db.delete();
  await db.open();
});
