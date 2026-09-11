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
}

/** Tags (AND) plus free-text terms (AND) over heading-tagged sections. */
export interface TagSearchQuery {
  tags: readonly string[];
  text: string;
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
}
