/**
 * The vault tool set exposed over MCP (`electron/mcp/server.ts`) and
 * called in-process by the assistant plugin's tool-calling loop (through
 * the host's `ctx.llm.chat` vaultTools option). One definition, two
 * consumers -- see `docs/09_architecture_decisions/0021-mcp-vault-server.md`.
 *
 * Three tools:
 *  - `vault_search` -- tag + free-text search (the same matcher the
 *    sidebar uses) with an optional `regex` filter over the matched
 *    section text, or a standalone whole-vault regex line scan.
 *  - `vault_read`  -- one file's content, vault-relative path.
 *  - `vault_write` -- overwrite or append; gated by a confirmation
 *    callback unless "YOLO mode" is on.
 *
 * All filesystem access goes through `VaultManager`, so its vault-escape
 * guard (`..`, absolute paths, no active vault) applies unchanged.
 */
import type { AppConfig } from '../../shared/app-config';
import type { ToolSpec } from '../../shared/llm';
import type {
  SectionSearchProvider,
  SectionSearchScope,
  SdkTaskRecord,
  TagSearchHit,
  TaskQueryProvider,
} from '../../shared/plugin-api';
import type { VaultManager } from '../vault-manager';

/** JSON-Schema-ish tool descriptor, as MCP `tools/list` returns it. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A single content block of a `tools/call` result. */
export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** Asked before a `vault_write` hits disk (unless YOLO mode). `vaultId`/
 * `vaultName` are present when the write targets a non-default vault. */
export type ConfirmWrite = (request: {
  path: string;
  before: string;
  after: string;
  mode: 'overwrite' | 'append';
  vaultId?: string;
  vaultName?: string;
}) => Promise<boolean>;

export const VAULT_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'vault_search',
    description:
      'Search the note vault. Combine any of: `tags` (all must be present in a section), ' +
      '`text` (all whitespace-separated terms must appear), and `regex` (JavaScript regular ' +
      'expression). Sections are heading-delimited and cover every note, tagged or not. ' +
      'With only `regex`, every Markdown file is line-scanned; otherwise `regex` ' +
      'filters the matched sections. Returns file path, line and a snippet per hit.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tag names, without the #.',
        },
        text: { type: 'string', description: 'Free-text terms (AND).' },
        regex: { type: 'string', description: 'JavaScript regular expression source.' },
        regexFlags: { type: 'string', description: "Regex flags, e.g. 'i' or 'im'. Default 'i'." },
        maxResults: { type: 'number', description: 'Cap on returned hits (default 40, max 200).' },
        vault: {
          type: 'string',
          description:
            "Vault id, or \"all\" for every registered vault. Default: the active vault.",
        },
      },
    },
  },
  {
    name: 'vault_read',
    description:
      'Read one file from the vault. `path` is vault-relative (e.g. daily/2026-09-08.md); ' +
      '`vault` names the vault (see the registered vaults) and defaults to the active one.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        vault: {
          type: 'string',
          description: 'Vault id. Default: the active vault.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'vault_write',
    description:
      'Write a file in the vault. `mode` "overwrite" (default) replaces the whole file; ' +
      '"append" adds `content` to the end. Unless the app is in YOLO mode the user must ' +
      'confirm the change in a diff dialog first. `vault` names the target vault (see the ' +
      'registered vaults) and defaults to the active one.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path.' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['overwrite', 'append'] },
        vault: {
          type: 'string',
          description: 'Vault id. Default: the active vault.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'tasks_list',
    description:
      "List the user's tasks from the app's task index (checkbox and #task lines, with " +
      'due dates and priorities). One JSON object per line: path, vaultId, line, text, ' +
      'done, kind, heading, tags, due, priority, completed. Use it for any question ' +
      'about tasks, to-dos or deadlines — answer from this result instead of quoting ' +
      'task lines from other searches.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDone: { type: 'boolean', description: 'Include completed tasks. Default false.' },
        status: {
          type: 'string',
          enum: ['open', 'done', 'all'],
          description:
            'Open tasks, completed tasks, or both. Default "open". "done" lists newest completion first.',
        },
        completedSince: {
          type: 'string',
          description:
            'Only tasks completed on or after this date (YYYY-MM-DD). Implies status "done".',
        },
        vault: {
          type: 'string',
          description: 'Vault id to restrict to. Default: all registered vaults.',
        },
        text: {
          type: 'string',
          description: "Filter terms ALL of which must appear in a task's text or heading.",
        },
        tag: {
          type: 'string',
          description: 'Only tasks whose section carries this tag (subtags included).',
        },
        overdue: {
          type: 'boolean',
          description: 'Only tasks whose due date is before today. Default false.',
        },
        sort: {
          type: 'string',
          enum: ['importance', 'due', 'priority', 'file', 'completed'],
          description:
            'List order. Default "file": path + line. "importance" = due ascending, then priority. "completed" = completion date, newest first.',
        },
      },
    },
  },
];

