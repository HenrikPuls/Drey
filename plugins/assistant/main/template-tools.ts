/**
 * The template_* plugin tools (SDK 1.14): the model manages the vault's
 * template library — the configured `templates.dir` (default `templates/`)
 * — directly: list, read, write, delete. Writes and deletes ride the
 * announced vault round, so the Templates panel, the slash menu and the
 * Mod+T picker pick the change up immediately (the library reloads on
 * every `vault:changed`).
 *
 * Unlike the vault_* set this tier is NOT gated on `mcp.enabled`, and —
 * per the ADR-0011 later-change — needs no confirmation: template files
 * are small structural content outside the tag index (never user notes),
 * and a delete lands in the OS recycle bin.
 *
 * Guards are baked into the pure path resolver: names may carry
 * subfolders (a category in the Templates panel), `..`/absolute escapes
 * are refused, the top-level `prompts/` subfolder is reserved for the
 * composer prompt picker's own file format, and `daily.md` (the
 * daily-note seed) can be overwritten but never deleted.
 *
 * Handlers never throw — errors return as text so the model can
 * self-correct (the live-edit convention).
 */
import type { ToolSpec } from '../../../shared/llm';

/** The daily-note seed template — user-deletable, agent-refused. */
export const DAILY_TEMPLATE_FILE = 'daily.md';

/** The composer prompt picker's reserved top-level subfolder (prompts.ts twin). */
export const PROMPTS_SUBDIR = 'prompts';

/** Row cap for one `template_list` result. */
const LIST_MAX = 200;

/** Body cap for one `template_read` result (characters). */
const READ_MAX = 20_000;

/** The vault-relative template folder, normalized: forward slashes, no edges. */
export function normalizeTemplateDir(dir: string | undefined): string {
  const cleaned = (dir ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return cleaned === '' ? 'templates' : cleaned;
}

/** `resolveTemplate`'s outcome: a vault-relative path, or why the name was refused. */
export type ResolvedTemplate = { path: string } | { refused: string };

/**
 * Resolves a model-supplied template name to a vault-relative path under
 * the template folder. A missing `.md` suffix is appended (the library
 * only lists Markdown); subfolders are allowed and become categories.
 */
export function resolveTemplate(templatesDir: string | undefined, name: string): ResolvedTemplate {
  const dir = normalizeTemplateDir(templatesDir);
  const normalized = (name ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(normalized)) {
    return { refused: `"${name}" is not a name inside the template folder — pass a relative name like "meeting-notes".` };
  }
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) {
    return { refused: 'The template name is empty.' };
  }
  if (segments.some((s) => s === '..')) {
    return { refused: `"${name}" escapes the template folder.` };
  }
  if (segments[0].toLowerCase() === PROMPTS_SUBDIR) {
    return {
      refused:
        '"prompts/" is reserved for the composer prompt picker (files with a "# Title" / "> Description" header) — use a different folder.',
    };
  }
  const last = segments.length - 1;
  if (!segments[last].toLowerCase().endsWith('.md')) {
    segments[last] = `${segments[last]}.md`;
  }
  return { path: `${dir}/${segments.join('/')}` };
}

/** The sorted template paths a flat `.md` listing carries under the folder. */
export function templatePathsInDir(templatesDir: string | undefined, files: readonly string[]): string[] {
  const prefix = `${normalizeTemplateDir(templatesDir)}/`;
  return files
    .filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

/** What the tools need from the host; built from the plugin context per ask. */
export interface TemplateToolsPort {
  /** The configured template folder (vault-relative), e.g. `templates`. */
  templatesDir(): string | undefined;
  /** Flat walk of the vault's `.md` files (the library listing + existence check). */
  listMarkdownFiles(): Promise<readonly string[]>;
  read(path: string): Promise<string>;
  /** Announced write — the templates UI reloads on the same round. */
  writeAnnounced(path: string, content: string): Promise<unknown>;
  /** Announced delete to the recycle bin; resolves `true` when trashed. */
  remove(path: string): Promise<boolean>;
}

/** The tool bundle one ask carries: specs for the wire, names for dispatch. */
export interface TemplateTools {
  specs: readonly ToolSpec[];
  names: ReadonlySet<string>;
  run(name: string, argsJson: string): Promise<string>;
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the shared malformed-args error.
  }
  throw new Error(`Could not parse arguments: ${argsJson}`);
}

function nameArg(args: Record<string, unknown>): string {
  const name = args['name'];
  return typeof name === 'string' ? name : '';
}

