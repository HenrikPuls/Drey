/**
 * `shared/tags` — the pure, IPC-crossing tag logic: heading-section
 * splitting, inline-`#tag` extraction (names and positions), and (from
 * 11.4) the tag-search matcher + snippet builder.
 *
 * This barrel is the module's only public surface — import from
 * `shared/tags`, never a file inside it (enforced by `eslint.config.mjs`).
 * Internal files import their siblings directly.
 */

export type { Section } from './sections';
export { splitSections } from './sections';

export { extractInlineTags, extractTagOccurrences, TAG_NAME_SOURCE } from './tags';

export type { SearchableSection, TagSearchHit, TagSearchQuery } from './search';
export { formatSearchResultsDoc, runTagSearch } from './search';
