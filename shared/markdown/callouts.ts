/**
 * GitHub-alert / Obsidian-callout markers, the pure half: which keywords
 * exist, how they map onto the palette, and how the first line of a
 * blockquote parses into `{ kind, title, fold }`.
 *
 * Syntax (both flavors agree on the shape):
 *
 * ```md
 * > [!NOTE] Optional custom title
 * > body paragraphs
 * ```
 *
 * Obsidian adds the fold suffix (`> [!NOTE]-` starts collapsed, `+`
 * open): the editor's Live Preview and reading view fold such a callout
 * on a click of its title (req-54); the exports render it open — a
 * printed page cannot fold. Keywords: GitHub's five
 * (NOTE, TIP, IMPORTANT, WARNING, CAUTION) are the canonical kinds;
 * Obsidian's aliases fold onto them so a vault written in either flavor
 * reads the same.
 */

/** The five palette kinds — also the CSS suffix (`lp-callout-note`, …). */
export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export interface CalloutTypeInfo {
  /** Palette + CSS kind. */
  kind: CalloutKind;
  /** Fallback title when the marker carries none. */
  label: string;
  /** Title-bar glyph (an emoji, so the PDF export needs no icon runtime). */
  icon: string;
}

/**
 * Keyword → kind. Uppercased before lookup (both flavors are
 * case-insensitive). GitHub's five keywords plus Obsidian's aliases.
 */
export const CALLOUT_TYPES: Readonly<Record<string, CalloutTypeInfo>> = {
  NOTE: { kind: 'note', label: 'Note', icon: '📝' },
  ABSTRACT: { kind: 'note', label: 'Abstract', icon: '📝' },
  SUMMARY: { kind: 'note', label: 'Summary', icon: '📝' },
  TLDR: { kind: 'note', label: 'TL;DR', icon: '📝' },
  INFO: { kind: 'note', label: 'Info', icon: 'ℹ️' },
  TODO: { kind: 'note', label: 'Todo', icon: '📝' },
  TIP: { kind: 'tip', label: 'Tip', icon: '💡' },
  HINT: { kind: 'tip', label: 'Hint', icon: '💡' },
  SUCCESS: { kind: 'tip', label: 'Success', icon: '✅' },
  CHECK: { kind: 'tip', label: 'Check', icon: '✅' },
  DONE: { kind: 'tip', label: 'Done', icon: '✅' },
  IMPORTANT: { kind: 'important', label: 'Important', icon: '❗' },
  QUESTION: { kind: 'important', label: 'Question', icon: '❓' },
  HELP: { kind: 'important', label: 'Help', icon: '❓' },
  FAQ: { kind: 'important', label: 'FAQ', icon: '❓' },
  EXAMPLE: { kind: 'important', label: 'Example', icon: '🔨' },
  WARNING: { kind: 'warning', label: 'Warning', icon: '⚠️' },
  CAUTION: { kind: 'caution', label: 'Caution', icon: '🔴' },
  ATTENTION: { kind: 'warning', label: 'Attention', icon: '⚠️' },
  FAILURE: { kind: 'caution', label: 'Failure', icon: '❌' },
  FAIL: { kind: 'caution', label: 'Fail', icon: '❌' },
  MISSING: { kind: 'caution', label: 'Missing', icon: '❌' },
  DANGER: { kind: 'caution', label: 'Danger', icon: '⚡' },
  ERROR: { kind: 'caution', label: 'Error', icon: '⚡' },
  BUG: { kind: 'caution', label: 'Bug', icon: '🐛' },
  QUOTE: { kind: 'note', label: 'Quote', icon: '❝' },
  CITE: { kind: 'note', label: 'Cite', icon: '❝' },
};

export interface CalloutMarker {
  kind: CalloutKind;
  /** The resolved type info (label/icon of the ACTUAL keyword, not the kind's). */
  info: CalloutTypeInfo;
  /** Custom title after the marker, `null` when the line carries none. */
  title: string | null;
  /** Obsidian fold suffix: `-` collapsed, `+` expanded; null = not foldable. */
  fold: '-' | '+' | null;
  /** Length of the marker token itself (`[!TYPE]` plus fold suffix). */
  length: number;
}

/** A marker at the start of `text` (the quote marks already stripped).
 * The title run stops at the end of the line — a blockquote's inline
 * content carries the following body lines behind a `\n`. */
const CALLOUT_MARKER = /^\[!([a-zA-Z]+)\]([+-])?[ \t]*([^\n]*)/;

/**
 * Parses `text` — the content of a blockquote's first line, leading
 * `>`/space already removed — as a callout marker. `null` for a plain
 * quote line.
 */
export function parseCalloutMarker(text: string): CalloutMarker | null {
  const match = CALLOUT_MARKER.exec(text);
  if (match === null) {
    return null;
  }
  const info = CALLOUT_TYPES[match[1].toUpperCase()];
  if (info === undefined) {
    return null;
  }
  const title = match[3].trim();
  return {
    kind: info.kind,
    info,
    title: title === '' ? null : title,
    fold: match[2] === '-' || match[2] === '+' ? (match[2] as '-' | '+') : null,
    // The marker token only (`[!TYPE]` + fold suffix) — match[0] would
    // swallow the custom title and any separating spaces.
    length: 3 + match[1].length + (match[2] === undefined ? 0 : 1),
  };
}
