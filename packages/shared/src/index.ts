// Core shared module: types, normalization, chunking, sanitizer. All
// dependency-light and worker-safe.
//
// EPUB parsing lives behind the './epub' subpath — it pulls in JSZip and
// linkedom and is only needed by the import pipeline, not the Worker or the
// reader's render path.

export * from './types';
export * from './text';
export * from './chunking';
export * from './sanitize';
