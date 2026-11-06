/**
 * Word matching over a note's text: the one definition behind `vault_search`
 * (ADR-0071) and the engine's Notes API (req-100). All words must occur in one
 * heading-delimited section; a regular expression matches line by line.
 */
import { splitSections } from './note-sections';

/** Matching lines shown per section in word mode; the section is the hit. */
const LINES_PER_SECTION = 3;

/** One matching line of a file, with the section it sits in. */
export interface LineHit {
  line: number;
  heading: string;
}

/** `query` as the terms to look for: quoted phrases stay whole, the rest splits on spaces. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? '').trim();
    if (term !== '') {
      terms.push(term);
    }
  }
  return terms;
}

/** The lines of `content` that match, in order. `mode` decides how. */
export function findLines(
  content: string,
  mode: { kind: 'regex'; regex: RegExp } | { kind: 'words'; terms: string[]; caseSensitive: boolean },
): LineHit[] {
  const lines = content.split('\n');
  const sections = splitSections(content);
  const headingAt = (line: number): string => {
    let heading = '';
    for (const section of sections) {
      if (section.line > line) {
        break;
      }
      heading = section.heading;
    }
    return heading;
  };

  if (mode.kind === 'regex') {
    const hits: LineHit[] = [];
    for (let i = 0; i < lines.length; i++) {
      mode.regex.lastIndex = 0;
      if (mode.regex.test(lines[i]!)) {
        hits.push({ line: i + 1, heading: headingAt(i + 1) });
      }
    }
    return hits;
  }

  const fold = (text: string): string => (mode.caseSensitive ? text : text.toLowerCase());
  const terms = mode.terms.map(fold);
  // Section bounds: from its first line to the line before the next one.
  // Text before the first heading is a section of its own.
  const starts = sections.map((section) => section.line);
  if (starts[0] !== 1) {
    starts.unshift(1);
  }
  const hits: LineHit[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! - 1 : lines.length;
    const body = fold(lines.slice(from - 1, to).join('\n'));
    if (!terms.every((term) => body.includes(term))) {
      continue;
    }
    const heading = headingAt(from);
    let shown = 0;
    for (let line = from; line <= to && shown < LINES_PER_SECTION; line++) {
      const text = fold(lines[line - 1]!);
      if (terms.some((term) => text.includes(term))) {
        hits.push({ line, heading });
        shown++;
      }
    }
  }
  return hits;
}
