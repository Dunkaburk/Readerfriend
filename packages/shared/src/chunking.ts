/**
 * Chunking (§9.1) — runs exactly once per book, at import time, on the
 * importing device. The resulting plan is written to D1 and is the canonical
 * record (§4.3); no device ever recomputes it.
 *
 * Why ~2,000 characters per chunk? OpenRouter's free tier allows 20 TTS
 * requests/minute and 1,000/day (with $10 lifetime credit). A 100,000-word
 * novel is ~550,000 characters:
 *
 *   - one request per sentence:  ~5,000 requests — impossible
 *   - one request per paragraph: ~2,000 requests — over the daily cap
 *   - ~2,000 chars per chunk:    ~275 requests/book — 3.5 books/day, and
 *     ~14 min of wall-clock per book at the per-minute ceiling
 *
 * 500 chars would triple the request count for no quality gain; 10,000 would
 * blow past most models' per-request limits and slow retries. 2,000 is the
 * deliberate middle. 4,000 is a hard ceiling we never exceed.
 */

/**
 * Accumulation target. Paragraphs are packed until adding the next one would
 * push past this.
 */
export const CHUNK_TARGET_CHARS = 2000;

/** Hard ceiling for any chunk, whatever it takes to get there. */
export const CHUNK_HARD_MAX_CHARS = 4000;

export interface ChunkBoundary {
  charStart: number;
  charEnd: number;
  text: string;
}

interface Sentence {
  start: number;
  end: number;
}

const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

/**
 * Sentence boundaries over a string, contiguous and covering it fully.
 * Uses Intl.Segmenter where available (modern browsers + Android WebView),
 * falls back to a crude regex that is wrong less often than splitting mid-word.
 */
export function segmentSentences(text: string, lang?: string): Sentence[] {
  if (hasSegmenter) {
    try {
      const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
      const out: Sentence[] = [];
      for (const s of segmenter.segment(text)) {
        out.push({ start: s.index, end: s.index + s.segment.length });
      }
      return out;
    } catch {
      // RangeError on unsupported locale — fall through to the regex.
    }
  }
  // Regex fallback: break after .!?… (plus optional closing quotes/brackets)
  // followed by whitespace. Boundaries are contiguous, like the Segmenter's.
  const out: Sentence[] = [];
  let start = 0;
  const re = /[.!?…]+["'”’)\]]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start, end: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

/**
 * Split an oversized paragraph into chunks of at most `hardMax` characters at
 * sentence boundaries. If a single sentence still exceeds `hardMax` (rare,
 * malformed input), split on the nearest whitespace before the limit; if there
 * is no whitespace at all, cut hard — never splitting mid-word is a goal, not
 * something malformed input always permits.
 */
function splitOversizedParagraph(
  para: string,
  baseOffset: number,
  lang: string | undefined,
): ChunkBoundary[] {
  const out: ChunkBoundary[] = [];
  const sentences = segmentSentences(para, lang);
  let pieceStart = 0;
  let pieceEnd = 0;
  const push = (start: number, end: number) => {
    if (end > start) {
      out.push({ charStart: baseOffset + start, charEnd: baseOffset + end, text: para.slice(start, end) });
    }
  };

  for (const sentence of sentences) {
    if (pieceEnd > pieceStart && sentence.end - pieceStart > CHUNK_HARD_MAX_CHARS) {
      push(pieceStart, pieceEnd);
      pieceStart = sentence.start;
    }
    pieceEnd = sentence.end;
    // A single sentence over the limit: cut it up immediately.
    while (pieceEnd - pieceStart > CHUNK_HARD_MAX_CHARS) {
      const limit = pieceStart + CHUNK_HARD_MAX_CHARS;
      let cut = -1;
      for (let i = limit - 1; i > pieceStart; i--) {
        if (/\s/.test(para[i]!)) {
          cut = i;
          break;
        }
      }
      if (cut > pieceStart) {
        push(pieceStart, cut);
        pieceStart = cut + 1; // skip the whitespace
      } else {
        push(pieceStart, limit);
        pieceStart = limit;
      }
      pieceEnd = Math.max(pieceEnd, pieceStart);
      if (pieceEnd <= pieceStart) pieceEnd = pieceStart;
    }
  }
  push(pieceStart, pieceEnd);
  return out;
}

/**
 * Plan the chunks for one chapter's normalized plain text. Contiguous over
 * paragraphs: chunk k's text runs from its first paragraph's start to its last
 * paragraph's end, including the "\n\n" separators between them; the two
 * separator characters after a chunk are covered by neither chunk (they are
 * whitespace, never highlighted, never spoken).
 */
export function planChapterChunks(chapterText: string, lang?: string): ChunkBoundary[] {
  const out: ChunkBoundary[] = [];
  let curStart = -1;
  let curEnd = -1;

  const flush = () => {
    if (curStart >= 0 && curEnd > curStart) {
      out.push({ charStart: curStart, charEnd: curEnd, text: chapterText.slice(curStart, curEnd) });
    }
    curStart = -1;
    curEnd = -1;
  };

  let pos = 0;
  while (pos <= chapterText.length) {
    let next = chapterText.indexOf('\n\n', pos);
    if (next === -1) next = chapterText.length;
    const paraStart = pos;
    const paraEnd = next; // exclusive, excludes the separator
    const paraLen = paraEnd - paraStart;

    if (paraLen > 0) {
      if (paraLen > CHUNK_HARD_MAX_CHARS) {
        flush();
        out.push(...splitOversizedParagraph(chapterText.slice(paraStart, paraEnd), paraStart, lang));
      } else {
        if (curStart >= 0 && paraEnd - curStart > CHUNK_TARGET_CHARS) {
          flush();
        }
        if (curStart < 0) curStart = paraStart;
        curEnd = paraEnd;
      }
    }

    if (next === chapterText.length) break;
    pos = next + 2;
  }
  flush();
  return out;
}
