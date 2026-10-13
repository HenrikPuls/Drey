/**
 * The curated `:shortcode:` surface over the generated gemoji table
 * (`emoji-table.ts`, ~1900 GitHub names incl. aliases). Both the editor's
 * Lezer extension and the markdown-it renders go through this one lookup,
 * which is what keeps stray `name:` text (timestamps like `00:03:48`)
 * plain: only a name GitHub actually knows ever matches.
 */
import { EMOJI_TABLE } from './emoji-table';

/** The emoji glyph for a known shortcode name, else `null`. */
export function emojiFor(name: string): string | null {
  return EMOJI_TABLE[name] ?? null;
}

/** Every curated name, in the generated table's sorted order. */
export const EMOJI_NAMES: readonly string[] = Object.keys(EMOJI_TABLE);

/** The names lowercased once, index-aligned with `EMOJI_NAMES`. */
const LOWERED_NAMES: readonly string[] = EMOJI_NAMES.map((name) => name.toLowerCase());

/**
 * The picker's / the `:`-completion's shared search: prefix matches first,
 * substring matches after, capped at `limit`. An empty query matches
 * nothing -- callers decide what a blank state shows (the whole list, the
 * recents, ...). Pure over the curated table, so it is unit-testable.
 */
export function searchEmojiNames(query: string, limit: number): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return [];
  }
  const prefix: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < LOWERED_NAMES.length; i++) {
    const lower = LOWERED_NAMES[i];
    if (lower.startsWith(q)) {
      prefix.push(EMOJI_NAMES[i]);
    } else if (lower.includes(q)) {
      rest.push(EMOJI_NAMES[i]);
    }
  }
  return [...prefix, ...rest].slice(0, Math.max(0, limit));
}

/**
 * Matches a shortcode at the START of `text` (`:` already consumed by the
 * caller): letters/digits/underscore/plus/minus, then the closing `:`.
 * Capturing group 1 is the name. Mirrors GitHub's name charset.
 */
export const EMOJI_NAME_AT_START = /^[a-zA-Z0-9_+-]+:/;
