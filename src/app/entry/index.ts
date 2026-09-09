/**
 * `src/app/entry` — the "Add entry" capture surface (ADR-0013):
 * `EntryDraftService` holds the draft (topic / text / tags, Autotag state)
 * and composes it into the active daily note via `EditorService`. The
 * `EntryDrawer` component that edits it is deep-imported by `EntryPanel` in
 * the dock (the one consumer) rather than re-exported here, to keep this
 * barrel free of the component import chain (`MarkdownSurface`,
 * `AutotagButton`, …), which would cycle back through `entry`.
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../entry`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { EntryDraftService } from './entry-draft.service';
