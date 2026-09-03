/**
 * .txt parsing (§8, last paragraph): treat the whole file as one book. Split
 * into chapters on conservative heading lines or runs of three or more blank
 * lines; if nothing matches, a single chapter. Normalization is the same
 * collapse-whitespace rule (achieved by rendering paragraphs to HTML and
 * running the standard normalize step over it).
 */

import { normalizeText } from '../text';
import { parseFragment } from './dom';
import type { ParsedBook, ParsedChapter } from './index';

const HEADING_RE = /^\s*(chapter|part|book)\s+[ivxlcdm\d]/i;

/** Conservative heading pattern, e.g. "Chapter 7", "PART II", "Book 1". */
export function isHeadingLine(line: string): boolean {
  return HEADING_RE.test(line);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface TxtChapter {
  lines: string[];
  title: string | null;
}

/**
 * Split the raw text into chapters. A boundary is a heading line, or the end
 * of a run of three or more blank lines. The heading line itself starts its
 * chapter; a blank-run boundary starts at the next non-blank line.
 */
export function splitTxtChapters(raw: string): TxtChapter[] {
  const lines = raw.split(/\r\n|\r|\n/);
  const starts = new Set<number>();
  let blankRun = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      blankRun++;
      if (blankRun >= 3) {
        // First non-blank line after the run starts a new chapter.
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        if (j < lines.length && !starts.has(j) && j > 0) starts.add(j);
        i = j - 1;
        blankRun = 0;
      }
    } else {
      if (blankRun < 3 && i > 0 && isHeadingLine(line) && !starts.has(i)) {
        starts.add(i);
      }
      blankRun = 0;
    }
  }

  if (starts.size === 0) {
    return [{ lines, title: null }];
  }

  const sorted = [...starts].sort((a, b) => a - b);
  if (sorted[0] !== 0) sorted.unshift(0);
  const chapters: TxtChapter[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const start = sorted[k]!;
    const end = k + 1 < sorted.length ? sorted[k + 1]! : lines.length;
    const slice = lines.slice(start, end);
    let title: string | null = null;
    // Find the heading line inside the chapter slice (it may follow blanks).
    for (const line of slice.slice(0, 10)) {
      if (isHeadingLine(line)) {
        title = line.replace(/\s+/g, ' ').trim();
        break;
      }
      if (line.trim() !== '') break; // a non-heading, non-blank line: no title
    }
    chapters.push({ lines: slice, title });
  }
  return chapters;
}

/** Parse a .txt file into the same shape parseEpub returns. */
export function parseTxt(raw: string): ParsedBook {
  const chapters = splitTxtChapters(raw);
  const parsed: ParsedChapter[] = [];

  for (const chapter of chapters) {
    // Drop leading blank lines from the slice.
    while (chapter.lines.length > 0 && chapter.lines[0]!.trim() === '') chapter.lines.shift();
    // The heading line is the chapter's title — keep it out of the body text
    // so TTS does not double-speak it.
    if (chapter.lines.length > 0 && isHeadingLine(chapter.lines[0]!)) {
      chapter.lines.shift();
      while (chapter.lines.length > 0 && chapter.lines[0]!.trim() === '') chapter.lines.shift();
    }
    // Paragraphs: split on blank-line runs.
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of chapter.lines) {
      if (line.trim() === '') {
        if (current.length > 0) {
          paragraphs.push(current.join(' ').replace(/\s+/g, ' ').trim());
          current = [];
        }
      } else {
        current.push(line.trim());
      }
    }
    if (current.length > 0) {
      paragraphs.push(current.join(' ').replace(/\s+/g, ' ').trim());
    }

    const html = paragraphs
      .filter((p) => p.length > 0)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('\n');
    const plainText = normalizeText(parseFragment(html));
    parsed.push({
      idx: parsed.length,
      title: chapter.title ?? `Chapter ${parsed.length + 1}`,
      href: null,
      html,
      plainText,
    });
  }

  return {
    title: parsed[0]?.title ?? 'Untitled',
    author: null,
    language: null,
    cover: null,
    chapters: parsed,
  };
}
