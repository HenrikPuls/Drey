/**
 * The normalised shape a decoded calendar invite (`.ics` or `.msg`) is
 * reduced to before it is rendered into a Markdown meeting section. Kept
 * dependency-free and plainly serialisable so it can cross the IPC
 * boundary unchanged and be unit-tested without Electron.
 *
 * `start` / `end` are already **local wall-clock strings** — the timezone
 * maths (resolving an `.ics` `VTIMEZONE` / a `.msg` UTC field against the
 * machine clock) happens in `electron/meeting/` where the parser lives, so
 * nothing downstream has to know about time zones.
 */

export type MeetingSource = 'ics' | 'msg';

export interface MeetingPerson {
  /** Display name (`CN=` / recipient name), or `null` when only an address is known. */
  name: string | null;
  /** Bare e-mail address, `mailto:` stripped, or `null`. */
  email: string | null;
}

export interface MeetingAttachment {
  filename: string;
}

export interface ParsedMeeting {
  /** `SUMMARY` / subject, trimmed. Empty string when the invite carries no title. */
  title: string;
  /** Local `YYYY-MM-DD HH:mm`, or `YYYY-MM-DD` when `allDay`, or `null`. */
  start: string | null;
  /** Same shape as `start`. For an all-day range this is the last *included* day. */
  end: string | null;
  allDay: boolean;
  location: string | null;
  organizer: MeetingPerson | null;
  attendees: MeetingPerson[];
  /** First `http(s)` URL found in a join field, the location, or the body. */
  joinUrl: string | null;
  /** Plain-text body, CRLF-normalised, trailing whitespace trimmed. `null` when empty. */
  description: string | null;
  attachments: MeetingAttachment[];
  source: MeetingSource;
}
