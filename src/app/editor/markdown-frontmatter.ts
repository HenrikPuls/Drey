/**
 * A leading YAML frontmatter block -- `---` ... `---` as the very first thing
 * in the file. Only a fence at offset 0 counts; a `---` further down is a
 * horizontal rule and stays. The editor buffer is always held in `\n` form,
 * so a plain `\n` match is enough.
 *
 * Its own module so `EditorService` (strips it before word count / save) and
 * the Live Preview decoration layer (must not decorate inside it) share one
 * definition without importing each other.
 */
const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/;

/**
 * Character length of the leading frontmatter block (including its closing
 * fence and trailing newline), or `0` when the text has none. The decoration
 * builder treats `[0, frontmatterEnd)` as an inert region.
 */
export function frontmatterEnd(text: string): number {
  const match = FRONTMATTER.exec(text);
  return match ? match[0].length : 0;
}

/**
 * `text` with any leading frontmatter block removed, plus the blank lines
 * directly after it. Pure; exported for direct testing.
 */
export function stripFrontmatter(text: string): string {
  const end = frontmatterEnd(text);
  return end ? text.slice(end).replace(/^\n+/, '') : text;
}

/** A top-level `key:` line inside the block (not indented, not a `#` comment). */
const FRONTMATTER_KEY = /^[^\s#][^:]*:(\s|$)/;

/**
 * Count of top-level keys in the leading frontmatter block (`0` when there is
 * none). A shallow line scan -- enough for the fold pill's "N fields" label;
 * nested keys and keys buried in multi-line values are not counted.
 */
export function frontmatterFieldCount(text: string): number {
  const end = frontmatterEnd(text);
  if (end === 0) {
    return 0;
  }
  let count = 0;
  const lines = text.slice(0, end).split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      break; // closing fence
    }
    if (FRONTMATTER_KEY.test(lines[i])) {
      count++;
    }
  }
  return count;
}
