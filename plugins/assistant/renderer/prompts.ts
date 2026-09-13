/**
 * The prompt picker's data model (req: pick a prompt from the templates
 * folder instead of the removed auto-summary). A prompt is a Markdown
 * file under `templates/prompts/` in the active vault, in the owner's
 * format:
 *
 *     # Titel
 *     > Beschreibung
 *     ...the prompt...
 *
 * The first `# ` line is the title; the next non-empty line, when it
 * starts with `> `, is the description (stripped); everything after that
 * is the raw prompt body (inserted verbatim — no placeholder
 * substitution). A file without a `#` heading falls back to its file
 * name; a missing description is `""`.
 *
 * Pure string in, pure string out, so the unit spec can drive it without
 * a DOM or plugin host.
 */

/** The vault folder the picker reads; also its Templates-panel category. */
export const PROMPTS_DIR = 'templates/prompts';

export interface PromptEntry {
  /** Vault-relative path, e.g. `templates/prompts/review.md`. */
  readonly path: string;
  /** The `# ` heading, or the file name (sans `.md`) when absent. */
  readonly title: string;
  /** The `> ` line, stripped; `""` when absent. */
  readonly description: string;
  /** The prompt text after the header block, verbatim, trimmed. */
  readonly body: string;
}

/** `templates/prompts/review.md` -> `review` (the title fallback). */
export function promptTitleFallback(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

/**
 * Parses one prompt file's text. Blank lines between the parts are
 * tolerated; anything after the description is body, verbatim (only the
 * leading blank lines between description and body are dropped).
 */
export function parsePromptFile(path: string, text: string): PromptEntry {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  let index = 0;
  let title: string | null = null;
  // Skip leading blanks, then take an optional `# ` heading.
  while (index < lines.length && lines[index].trim() === '') {
    index++;
  }
  if (index < lines.length && lines[index].startsWith('# ')) {
    title = lines[index].slice(2).trim();
    index++;
  }
  title ??= promptTitleFallback(path);

  // Skip blanks, then take an optional `> ` description line.
  while (index < lines.length && lines[index].trim() === '') {
    index++;
  }
  let description = '';
  if (index < lines.length && lines[index].startsWith('> ')) {
    description = lines[index].slice(2).trim();
    index++;
  }

  const body = lines
    .slice(index)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');

  return { path, title, description, body };
}

/** The picker list: the folder's `.md` files, parsed, sorted by title. */
export function promptEntriesFrom(
  paths: readonly string[],
  read: (path: string) => Promise<string>,
): Promise<PromptEntry[]> {
  const inFolder = paths.filter(
    (path) => path.startsWith(`${PROMPTS_DIR}/`) && path.toLowerCase().endsWith('.md'),
  );
  return Promise.all(
    inFolder.map(async (path) => parsePromptFile(path, await read(path))),
  ).then((entries) =>
    entries.sort((a, b) => a.title.localeCompare(b.title)),
  );
}
