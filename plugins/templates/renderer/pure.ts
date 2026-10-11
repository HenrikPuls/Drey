/**
 * The frontmatter strip the template previews need. A copy of the one in
 * `src/app/editor/markdown-frontmatter.ts`: a plugin renderer bundles from
 * its own folder and `shared/` only, never from `src/`.
 */

const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/;

/** `text` without its leading frontmatter block (plus following blank lines). */
export function stripFrontmatter(text: string): string {
  const match = FRONTMATTER.exec(text);
  return match ? text.slice(match[0].length).replace(/^\n+/, '') : text;
}
