/**
 * `src/app/tags` — the renderer side of the tag system: the search query
 * service, the sidebar `SearchPanel`, and (11.7) the Autotagging button.
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../tags`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { TagSearchService } from './tag-search.service';
export { SearchPanel } from './search-panel/search-panel';
