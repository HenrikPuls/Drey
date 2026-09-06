/**
 * `src/app/tags` — the renderer side of the path-based tag system: the tag
 * service (autocomplete data from the main-process index), the single
 * tag-input field with its inline "create tag?" confirmation, the
 * clickable `#tag` editor extension, and the Autotagging button.
 *
 * Scaffold only for now. Milestones 11a–11g build into this folder; the old
 * `src/app/services/tag.service.ts` and `src/app/editor/tag-complete.ts`
 * are removed once their replacements land. This barrel is the module's
 * only public surface — import from the `tags` barrel, never a file inside
 * it (enforced by `eslint.config.mjs`). Angular components stay imported by
 * their own path, as elsewhere.
 */

export {};
