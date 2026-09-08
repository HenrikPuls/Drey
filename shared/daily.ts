/**
 * Where a daily note lives in the vault, and the reverse mapping.
 *
 * Nested by year and month: `daily/2026/09/2026-09-06.md`. Notes created
 * before this scheme sit flat at `daily/2026-09-06.md` and stay readable --
 * `dailyDateFromPath` recognises both forms, `dailyPathFor` only ever
 * writes the nested one. `daily/` stays a structural folder, excluded from
 * tag routing and the tag overview (the `startsWith('daily/')` prefix
 * checks keep working unchanged for nested paths).
 */

const NESTED = /^daily\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\.md$/;
const FLAT = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/;

/** `2026-09-06` -> `daily/2026/09/2026-09-06.md`. Expects a valid `YYYY-MM-DD`. */
export function dailyPathFor(dateStr: string): string {
  const [year, month] = dateStr.split('-');
  return `daily/${year}/${month}/${dateStr}.md`;
}

/**
 * `daily/2026/09/2026-09-06.md` (or the legacy flat `daily/2026-09-06.md`)
 * -> `2026-09-06`; `null` for anything else. Accepts back-slash separators
 * so a raw OS path works too.
 */
export function dailyDateFromPath(relPath: string): string | null {
  const normalised = relPath.replace(/\\/g, '/');
  return NESTED.exec(normalised)?.[1] ?? FLAT.exec(normalised)?.[1] ?? null;
}
