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
import type { SectionSearchProvider, TagSearchHit } from '../../shared/plugin-api';
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

/** Asked before a `vault_write` hits disk (unless YOLO mode). */
export type ConfirmWrite = (request: {
  path: string;
  before: string;
  after: string;
  mode: 'overwrite' | 'append';
}) => Promise<boolean>;

export const VAULT_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'vault_search',
    description:
      'Search the note vault. Combine any of: `tags` (all must be present in a section), ' +
      '`text` (all whitespace-separated terms must appear), and `regex` (JavaScript regular ' +
      'expression). With only `regex`, every Markdown file is line-scanned; otherwise `regex` ' +
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
      },
    },
  },
  {
    name: 'vault_read',
    description:
      'Read one file from the vault. `path` is vault-relative (e.g. daily/2026-09-08.md).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'vault_write',
    description:
      'Write a file in the vault. `mode` "overwrite" (default) replaces the whole file; ' +
      '"append" adds `content` to the end. Unless the app is in YOLO mode the user must ' +
      'confirm the change in a diff dialog first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path.' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['overwrite', 'append'] },
      },
      required: ['path', 'content'],
    },
  },
];

const DEFAULT_MAX_RESULTS = 40;
const HARD_MAX_RESULTS = 200;
/** Whole-vault regex scan guards -- a single-user local tool, but still bounded. */
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_BYTES_PER_FILE = 512 * 1024;

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError: isError || undefined };
}

/** `path:line — heading` + snippet, one per hit. */
function formatHits(hits: readonly TagSearchHit[], limit: number): string {
  if (hits.length === 0) {
    return 'No matches.';
  }
  const shown = hits.slice(0, limit);
  const body = shown
    .map((hit) => `${hit.path}:${hit.line} — ${hit.heading}\n  ${hit.snippet}`)
    .join('\n\n');
  const more = hits.length > shown.length ? `\n\n(+${hits.length - shown.length} more)` : '';
  return `${shown.length} of ${hits.length} hit${hits.length === 1 ? '' : 's'}:\n\n${body}${more}`;
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
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
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
      return this.regexScan(regex, limit);
    }

    const provider = this.getSearchProvider();
    if (provider === null) {
      return textResult(
        'Section search is unavailable: no plugin providing the tag/section index is enabled.',
        true,
      );
    }
    let hits = await provider.search({ tags, text });
    if (regex) {
      const re = regex;
      hits = hits.filter((hit) => {
        re.lastIndex = 0;
        return re.test(hit.text);
      });
    }
    return textResult(formatHits(hits, limit));
  }

  /** Line-by-line regex scan across every Markdown file (the "grep the vault" path). */
  private async regexScan(regex: RegExp, limit: number): Promise<McpToolResult> {
    const files = await this.vault.listMarkdownFiles();
    const lines: string[] = [];
    let scanned = 0;
    for (const path of files.slice(0, SCAN_MAX_FILES)) {
      let content: string;
      try {
        content = (await this.vault.readFile(path)).content;
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
          lines.push(`${path}:${i + 1}: ${fileLines[i].trim().slice(0, 200)}`);
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
    const { content } = await this.vault.readFile(path);
    return textResult(content);
  }

  private async write(args: Record<string, unknown>): Promise<McpToolResult> {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    const content = typeof args['content'] === 'string' ? args['content'] : null;
    const mode = args['mode'] === 'append' ? 'append' : 'overwrite';
    if (path === '' || content === null) {
      return textResult('path and content are required', true);
    }

    let before = '';
    try {
      before = (await this.vault.readFile(path)).content;
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
      const approved = await this.confirmWrite({ path, before, after, mode });
      if (!approved) {
        return textResult('The user declined the write.', true);
      }
    }

    const vaultId = this.vault.resolveVaultId();
    await this.vault.writeFile(path, after, vaultId);
    // The write itself went through the vault manager (own-write ledger),
    // so the watcher suppresses the echo; this announcement keeps the
    // section index current for a follow-up search and nudges the renderer.
    this.onVaultChanged(path, vaultId);
    return textResult(`Wrote ${path} (${after.length} chars, mode: ${mode}).`);
  }
}