function buildSpecs(dir: string): readonly ToolSpec[] {
  return [
    {
      name: 'template_list',
      description:
        `List the templates in the user's template library (the \`${dir}/\` folder of the ` +
        'active vault). One vault-relative path per line. Templates are reusable Markdown ' +
        'blocks the user inserts into notes via the slash menu, Mod+T or the Templates ' +
        'panel. Call this before creating a template so you do not duplicate one, and to ' +
        'find fitting names and categories.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'template_read',
      description:
        "Read one template's Markdown source from the library. Pass \"name\" relative to " +
        'the library root, subfolders allowed, ".md" optional — e.g. "meeting-notes" or ' +
        '"meetings/retro".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The template name, e.g. "meetings/retro".' },
        },
        required: ['name'],
      },
    },
    {
      name: 'template_write',
      description:
        `Create or replace one template in the user's template library (the \`${dir}/\` ` +
        'folder). Pass "name" (relative to the library root; subfolders become categories ' +
        'in the Templates panel, ".md" is appended when missing), "content" (the FULL ' +
        'Markdown body) and "overwrite" (REQUIRED boolean: false creates only and fails ' +
        'when the template exists; true replaces an existing template). The content may ' +
        'use the placeholders {{date}}, {{time}}, {{datetime}} and {{title}}, which the ' +
        'app substitutes when the template is inserted. Writing applies immediately — ' +
        'there is no confirmation step.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The template name, e.g. "meetings/retro".' },
          content: { type: 'string', description: 'The full Markdown body of the template.' },
          overwrite: {
            type: 'boolean',
            description:
              'false (default): create only — fails when a template with this name exists. ' +
              'true: replace an existing template.',
          },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'template_delete',
      description:
        'Delete one template from the library (it moves to the OS recycle bin). Pass ' +
        `"name" like template_read. The daily-note seed \`${dir}/${DAILY_TEMPLATE_FILE}\` ` +
        'is refused — it is app-managed.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The template name, e.g. "meetings/retro".' },
        },
        required: ['name'],
      },
    },
  ];
}

/** Builds the template tool bundle against one port (fresh per ask — the folder is configurable). */
export function createTemplateTools(port: TemplateToolsPort): TemplateTools {
  const dir = normalizeTemplateDir(port.templatesDir());
  const specs = buildSpecs(dir);
  const names = new Set(specs.map((spec) => spec.name));

  const existingPaths = async (): Promise<Set<string>> =>
    new Set(templatePathsInDir(dir, await port.listMarkdownFiles()));

  const list = async (): Promise<string> => {
    const paths = templatePathsInDir(dir, await port.listMarkdownFiles());
    if (paths.length === 0) {
      return `The template library (${dir}/) is empty.`;
    }
    const shown = paths.slice(0, LIST_MAX);
    const lines = [...shown];
    if (paths.length > shown.length) {
      lines.push(`(${paths.length - shown.length} more)`);
    }
    return lines.join('\n');
  };

  const read = async (argsJson: string): Promise<string> => {
    const resolved = resolveTemplate(dir, nameArg(parseArgs(argsJson)));
    if ('refused' in resolved) {
      return resolved.refused;
    }
    if (!(await existingPaths()).has(resolved.path)) {
      return `No template at ${resolved.path}. Call template_list to see the library.`;
    }
    const body = await port.read(resolved.path);
    if (body.length > READ_MAX) {
      return `${body.slice(0, READ_MAX)}\n(truncated at ${READ_MAX} characters)`;
    }
    return body;
  };

  const write = async (argsJson: string): Promise<string> => {
    const args = parseArgs(argsJson);
    const content = typeof args['content'] === 'string' ? args['content'] : '';
    if (content.trim() === '') {
      return 'template_write needs a non-empty "content" (the Markdown body).';
    }
    const resolved = resolveTemplate(dir, nameArg(args));
    if ('refused' in resolved) {
      return resolved.refused;
    }
    const overwrite = args['overwrite'] === true;
    const exists = (await existingPaths()).has(resolved.path);
    if (exists && !overwrite) {
      return `A template already exists at ${resolved.path}. Pass "overwrite": true to replace it, or choose another name.`;
    }
    await port.writeAnnounced(resolved.path, content);
    return exists
      ? `Replaced the template ${resolved.path}.`
      : `Created the template ${resolved.path}. It is available in the Templates panel, the slash menu and Mod+T immediately.`;
  };

  const remove = async (argsJson: string): Promise<string> => {
    const resolved = resolveTemplate(dir, nameArg(parseArgs(argsJson)));
    if ('refused' in resolved) {
      return resolved.refused;
    }
    if (resolved.path === `${dir}/${DAILY_TEMPLATE_FILE}`) {
      return `Refusing to delete ${resolved.path} — it seeds new daily notes. Edit it instead.`;
    }
    if (!(await existingPaths()).has(resolved.path)) {
      return `No template at ${resolved.path}.`;
    }
    const trashed = await port.remove(resolved.path);
    return trashed
      ? `Deleted the template ${resolved.path} (moved to the recycle bin).`
      : `Deleted the template ${resolved.path} (removed permanently — this volume has no recycle bin).`;
  };

  const run = async (name: string, argsJson: string): Promise<string> => {
    try {
      switch (name) {
        case 'template_list':
          return await list();
        case 'template_read':
          return await read(argsJson);
        case 'template_write':
          return await write(argsJson);
        case 'template_delete':
          return await remove(argsJson);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return { specs, names, run };
}
