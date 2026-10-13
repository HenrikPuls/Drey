/**
 * `src/app/vault` — the renderer's view of the active vault: `VaultService`
 * (the `window.dreyApi` file-tree / read / write wrapper, held as signals).
 * `DailyNoteService` opens documents, so it sits above `EditorService` in
 * `src/app/services/` — exporting it here closed an import cycle.
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../vault`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { VaultService } from './vault.service';
