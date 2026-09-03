import { describe, expect, it } from 'vitest';
import {
  CHUNK_HARD_MAX_CHARS,
  CHUNK_TARGET_CHARS,
  planChapterChunks,
  segmentSentences,
} from '../src/chunking';

describe('segmentSentences', () => {
  it('splits on sentence terminators', () => {
    const sentences = segmentSentences('One sentence. Two more! Three? Done');
    expect(sentences.map((s) => s.end - s.start)).toEqual([14, 10, 7, 4]);
  });

  it('produces contiguous, fully covering boundaries', () => {
    const text = 'A short one. And another! Final...';
    const sentences = segmentSentences(text);
    expect(sentences[0]?.start).toBe(0);
    expect(sentences[sentences.length - 1]?.end).toBe(text.length);
    for (let i = 1; i < sentences.length; i++) {
      expect(sentences[i]!.start).toBe(sentences[i - 1]!.end);
    }
  });

  it('returns the whole string as one sentence when there is no terminator', () => {
    const sentences = segmentSentences('No terminator here');
    expect(sentences).toEqual([{ start: 0, end: 18 }]);
  });
});

describe('planChapterChunks', () => {
  it('packs paragraphs up to the target without exceeding it by more than one paragraph', () => {
    const para = 'x'.repeat(700);
    // 3 paragraphs of 700 + two separators = 2102 chars total.
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = planChapterChunks(text);
    // 700+2+700 = 1402 ≤ 2000; adding the third → 2104 > 2000, so it flushes.
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toMatchObject({ charStart: 0, charEnd: 1402 });
    expect(chunks[1]).toMatchObject({ charStart: 1404, charEnd: 2104 });
    expect(chunks[0]?.text).toBe(text.slice(0, 1402));
    expect(chunks[1]?.text).toBe(text.slice(1404));
  });

  it('keeps a single paragraph that is over target but under hard max as one chunk', () => {
    const text = 'y'.repeat(3000);
    const chunks = planChapterChunks(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe(text);
  });

  it('splits oversized paragraphs at sentence boundaries under the hard max', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog. ';
    // 100 sentences ≈ 4600 chars > hard max.
    const text = sentence.repeat(100);
    const chunks = planChapterChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX_CHARS);
      expect(chunk.text).toBe(text.slice(chunk.charStart, chunk.charEnd));
      // Never ends mid-word (sentences end with ". ", possibly trailing space).
      expect(chunk.text.trimEnd().endsWith('.')).toBe(true);
    }
    // Coverage: chunks plus skipped separators cover the chapter exactly.
    expect(chunks[0]?.charStart).toBe(0);
    expect(chunks[chunks.length - 1]?.charEnd).toBe(text.length);
  });

  it('never exceeds the hard max even for one monstrous sentence', () => {
    const text = `${'word '.repeat(2000)}end.`; // one sentence, ~10k chars
    const chunks = planChapterChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX_CHARS);
      // Never splits mid-word.
      expect(chunk.text.startsWith('word') || chunk.text.startsWith(' ')).toBe(true);
      expect(chunk.text.endsWith('word') || chunk.text.endsWith('.')).toBe(true);
    }
  });

  it('handles a single 6000-char word (no whitespace) by hard-cutting', () => {
    const text = 'a'.repeat(6000);
    const chunks = planChapterChunks(text);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX_CHARS);
    }
  });

  it('returns no chunks for empty text', () => {
    expect(planChapterChunks('')).toEqual([]);
  });

  it('offsets are exact slices of the input', () => {
    const text = 'First para here.\n\nSecond para, somewhat longer than the first.\n\nThird.';
    const chunks = planChapterChunks(text);
    for (const chunk of chunks) {
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it('produces chunks near the target for many small paragraphs', () => {
    const paras: string[] = [];
    for (let i = 0; i < 200; i++) paras.push(`Paragraph ${i} with some words to fill space.`);
    const text = paras.join('\n\n');
    const chunks = planChapterChunks(text);
    // 200 paras × ~46 chars ≈ 9400 chars → ~5 chunks of ~2000.
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.length).toBeLessThanOrEqual(6);
    const avg = text.length / chunks.length;
    expect(avg).toBeGreaterThan(CHUNK_TARGET_CHARS * 0.6);
  });
});
