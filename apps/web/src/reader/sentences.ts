/**
 * Interpolated sentence windows (§9.4 enhancement). The TTS audio carries no
 * word timings, so within a chunk we assume a roughly constant speech rate:
 *
 *   sentenceStartMs ≈ chunkDurationMs * (sentenceCharStart / chunkCharLength)
 *
 * and highlight the sentence whose window contains the playback position.
 * Drift stays bounded because chunks are only ~2,000 characters and the
 * estimate resets at every chunk boundary.
 */

import { segmentSentences } from '@readerfriend/shared';

/** Absolute plain-text offsets of the sentence at the playback position. */
export function sentenceWindowAt(
  chunk: { charStart: number; charEnd: number; text: string },
  positionMs: number,
  durationMs: number,
): { start: number; end: number } | null {
  const len = chunk.charEnd - chunk.charStart;
  if (len <= 0) return null;
  const frac = durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;
  const charPos = chunk.charStart + frac * len;
  for (const s of segmentSentences(chunk.text)) {
    const start = chunk.charStart + s.start;
    const end = chunk.charStart + s.end;
    if (charPos < end || (s.end === chunk.text.length && charPos <= end)) {
      return { start, end };
    }
  }
  return null;
}

/**
 * Absolute plain-text offset of the start of the sentence containing
 * `charOffset` (sentence-level tap-to-play, §9.4). Offsets past the last
 * sentence resolve to the last sentence's start.
 */
export function sentenceStartForOffset(
  chunk: { charStart: number; text: string },
  charOffset: number,
): number {
  const local = charOffset - chunk.charStart;
  let lastStart = 0;
  for (const s of segmentSentences(chunk.text)) {
    if (local < s.end) return chunk.charStart + s.start;
    lastStart = s.start;
  }
  return chunk.charStart + lastStart;
}

/**
 * Estimated audio position (ms) for a plain-text offset inside `chunk`, by
 * the same constant-rate approximation as the highlight (§9.4). `durationMs`
 * is the per-chunk duration estimate — the playing chunk's real duration is
 * the best available proxy for its siblings.
 */
export function chunkOffsetToMs(
  chunk: { charStart: number; charEnd: number },
  charOffset: number,
  durationMs: number,
): number {
  const len = chunk.charEnd - chunk.charStart;
  if (len <= 0 || durationMs <= 0) return 0;
  const frac = Math.max(0, Math.min(1, (charOffset - chunk.charStart) / len));
  return Math.round(frac * durationMs);
}
