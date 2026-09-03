/**
 * Import Web Worker (§6.2): parse and chunk off the main thread so the UI
 * never blocks. Chunking happens HERE and nowhere else (§13 trap 1) — the
 * plan is stored once and served from then on.
 */

/// <reference lib="webworker" />

import { planChapterChunks } from '@readerfriend/shared';
import { parseEpub, parseTxt } from '@readerfriend/shared/epub';
import type { ImportRequest, ImportResult } from './protocol';

async function run(req: ImportRequest): Promise<ImportResult> {
  const parsed =
    req.kind === 'epub' ? await parseEpub(new Uint8Array(req.bytes!)) : parseTxt(req.text!);

  const chapters = parsed.chapters.map((ch) => ({
    idx: ch.idx,
    title: ch.title,
    href: ch.href,
    charCount: ch.plainText.length,
    html: ch.html,
    plainText: ch.plainText,
    chunks: planChapterChunks(ch.plainText, parsed.language ?? undefined).map((c, chunkIdx) => ({
      chunkIdx,
      charStart: c.charStart,
      charEnd: c.charEnd,
      text: c.text,
    })),
  }));

  return {
    id: req.id,
    ok: true,
    title: parsed.title,
    author: parsed.author,
    language: parsed.language,
    cover: parsed.cover,
    chapters,
  };
}

self.addEventListener('message', (ev: MessageEvent<ImportRequest>) => {
  void run(ev.data)
    .then((result) => (self as unknown as Worker).postMessage(result))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      (self as unknown as Worker).postMessage({ id: ev.data.id, ok: false, error: message } satisfies ImportResult);
    });
});
