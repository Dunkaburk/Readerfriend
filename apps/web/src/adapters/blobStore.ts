/**
 * Platform adapter for large binary data (SPEC §6.3). Everything else in the
 * app is platform-agnostic and talks to this interface only.
 */

export interface BlobStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  usage(): Promise<{ bytes: number; count: number }>;
}
