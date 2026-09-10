/**
 * `electron/meeting` — decodes a dropped / picked `.ics` or `.msg` invite
 * into a Markdown meeting section. Sole holder of the `ical.js` and
 * `@kenjiuno/msgreader` dependencies; the pure rendering logic lives in
 * `shared/meeting`.
 *
 * This barrel is the module's only public surface — import from
 * `./meeting`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export { MeetingImporter } from './meeting-importer';
