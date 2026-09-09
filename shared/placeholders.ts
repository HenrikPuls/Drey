/**
 * `{{key}}` template substitution, shared by the daily-note template
 * (`electron/daily-note.ts`) and the "Add entry" templates
 * (`shared/entry-compose.ts`). Deliberately dumb: it replaces the keys it
 * is given and leaves any other `{{token}}` untouched, so an unknown
 * placeholder shows up verbatim rather than vanishing.
 */

/** Replaces `{{key}}` for every key in `values`; unknown tokens are left as-is. */
export function substitutePlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : token,
  );
}
