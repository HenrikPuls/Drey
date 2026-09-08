/**
 * `electron/tags` — the main-process tag index and (from 11.4) the search /
 * result-summary handlers.
 *
 * This barrel is the module's only public surface — import from `./tags`,
 * never a file inside it (enforced by `eslint.config.mjs`).
 */

export { TagIndex } from './tag-index';
export type { SectionRecord } from './tag-index';
