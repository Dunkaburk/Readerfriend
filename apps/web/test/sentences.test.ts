/**
 * Interpolated sentence windows (§9.4 enhancement).
 */

import { describe, expect, it } from 'vitest';
import {
  chunkOffsetToMs,
  sentenceStartForOffset,
  sentenceWindowAt,
} from '../src/reader/sentences';

const TEXT = 'First sentence here. Second one is a bit longer! Short end.';
// chunk occupies [100, 100 + len) of the chapter plain text
const CHUNK = { charStart: 100, charEnd: 100 + TEXT.length, text: TEXT };

/** Sentence text for a window; Intl.Segmenter includes trailing whitespace. */
function sentenceOf(w: { start: number; end: number }): string {
  return TEXT.slice(w.start - 100, w.end - 100).trimEnd();
}

describe('sentenceWindowAt', () => {
  it('returns the first sentence at position 0', () => {
    const w = sentenceWindowAt(CHUNK, 0, 60_000)!;
    expect(w.start).toBe(100);
    expect(sentenceOf(w)).toBe('First sentence here.');
  });

  it('returns the last sentence at the end of the chunk', () => {
    const w = sentenceWindowAt(CHUNK, 60_000, 60_000)!;
    expect(sentenceOf(w)).toBe('Short end.');
  });

  it('walks forward through the sentences as position advances', () => {
    const len = CHUNK.charEnd - CHUNK.charStart;
    const w1 = sentenceWindowAt(CHUNK, 0, 60_000)!;
    const w2 = sentenceWindowAt(CHUNK, Math.floor(60_000 * 0.5), 60_000)!;
    const w3 = sentenceWindowAt(CHUNK, 60_000, 60_000)!;
    expect(w2.start).toBeGreaterThan(w1.start);
    expect(w3.start).toBeGreaterThan(w2.start);
    // Windows sit inside the chunk's plain-text range.
    for (const w of [w1, w2, w3]) {
      expect(w.start).toBeGreaterThanOrEqual(CHUNK.charStart);
      expect(w.end).toBeLessThanOrEqual(CHUNK.charEnd);
    }
    expect(len).toBeGreaterThan(0);
  });

  it('clamps positions outside [0, duration]', () => {
    const early = sentenceWindowAt(CHUNK, -5_000, 60_000)!;
    const late = sentenceWindowAt(CHUNK, 999_999, 60_000)!;
    expect(sentenceOf(early)).toBe('First sentence here.');
    expect(sentenceOf(late)).toBe('Short end.');
  });

  it('handles an unknown duration by pointing at the first sentence', () => {
    const w = sentenceWindowAt(CHUNK, 12_345, 0)!;
    expect(sentenceOf(w)).toBe('First sentence here.');
  });
});

describe('sentenceStartForOffset', () => {
  it('returns the sentence containing the tapped offset', () => {
    // Offset inside "Second one is a bit longer!" (starts at index 21).
    expect(sentenceStartForOffset(CHUNK, 100 + 25)).toBe(100 + 21);
  });

  it('snaps a mid-word tap to that sentence\'s start', () => {
    expect(sentenceStartForOffset(CHUNK, 100 + 22)).toBe(100 + 21);
  });

  it('resolves offsets past the last sentence to the last sentence start', () => {
    expect(sentenceStartForOffset(CHUNK, 100 + TEXT.length + 50)).toBe(100 + 49);
  });

  it('resolves the chunk start to the first sentence', () => {
    expect(sentenceStartForOffset(CHUNK, 100)).toBe(100);
  });
});

describe('chunkOffsetToMs', () => {
  it('interpolates by character position', () => {
    const len = CHUNK.charEnd - CHUNK.charStart;
    expect(chunkOffsetToMs(CHUNK, CHUNK.charStart, 60_000)).toBe(0);
    expect(chunkOffsetToMs(CHUNK, CHUNK.charEnd, 60_000)).toBe(60_000);
    const mid = CHUNK.charStart + Math.floor(len / 2);
    expect(chunkOffsetToMs(CHUNK, mid, 60_000)).toBe(Math.round((60_000 * (mid - CHUNK.charStart)) / len));
  });

  it('clamps offsets outside the chunk and handles an unknown duration', () => {
    expect(chunkOffsetToMs(CHUNK, CHUNK.charStart - 100, 60_000)).toBe(0);
    expect(chunkOffsetToMs(CHUNK, CHUNK.charEnd + 100, 60_000)).toBe(60_000);
    expect(chunkOffsetToMs(CHUNK, CHUNK.charStart + 10, 0)).toBe(0);
  });
});
