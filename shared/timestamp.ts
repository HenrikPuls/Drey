/**
 * Date/time formatting helpers, matching the conventions in
 * `specs/frontmatter-schema.md`. Pure string functions, no dependencies --
 * lives in `shared/` because both the main process (template placeholder
 * substitution, `electron/daily-note.ts`) and the renderer (the `## HH:mm`
 * entry heading the editor appends) need them.
 *
 * Local time, never UTC: these values are read by a human and drive the
 * day view, so they must match the wall clock of the machine the note was
 * written on.
 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-09-05` -- schema `created` fields, daily-note filenames. */
export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `14:32` -- entry headings inside a note body. */
export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `2026-09-05T14:32:00` -- schema `updated` fields. */
export function formatDateTime(date: Date): string {
  return `${formatDate(date)}T${formatTime(date)}:${pad(date.getSeconds())}`;
}

/** `2026-09-05 14:32` -- timestamp heading form used in master/notiz History. */
export function formatTimestamp(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}
