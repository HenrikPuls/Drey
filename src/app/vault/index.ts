/**
 * `src/app/vault` — the renderer's view of the active vault: `VaultService`
 * (the `window.dreyApi` file-tree / read / write wrapper, held as signals)
 * and `DailyNoteService` (the quick-capture hotkey bridge).
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../vault`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { VaultService } from './vault.service';
export { DailyNoteService } from './daily-note.service';