const DEFAULT_MAX_RESULTS = 40;
const HARD_MAX_RESULTS = 200;
/** `tasks_list` row cap (JSON lines to the model; the panel renders fewer). */
const TASKS_MAX_RESULTS = 200;
/** Whole-vault regex scan guards -- a single-user local tool, but still bounded. */
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_BYTES_PER_FILE = 512 * 1024;

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError: isError || undefined };
}

/** `path:line — heading` + snippet, one per hit. `labelVaults` prefixes the
 * vault id (the cross-vault scopes; the default active-vault search keeps
 * the bare, backward-compatible paths). */
function formatHits(hits: readonly TagSearchHit[], limit: number, labelVaults = false): string {
  if (hits.length === 0) {
    return 'No matches.';
  }
  const shown = hits.slice(0, limit);
  const where = (hit: TagSearchHit): string =>
    labelVaults && hit.vaultId !== undefined ? `${hit.vaultId}:${hit.path}` : hit.path;
  const body = shown
    .map((hit) => `${where(hit)}:${hit.line} — ${hit.heading}\n  ${hit.snippet}`)
    .join('\n\n');
  const more = hits.length > shown.length ? `\n\n(+${hits.length - shown.length} more)` : '';
  return `${shown.length} of ${hits.length} hit${hits.length === 1 ? '' : 's'}:\n\n${body}${more}`;
}

/**
 * The optional `vault` argument of `vault_read`/`vault_write`: a vault id.
 * `"all"` is meaningless for a single-file tool and is rejected explicitly,
 * so the model corrects itself instead of silently hitting the active vault.
 */
function vaultIdArg(raw: unknown, tool: string): string | undefined | { error: string } {
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  if (raw === 'all') {
    return { error: `"all" is not valid for ${tool} — pass one vault id.` };
  }
  return raw;
}

