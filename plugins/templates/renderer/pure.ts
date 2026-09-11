/**
 * Self-contained copies of the pure template helpers (ADR-0044: a plugin's
 * renderer bundle can only import from within its own `plugin://` root, so
 * `shared/placeholders.ts`, `shared/timestamp.ts` and the frontmatter strip
 * from `src/app/editor/markdown-frontmatter.ts` are duplicated here on
 * purpose). Keep in sync with the originals.
 */

/** `{{key}}` substitution; unknown tokens stay verbatim. */
export function substitutePlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : token,
  );
}

const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/;

/** `text` without its leading frontmatter block (plus following blank lines). */
export function stripFrontmatter(text: string): string {
  const match = FRONTMATTER.exec(text);
  return match ? text.slice(match[0].length).replace(/^\n+/, '') : text;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(date: Date): string {
  return `${formatDate(date)}T${formatTime(date)}:${pad(date.getSeconds())}`;
}
