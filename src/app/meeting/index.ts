/**
 * `src/app/meeting` — renderer bridge for the calendar-invite import
 * (ADR-0041): decode a dropped `.ics` / `.msg` into a Markdown meeting
 * section (via the `meeting:*` IPC), and the "File → Import meeting …"
 * fallback.
 *
 * This barrel is the module's only public surface — import from
 * `../meeting`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export { MeetingService } from './meeting.service';
