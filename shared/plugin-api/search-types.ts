/**
 * The section-search shapes the plugin SDK speaks (ADR-0044): the
 * vocabulary (`TagEntry`) and the tag+free-text query/hit pair. Owned here
 * — not imported from the tags plugin — so the contract stays independent
 * of whichever plugin registers the provider.
 */

/** One tag in the vault-wide vocabulary, with its section count. */
export interface TagEntry {
  tag: string;
  count: number;
  /**
   * Resolved display color (`#rrggbb`) when the provider serves prefix
   * styles — informational; base surfaces resolve styles themselves via
   * `shared/tag-style.ts` so unconfigured tags still get their auto color.
   */
  color?: string;
}

/** One configured tag-prefix style (lower-case prefix, `#rrggbb` color). */
export interface TagPrefixStyle {
  /** Lower-case, no leading `#`, no trailing `/` — `proj/frontend`. */
  prefix: string;
  color: string;
}

/**
 * Free-text matching flags for a {@link TagSearchQuery}. Absent fields mean
 * the historical defaults: case-insensitive substring terms.
 */
export interface TextMatchOptions {
  /** Default false (case-insensitive). */
  caseSensitive?: boolean;
  /** Match whole words only (Unicode letter/digit boundaries). Default false. */
  wholeWord?: boolean;
  /** `text` is ONE regular expression instead of whitespace-split terms. Default false. */
  regex?: boolean;
}

/** Tags (AND) plus free-text terms (AND) over heading-delimited sections. */
export interface TagSearchQuery {
  tags: readonly string[];
  text: string;
  /** Matcher flags; omitted = case-insensitive substring terms. */
  match?: TextMatchOptions;
}

/** One matching section: where a click should land, plus a snippet. */
export interface TagSearchHit {
  path: string;
  heading: string;
  /** 1-based line the section starts on. */
  line: number;
  /** ~240-char window around the first match, whitespace collapsed. */
  snippet: string;
  /** The full section body (heading excluded). */
  text: string;
  /** Set by the caller when the hit came from an unsaved buffer. */
  unsaved?: boolean;
  /**
   * The hit's vault id (ADR-0051). Present on vault-backed hits (so a
   * cross-vault search can open the right file); may be absent on
   * unsaved-buffer hits from older callers that don't know it.
   */
  vaultId?: string;
}
