/**
 * `vault_read` (ADR-0071): one file as numbered lines — whole when it is
 * short, otherwise a range, with a last line that says how to continue.
 */
import { splitSections } from '../../../shared/note-sections';
import { ToolScope } from './scope';
import { fail, McpToolResult, ok, ToolVault } from './types';

export const READ_DEFAULT_LINES = 400;
export const READ_MAX_LINES = 1000;
/** A range stops early at this size — below the tool loop's own cap, so the continuation line survives. */
export const READ_MAX_CHARS = 12_000;

/** Files that are not text: reading them as text would hand the model noise. */
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|heic|pdf|zip|7z|gz|docx?|xlsx?|pptx?|msg|mp3|mp4|m4a|wav|mov|woff2?|ttf)$/i;

function positiveInt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : null;
}

const foldHeading = (text: string): string =>
  text.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The 1-based line range of the section under `heading`, or the headings to choose from. */
export function sectionRange(
  content: string,
  heading: string,
): { from: number; to: number } | { headings: string[] } {
  const total = content.split('\n').length;
  const sections = splitSections(content).filter((section) => section.level > 0);
  const wanted = foldHeading(heading);
  let index = sections.findIndex((section) => foldHeading(section.heading) === wanted);
  if (index === -1) {
    index = sections.findIndex((section) => foldHeading(section.heading).includes(wanted));
  }
  if (index === -1 || wanted === '') {
    return { headings: sections.map((section) => section.heading) };
  }
  // The section runs to the next heading of the same or a higher level:
  // its sub-sections belong to it.
  const { level } = sections[index];
  const next = sections.slice(index + 1).find((section) => section.level <= level);
  return { from: sections[index].line, to: next !== undefined ? next.line - 1 : total };
}

export async function vaultRead(
  vault: ToolVault,
  scope: ToolScope,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const located = scope.locate(args['path'], args['vault']);
  if ('error' in located) {
    return fail(located.error);
  }
  const { vault: target, path } = located;
  if (NOT_TEXT.test(path)) {
    return fail(`Error: ${path} is not a text file and cannot be read as one.`);
  }
  let content: string;
  try {
    content = (await vault.readFile(path, target.id)).content.replace(/\r\n/g, '\n');
  } catch {
    return fail(
      `Error: there is no file "${path}" in ${target.name}. Check the path with vault_list — paths are vault-relative and include the folder.`,
    );
  }
  const lines = content.split('\n');
  // A file ends with a line break: the empty piece after it is not a line.
  const total = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (content === '') {
    return ok(`${path} is empty.`);
  }

  let from = positiveInt(args['start_line']) ?? 1;
  let count = Math.min(READ_MAX_LINES, positiveInt(args['line_count']) ?? READ_DEFAULT_LINES);
  let section = '';
  if (typeof args['heading'] === 'string' && args['heading'].trim() !== '') {
    const range = sectionRange(content, args['heading']);
    if ('headings' in range) {
      return fail(
        range.headings.length === 0
          ? `Error: ${path} has no headings — read it by line range instead.`
          : `Error: no heading "${args['heading'].trim()}" in ${path}. Its headings: ${range.headings
              .map((heading) => `"${heading}"`)
              .join(', ')}.`,
      );
    }
    from = range.from;
    count = Math.min(READ_MAX_LINES, range.to - range.from + 1);
    section = ` — section "${args['heading'].trim()}"`;
  }
  if (from > total) {
    return fail(`Error: ${path} has only ${total} lines — start_line ${from} is past its end.`);
  }

  const out: string[] = [];
  let chars = 0;
  let last = from - 1;
  const end = Math.min(total, from + count - 1);
  for (let line = from; line <= end; line++) {
    const row = `${line}: ${lines[line - 1]}`;
    if (chars + row.length > READ_MAX_CHARS && out.length > 0) {
      break;
    }
    out.push(row);
    chars += row.length + 1;
    last = line;
  }
  const whole = from === 1 && last === total;
  const footer = whole
    ? `[${path}${section} — all ${total} lines]`
    : last < total
      ? `[${path}${section} — lines ${from}–${last} of ${total}. Continue with start_line=${last + 1}.]`
      : `[${path}${section} — lines ${from}–${last} of ${total}, the end of the file.]`;
  return ok(`${out.join('\n')}\n${footer}`);
}
