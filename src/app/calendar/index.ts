/**
 * `src/app/calendar` — the sidebar mini-calendar: `CalendarService` holds
 * the shown month + selected day and the note-dot lookup against the vault
 * file tree. The `Calendar` component that renders the grid is deep-imported
 * by `CalendarPanel` in the dock (the one consumer) rather than re-exported
 * here, to keep this barrel service-only.
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../calendar`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { CalendarService, type CalendarDay } from './calendar.service';
