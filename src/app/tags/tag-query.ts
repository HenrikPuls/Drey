import { TAG_NAME_SOURCE } from '../../../shared/tag-grammar';

/** A whole `#tag` word: preceded by start/whitespace, followed by whitespace/end. */
const TAG_WORD = new RegExp(`(^|\\s)#(${TAG_NAME_SOURCE})(?=\\s|$)`, 'gu');
/** The `#partial` word ending exactly at the caret (the completion query). */
const TAG_AT_CARET = new RegExp(`(?:^|\\s)#((?:${TAG_NAME_SOURCE})?/?)$`, 'u');

export interface SplitQuery {
  /** Normalized (lower-cased, de-duplicated) tag names, in typing order. */
  readonly tags: string[];
  /** What is left of the text once the tag words are lifted out. */
  readonly text: string;
}

/**
 * Lifts every complete `#tag` word out of a combined query string (the
 * free-text mode of the shared tag field, milestone 43): `"#physik block "`
 * becomes `{ tags: ['physik'], text: 'block ' }`.
 *
 * `keepFrom` protects the word still being typed: a tag word that ENDS at
 * that offset (the caret) is left in the text, so `#phy|` keeps completing
 * instead of turning into a chip after three letters. Pass the text length
 * while typing and `null` to lift everything (blur, Enter).
 */
export function splitQuery(raw: string, keepFrom: number | null = null): SplitQuery {
  const tags: string[] = [];
  let text = '';
  let last = 0;
  for (const match of raw.matchAll(TAG_WORD)) {
    const lead = match[1];
    const start = match.index + lead.length;
    const end = match.index + match[0].length;
    if (keepFrom !== null && end === keepFrom) {
      continue;
    }
    const tag = match[2].toLowerCase();
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
    text += raw.slice(last, start);
    // Swallow the one separator after the lifted word so no double space stays.
    last = raw[end] === ' ' ? end + 1 : end;
  }
  text += raw.slice(last);
  return { tags, text };
}

/** The `#partial` being typed right before `caret`, without the `#`; null when none. */
export function tagQueryAtCaret(raw: string, caret: number): string | null {
  const match = TAG_AT_CARET.exec(raw.slice(0, caret));
  return match === null ? null : match[1].toLowerCase();
}
