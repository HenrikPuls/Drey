// Sibling specifiers need the explicit `.js`: emitted as CJS (main) and
// served over plugin:// (ESM) — see search.ts.
import { TAG_NAME_SOURCE, extractTagOccurrences } from './tags.js';

/**
 * Tag rename / merge (milestone 53): rewrites every inline tag token the
 * shared grammar sees in a file — `#old` becomes `#new`, and with
 * descendants included `#old/sub` becomes `#new/sub` (the tail segments
 * keep their original spelling). Fenced and inline code are never touched
 * (the occurrence scanner blanks them out). A merge that would put `#new`
 * next to an existing `#new` on the same line drops the duplicate, so
 * merging `#old` into `#new` on `#old #new` yields one `#new` — a line's
 * pre-existing duplicates are left alone.
 */

/** One file's rename result; `null` when the file carries no match. */
export interface TagRenamePatch {
  before: string;
  after: string;
  /** Tag tokens rewritten (a merged-away duplicate still counts). */
  occurrences: number;
}

/** A `/`-segment, `-` and `_` inclusive tag-name character. */
const TAG_CHAR = /[\p{L}\p{N}_/-]/u;

/**
 * A user-entered tag name: trimmed, lower-cased, leading `#`s stripped.
 * `null` when empty, not a valid grammar name, or `task`-rooted (the
 * reserved structural marker, ADR-0033 — nothing may rename INTO it).
 */
export function normalizeTagName(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/^#+/, '');
  if (cleaned === '' || !new RegExp(`^${TAG_NAME_SOURCE}$`, 'u').test(cleaned)) {
    return null;
  }
  return cleaned.split('/', 1)[0] === 'task' ? null : cleaned;
}

/** The tag an occurrence becomes under `from` → `to`. */
function mappedTag(tag: string, from: string, to: string): string {
  return tag === from ? to : `${to}/${tag.slice(from.length + 1)}`;
}

/** 1-based line number of a character index, given the line-start table. */
function lineOfIndex(lineStarts: readonly number[], index: number): number {
  let line = 1;
  // Index 0 of the table is line 1's own start — skip it.
  for (let i = 1; i < lineStarts.length; i++) {
    if (lineStarts[i] > index) {
      break;
    }
    line++;
  }
  return line;
}

/**
 * Renames every `from` token (and, with `includeDescendants`, every
 * `from/…` descendant) in `content` to `to`. `from`/`to` are expected
 * pre-normalized (see {@link normalizeTagName}); an identical or empty
 * pair is a no-op (`null`).
 */
export function renameTagInContent(
  content: string,
  from: string,
  to: string,
  includeDescendants: boolean,
): TagRenamePatch | null {
  if (from === '' || to === '' || from === to) {
    return null;
  }
  const matches = extractTagOccurrences(content).filter(
    (occ) => occ.tag === from || (includeDescendants && occ.tag.startsWith(`${from}/`)),
  );
  if (matches.length === 0) {
    return null;
  }

  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lineStarts.push(i + 1);
    }
  }
  // Which line got which result tag — the dedupe pass works per line.
  const rewritten = new Map<number, Set<string>>();

  let out = content;
  let occurrences = 0;
  // Back-to-front, so earlier indices survive every splice. A replacement
  // never adds or removes a newline (tag characters exclude it).
  for (let i = matches.length - 1; i >= 0; i--) {
    const occ = matches[i];
    const hashAt = occ.index;
    let end = hashAt + 1;
    while (end < out.length && TAG_CHAR.test(out[end])) {
      end++;
    }
    const raw = out.slice(hashAt, end);
    const tail = raw.indexOf('/') === -1 ? '' : raw.slice(raw.indexOf('/'));
    const line = lineOfIndex(lineStarts, hashAt);
    let tags = rewritten.get(line);
    if (tags === undefined) {
      tags = new Set<string>();
      rewritten.set(line, tags);
    }
    tags.add(mappedTag(occ.tag, from, to));
    out = `${out.slice(0, hashAt)}#${to}${tail}${out.slice(end)}`;
    occurrences++;
  }

  // Merge dedupe: when the rename put a token next to its twin on a line
  // that already carried one, drop the newcomers (pre-existing duplicates
  // are the user's own text and stay).
  const lines = out.split('\n');
  const origLines = content.split('\n');
  for (const [line, resultTags] of rewritten) {
    for (const resultTag of resultTags) {
      const before = countTagOnLine(origLines[line - 1] ?? '', resultTag);
      if (before === 0) {
        continue;
      }
      lines[line - 1] = dropBeyond(lines[line - 1] ?? '', resultTag, before);
    }
  }
  return { before: content, after: lines.join('\n'), occurrences };
}

/** How many `#tag` tokens the ORIGINAL line already carried. */
function countTagOnLine(line: string, tag: string): number {
  let n = 0;
  for (const occ of extractTagOccurrences(line)) {
    if (occ.tag === tag) {
      n++;
    }
  }
  return n;
}

/** Keeps at most `keep` `#tag` tokens on the line, removing the extras. */
function dropBeyond(line: string, tag: string, keep: number): string {
  const occs = extractTagOccurrences(line).filter((occ) => occ.tag === tag);
  if (occs.length <= keep) {
    return line;
  }
  let out = line;
  for (let i = occs.length - 1; i >= keep; i--) {
    const occ = occs[i];
    let end = occ.index + 1;
    while (end < out.length && TAG_CHAR.test(out[end])) {
      end++;
    }
    // Take one whitespace run along with the token so no double gap stays.
    let start = occ.index;
    while (start > 0 && (out[start - 1] === ' ' || out[start - 1] === '\t')) {
      start--;
    }
    if (start === 0) {
      while (end < out.length && (out[end] === ' ' || out[end] === '\t')) {
        end++;
      }
    }
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}
