/**
 * Where a daily note lives in the vault, and the reverse mapping.
 *
 * The root folder is configurable (`AppConfig.daily.dir`, default
 * {@link DEFAULT_DAILY_DIR}); nested by year and month underneath it:
 * `<dir>/2026/09/2026-09-06.md`. The nesting and the `YYYY-MM-DD.md` file
 * name are fixed -- they are the grammar the calendar matches against.
 * Notes created before this scheme sit flat at `<dir>/2026-09-06.md` and
 * stay readable -- `dailyDateFromPath` recognises both forms,
 * `dailyPathFor` only ever writes the nested one. Only the configured root
 * is ever read: changing the setting orphans whatever an older setting
 * wrote (no migration).
 */

/** Default vault-relative root folder for daily notes (`AppConfig.daily.dir`). */
export const DEFAULT_DAILY_DIR = 'daily';

/** Regex metacharacters in a folder name must not become wildcards (`My.Notes`). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `2026-09-06` -> `<dir>/2026/09/2026-09-06.md`. Expects a valid `YYYY-MM-DD`. */
export function dailyPathFor(dateStr: string, dir: string = DEFAULT_DAILY_DIR): string {
  const [year, month] = dateStr.split('-');
  return `${dir}/${year}/${month}/${dateStr}.md`;
}

/**
 * `<dir>/2026/09/2026-09-06.md` (or the legacy flat `<dir>/2026-09-06.md`)
 * -> `2026-09-06`; `null` for anything else -- including daily-note paths
 * under a *different* root. Accepts back-slash separators so a raw OS path
 * works too.
 */
export function dailyDateFromPath(
  relPath: string,
  dir: string = DEFAULT_DAILY_DIR,
): string | null {
  const normalised = relPath.replace(/\\/g, '/');
  const root = escapeRegExp(dir);
  const nested = new RegExp(`^${root}/\\d{4}/\\d{2}/(\\d{4}-\\d{2}-\\d{2})\\.md$`);
  const flat = new RegExp(`^${root}/(\\d{4}-\\d{2}-\\d{2})\\.md$`);
  return nested.exec(normalised)?.[1] ?? flat.exec(normalised)?.[1] ?? null;
}
