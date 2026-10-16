/**
 * `src/app/keybindings` — the app-wide keyboard-command registry: a
 * `Command` shape and the `KeybindingService` that maps chord strings onto
 * commands via one capture-phase listener, through the user's overrides
 * (ADR-0073).
 *
 * This barrel is the module's only public surface — import from
 * `../keybindings`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export type { Command } from './command';
export { formatChord } from './command';
export { KeybindingService } from './keybinding.service';