function compileRegex(source: unknown, flags: unknown): RegExp | { error: string } {
  if (typeof source !== 'string' || source === '') {
    return { error: 'regex must be a non-empty string' };
  }
  const f = typeof flags === 'string' && flags !== '' ? flags : 'i';
  try {
    // `lastIndex` is reset before every test(), so a stray `g` flag is harmless.
    return new RegExp(source, f);
  } catch (err) {
    return { error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export class VaultTools {
  constructor(
    private readonly vault: VaultManager,
    /**
     * The section-search seam (ADR-0044 stage 2): `vault_search` reads
     * whichever provider a plugin registered (until stage 5, the base
     * adapter registers the tag index). `null` degrades the tool with a
     * clear error instead of crashing.
     */
    private readonly getSearchProvider: () => SectionSearchProvider | null,
    /**
     * The task-index seam (SDK 1.11): `tasks_list` reads whichever
     * provider the tasks plugin registered. `null` degrades the tool.
     */
    private readonly getTaskProvider: () => TaskQueryProvider | null,
    private readonly getConfig: () => AppConfig,
    private readonly confirmWrite: ConfirmWrite,
    /** Called with the written path (and its vault id, ADR-0051) after a
     * write lands, so the plugins' index stays current and the renderer
     * refreshes (ADR-0045 round). */
    private readonly onVaultChanged: (path: string, vaultId?: string) => void = () => {},
  ) {}

  /** The `tools/list` payload (MCP shape). */
  list(): readonly McpToolDef[] {
    return VAULT_TOOL_DEFS;
  }

  /**
   * The same tools as canonical `ToolSpec`s (ADR-0047) for the assistant's
   * tool-calling loop; the OpenAI/Anthropic wire wrapping happens in the
   * provider adapters.
   */
  toolSpecs(): ToolSpec[] {
    return VAULT_TOOL_DEFS.map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
    }));
  }

  /** Runs one tool by name. Unknown names and bad arguments come back as `isError` text. */
  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      switch (name) {
        case 'vault_search':
          return await this.search(args);
        case 'vault_read':
          return await this.read(args);
        case 'vault_write':
          return await this.write(args);
        case 'tasks_list':
          return await this.tasksList(args);
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** One JSON object per line — the same shape the assistant's own
   * `tasks_list` tool emits, so consumers parse one format. */
  private async tasksList(args: Record<string, unknown>): Promise<McpToolResult> {
    const provider = this.getTaskProvider();
    if (provider === null) {
      return textResult(
        'Tasks are unavailable: no plugin providing the task index is enabled.',
        true,
      );
    }
    const vaultArg = args['vault'];
    const textArg = typeof args['text'] === 'string' && args['text'].trim() !== '' ? args['text'].trim() : undefined;
    // The leading `#` is accepted (and stripped) like the assistant's own
    // tasks_list tool — one call convention for the same provider.
    const tagArg =
      typeof args['tag'] === 'string' && args['tag'].trim().replace(/^#/, '') !== ''
        ? args['tag'].trim().replace(/^#/, '')
        : undefined;
    const sortArg = args['sort'];
    const sinceArg =
      typeof args['completedSince'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args['completedSince'])
        ? args['completedSince']
        : undefined;
    const statusArg = args['status'];
    // A completion-date restriction only makes sense over completed tasks.
    const status =
      sinceArg !== undefined
        ? 'done'
        : statusArg === 'open' || statusArg === 'done' || statusArg === 'all'
          ? statusArg
          : undefined;
    const records = await provider.query({
      includeDone: args['includeDone'] === true,
      ...(status !== undefined ? { status } : {}),
      ...(sinceArg !== undefined ? { completedSince: sinceArg } : {}),
      ...(typeof vaultArg === 'string' && vaultArg !== '' && vaultArg !== 'all'
        ? { vaultId: vaultArg }
        : {}),
      ...(textArg !== undefined ? { text: textArg } : {}),
      ...(tagArg !== undefined ? { tag: tagArg } : {}),
      ...(args['overdue'] === true ? { overdue: true } : {}),
      ...(sortArg === 'importance' ||
      sortArg === 'due' ||
      sortArg === 'priority' ||
      sortArg === 'file' ||
      sortArg === 'completed'
        ? { sort: sortArg }
        : status === 'done'
          ? { sort: 'completed' as const }
          : {}),
    });
    if (records.length === 0) {
      return textResult('No tasks found.');
    }
    const shown = records.slice(0, TASKS_MAX_RESULTS);
    const lines = shown.map((task) => JSON.stringify(task));
    if (records.length > shown.length) {
      lines.push(`{"truncated": ${records.length - shown.length}}`);
    }
    return textResult(lines.join('\n'));
  }

  private async search(args: Record<string, unknown>): Promise<McpToolResult> {
    const tags = Array.isArray(args['tags'])
      ? (args['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const wantRegex = typeof args['regex'] === 'string' && args['regex'] !== '';
    const limit = Math.min(
      HARD_MAX_RESULTS,
      typeof args['maxResults'] === 'number' && args['maxResults'] > 0
        ? Math.floor(args['maxResults'])
        : DEFAULT_MAX_RESULTS,
    );

    let regex: RegExp | null = null;
    if (wantRegex) {
      const compiled = compileRegex(args['regex'], args['regexFlags']);
      if ('error' in compiled) {
        return textResult(compiled.error, true);
      }
      regex = compiled;
    }

    if (tags.length === 0 && text === '') {
      if (!regex) {
        return textResult('Provide at least one of: tags, text, regex.', true);
      }
      return this.regexScan(regex, limit, this.scopeFromVaultArg(args['vault']));
    }

    const provider = this.getSearchProvider();
    if (provider === null) {
      return textResult(
        'Section search is unavailable: no plugin providing the tag/section index is enabled.',
        true,
      );
    }
    const scope = this.scopeFromVaultArg(args['vault']);
    let hits = await provider.search({ tags, text }, scope);
    if (regex) {
      const re = regex;
      hits = hits.filter((hit) => {
        re.lastIndex = 0;
        return re.test(hit.text);
      });
    }
    // Cross-vault scopes label every hit with its vault, so the model can
    // read the file back through `vault_read`'s own `vault` argument.
    return textResult(formatHits(hits, limit, scope !== undefined));
  }

  /**
   * The optional `vault` argument (milestone 33) as a section-search scope:
   * a vault id names that vault, `"all"` spans every registered one, and an
   * absent argument is the provider's default (the active vault).
   */
  private scopeFromVaultArg(raw: unknown): SectionSearchScope | undefined {
    if (typeof raw !== 'string' || raw === '') {
      return undefined;
    }
    return raw === 'all' ? { kind: 'all' } : { kind: 'vault', vaultId: raw };
  }

  /** Line-by-line regex scan across Markdown files (the "grep the vault" path). */
  private async regexScan(
    regex: RegExp,
    limit: number,
    scope?: SectionSearchScope,
  ): Promise<McpToolResult> {
    // The all-vaults variant stamps every file with its vault id, so an
    // ambiguous relative path stays attributable in the output.
    const files =
      scope === undefined
        ? (await this.vault.listMarkdownFiles()).map((path) => ({ vaultId: undefined, path }))
        : scope.kind === 'all'
          ? await this.vault.listAllMarkdownFiles()
          : (await this.vault.listMarkdownFiles(scope.vaultId)).map((path) => ({
              vaultId: scope.vaultId,
              path,
            }));
    const label = (file: { vaultId?: string; path: string }): string =>
      file.vaultId !== undefined ? `${file.vaultId}:${file.path}` : file.path;
    const lines: string[] = [];
    let scanned = 0;
    for (const file of files.slice(0, SCAN_MAX_FILES)) {
      let content: string;
      try {
        content = (await this.vault.readFile(file.path, file.vaultId)).content;
      } catch {
        continue;
      }
      if (content.length > SCAN_MAX_BYTES_PER_FILE) {
        content = content.slice(0, SCAN_MAX_BYTES_PER_FILE);
      }
      scanned++;
      const fileLines = content.split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(fileLines[i])) {
          lines.push(`${label(file)}:${i + 1}: ${fileLines[i].trim().slice(0, 200)}`);
          if (lines.length >= limit) {
            return textResult(
              `${lines.length}+ matching lines (scan capped):\n\n${lines.join('\n')}`,
            );
          }
        }
      }
    }
    return lines.length === 0
      ? textResult(`No lines matched /${regex.source}/${regex.flags} in ${scanned} files.`)
      : textResult(`${lines.length} matching line(s):\n\n${lines.join('\n')}`);
  }

  private async read(args: Record<string, unknown>): Promise<McpToolResult> {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    if (path === '') {
      return textResult('path is required', true);
    }
    const vaultArg = vaultIdArg(args['vault'], 'vault_read');
    if (typeof vaultArg === 'object') {
      return textResult(vaultArg.error, true);
    }
    const { content } = await this.vault.readFile(path, vaultArg);
    return textResult(content);
  }

  private async write(args: Record<string, unknown>): Promise<McpToolResult> {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    const content = typeof args['content'] === 'string' ? args['content'] : null;
    const mode = args['mode'] === 'append' ? 'append' : 'overwrite';
    if (path === '' || content === null) {
      return textResult('path and content are required', true);
    }
    const vaultArg = vaultIdArg(args['vault'], 'vault_write');
    if (typeof vaultArg === 'object') {
      return textResult(vaultArg.error, true);
    }

    let before = '';
    try {
      before = (await this.vault.readFile(path, vaultArg)).content;
    } catch {
      before = ''; // new file
    }
    const after =
      mode === 'append'
        ? before === '' || before.endsWith('\n')
          ? before + content
          : `${before}\n${content}`
        : content;

    if (after === before) {
      return textResult('No change — the file already has this content.');
    }

    if (!this.getConfig().mcp.yolo) {
      const approved = await this.confirmWrite({
        path,
        before,
        after,
        mode,
        ...(vaultArg !== undefined
          ? { vaultId: vaultArg, vaultName: this.vaultName(vaultArg) }
          : {}),
      });
      if (!approved) {
        return textResult('The user declined the write.', true);
      }
    }

    const vaultId = this.vault.resolveVaultId(vaultArg);
    await this.vault.writeFile(path, after, vaultId, { origin: 'mcp' });
    // The write itself went through the vault manager (own-write ledger),
    // so the watcher suppresses the echo; this announcement keeps the
    // section index current for a follow-up search and nudges the renderer.
    this.onVaultChanged(path, vaultId);
    const where = vaultArg !== undefined ? `${vaultArg}:${path}` : path;
    return textResult(`Wrote ${where} (${after.length} chars, mode: ${mode}).`);
  }

  /** A vault's display name for the confirmation dialog; falls back to the id. */
  private vaultName(vaultId: string): string {
    return this.vault.listVaults().find((entry) => entry.id === vaultId)?.name ?? vaultId;
  }
}
