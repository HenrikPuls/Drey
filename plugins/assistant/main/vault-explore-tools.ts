/**
 * The vault explore tools (ADR-0069): the ask's agentic half. When the
 * Vault chip is on the model gets three scope-safe tools beside the
 * injected top-k block — scan the vaults' structure (`vault_overview`),
 * rank sections semantically (`vault_find`), and pull one section's fresh
 * text (`vault_section`). The scope is the chip's resolved target list,
 * resolved in the semantic service — the model can narrow a call to one
 * of the targets, never widen past the chip.
 *
 * Same contract shape as `tasks-tool.ts`/`template-tools.ts` (ADR-0049):
 * specs ride the call's tool set, `run` executes one call, the resolved
 * text is the tool result. Errors come back as text, never as throws.
 */
import type { ToolSpec } from '../../../shared/llm';
import { semanticSnippet, type ActiveVaultScope } from '../shared/semantic.js';
import type {
  SemanticOutlineEntry,
  SemanticSectionText,
} from './semantic/service.js';

/** What one `vault_find` hit shows the model (its ranking evidence). */
interface FindRow {
  vault: string | null;
  vaultId: string;
  path: string;
  heading: string;
  line: number;
  /** Cosine similarity, two decimals. */
  score: number;
  snippet: string;
}

/** The narrow service surface the tools need — the spec suite fakes it. */
export interface ExplorePorts {
  /** The scope's concrete target ids (the read guard). */
  resolveTargets(scope: ActiveVaultScope, vaultIds: readonly string[]): Promise<string[]>;
  searchScoped(
    question: string,
    scope: ActiveVaultScope,
    vaultIds: readonly string[],
    limit?: number,
  ): Promise<
    readonly {
      vaultId: string;
      vault?: string;
      path: string;
      heading: string;
      line: number;
      score: number;
      text: string;
    }[]
  >;
  outline(
    scope: ActiveVaultScope,
    vaultIds: readonly string[],
  ): Promise<readonly SemanticOutlineEntry[]>;
  readSection(
    vaultId: string,
    path: string,
    target?: { heading?: string; line?: number },
  ): Promise<SemanticSectionText | null>;
}

export const VAULT_OVERVIEW_TOOL_NAME = 'vault_overview';
export const VAULT_FIND_TOOL_NAME = 'vault_find';
export const VAULT_SECTION_TOOL_NAME = 'vault_section';

/** Default + cap for one `vault_find` call (matches the SDK search seam). */
export const VAULT_FIND_DEFAULT_LIMIT = 12;
export const VAULT_FIND_MAX_LIMIT = 20;

/** Row caps: one tool result never carries a whole vault dump. */
const OVERVIEW_MAX_ENTRIES = 150;
const SECTION_TEXT_MAX_CHARS = 2400;

const COMMON_SCOPE_LINE =
  'Only these vaults are in scope; narrower calls may name one of the listed vaultIds.';

export const VAULT_OVERVIEW_SPEC: ToolSpec = {
  name: VAULT_OVERVIEW_TOOL_NAME,
  description:
    'List the structure of the vaults this question searches: one JSON object per file — ' +
    'vault, vaultId, path, and the file’s section headings. Use it FIRST to get an overview ' +
    'and find candidate files, then vault_find for similarity ranking and vault_section to ' +
    `read the sections you need. ${COMMON_SCOPE_LINE}`,
  parameters: {
    type: 'object',
    properties: {
      vaultId: {
        type: 'string',
        description: 'Restrict the listing to one in-scope vault id. Default: all in scope.',
      },
    },
  },
};

export const VAULT_FIND_SPEC: ToolSpec = {
  name: VAULT_FIND_TOOL_NAME,
  description:
    'Search over the scoped vaults: rank note sections by relevance to a query. ' +
    'One JSON object per hit — vault, vaultId, path, heading, line, score (0..1), snippet. ' +
    'Use it when the overview is too large or you need the BEST matches for a topic, then ' +
    `vault_section to read a hit in full. ${COMMON_SCOPE_LINE}`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for, as a short phrase or sentence (any language).',
      },
      limit: {
        type: 'number',
        description: `Max hits, 1..${VAULT_FIND_MAX_LIMIT}. Default ${VAULT_FIND_DEFAULT_LIMIT}.`,
      },
      vaultId: {
        type: 'string',
        description: 'Restrict the search to one in-scope vault id. Default: all in scope.',
      },
    },
    required: ['query'],
  },
};

export const VAULT_SECTION_SPEC: ToolSpec = {
  name: VAULT_SECTION_TOOL_NAME,
  description:
    'Read one note section in full, fresh from the vault. Pass the path (and vaultId when ' +
    'several vaults are in scope) plus either the section’s heading or its 1-based line ' +
    'from vault_overview/vault_find; with neither, the file’s first section comes back. ' +
    `${COMMON_SCOPE_LINE}`,
  parameters: {
    type: 'object',
    properties: {
      vaultId: {
        type: 'string',
        description: 'The vault id the path belongs to. Required when several vaults are in scope.',
      },
      path: {
        type: 'string',
        description: 'Vault-relative path of the note.',
      },
      heading: {
        type: 'string',
        description: 'The section’s heading (case-insensitive, first match).',
      },
      line: {
        type: 'number',
        description: 'The section’s 1-based start line (from a vault_find hit).',
      },
    },
    required: ['path'],
  },
};

export interface VaultExploreTools {
  specs: readonly ToolSpec[];
  names: ReadonlySet<string>;
  run(name: string, argsJson: string): Promise<string>;
}

/**
 * Builds the tool set for ONE ask turn: the chip's scope rides the
 * closure, so the model cannot redirect a call to another vault. Target
 * ids resolve once at creation — an ask is short-lived; a vault removed
 * mid-ask fails the read with a clear text instead of silently reading.
 */
export function createVaultExploreTools(
  ports: ExplorePorts,
  scope: ActiveVaultScope,
  vaultIds: readonly string[],
): VaultExploreTools {
  const specs = [VAULT_OVERVIEW_SPEC, VAULT_FIND_SPEC, VAULT_SECTION_SPEC];
  const targets: Promise<string[]> = ports.resolveTargets(scope, vaultIds);

  /**
   * The call's target terms. Without a `vaultId` argument the chip's scope
   * passes through; with one, a `custom` selection of exactly that id —
   * `resolveTargetVaultIds` ignores the id list for `vault`/`all`, so the
   * narrowing must switch to the selection-based scope.
   */
  const callScope = (
    vaultId: string | undefined,
  ): { scope: ActiveVaultScope; vaultIds: readonly string[] } =>
    vaultId !== undefined
      ? { scope: 'custom' as const, vaultIds: [vaultId] }
      : { scope, vaultIds };

  const runOverview = async (argsJson: string): Promise<string> => {
    const { vaultId } = parseArgs(argsJson);
    if (vaultId !== undefined) {
      const allowed = await targets;
      if (!allowed.includes(vaultId)) {
        return `Refused: vault "${vaultId}" is out of scope for this ask.`;
      }
    }
    const target = callScope(vaultId);
    const entries = await ports.outline(target.scope, target.vaultIds);
    if (entries.length === 0) {
      return 'No files found — the scoped vaults have no Markdown notes (or the vault no longer exists).';
    }
    return jsonLines(entries, OVERVIEW_MAX_ENTRIES, 'files');
  };

  const runFind = async (argsJson: string): Promise<string> => {
    const { query, limit, vaultId } = parseArgs(argsJson);
    if (query === undefined || query.trim() === '') {
      return 'Refused: vault_find needs a non-empty "query".';
    }
    if (vaultId !== undefined) {
      const allowed = await targets;
      if (!allowed.includes(vaultId)) {
        return `Refused: vault "${vaultId}" is out of scope for this ask.`;
      }
    }
    const capped = clampLimit(limit);
    const target = callScope(vaultId);
    const hits = await ports.searchScoped(query.trim(), target.scope, target.vaultIds, capped);
    if (hits.length === 0) {
      return 'No similar sections found.';
    }
    const rows: FindRow[] = hits.map((hit) => ({
      vault: hit.vault ?? null,
      vaultId: hit.vaultId,
      path: hit.path,
      heading: hit.heading,
      line: hit.line,
      score: Math.round(hit.score * 100) / 100,
      snippet: semanticSnippet(hit.text),
    }));
    return jsonLines(rows, rows.length, 'hits');
  };

  const runSection = async (argsJson: string): Promise<string> => {
    const { vaultId, path, heading, line } = parseArgs(argsJson);
    if (path === undefined || path.trim() === '') {
      return 'Refused: vault_section needs a "path".';
    }
    const allowed = await targets;
    if (allowed.length === 0) {
      return 'Refused: no in-scope vault for this ask.';
    }
    const targetVault = vaultId !== undefined ? vaultId : allowed.length === 1 ? allowed[0] : undefined;
    if (targetVault === undefined) {
      return `Refused: "vaultId" is required — several vaults are in scope (${allowed.join(', ')}).`;
    }
    if (!allowed.includes(targetVault)) {
      return `Refused: vault "${targetVault}" is out of scope for this ask.`;
    }
    const section = await ports.readSection(targetVault, path.trim(), {
      ...(heading !== undefined ? { heading } : {}),
      ...(line !== undefined ? { line } : {}),
    });
    if (section === null) {
      return `No such section: ${path}${heading !== undefined ? ` — ${heading}` : ''}.`;
    }
    const text =
      section.text.length > SECTION_TEXT_MAX_CHARS
        ? `${section.text.slice(0, SECTION_TEXT_MAX_CHARS)}\n[…section truncated…]`
        : section.text;
    return [
      JSON.stringify({
        vaultId: section.vaultId,
        path: section.path,
        heading: section.heading,
        line: section.line,
      }),
      text,
    ].join('\n');
  };

  const runners = new Map<string, (argsJson: string) => Promise<string>>([
    [VAULT_OVERVIEW_TOOL_NAME, runOverview],
    [VAULT_FIND_TOOL_NAME, runFind],
    [VAULT_SECTION_TOOL_NAME, runSection],
  ]);

  return {
    specs,
    names: new Set(runners.keys()),
    run: (name, argsJson) =>
      (runners.get(name) ?? (async () => `Unknown tool: ${name}`))(argsJson),
  };
}

/** One tool call's parsed arguments; anything malformed stays absent. */
interface ExploreArgs {
  vaultId?: string;
  query?: string;
  path?: string;
  heading?: string;
  line?: number;
  limit?: number;
}

function parseArgs(argsJson: string): ExploreArgs {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const out: ExploreArgs = {};
    for (const key of ['vaultId', 'query', 'path', 'heading'] as const) {
      const value = record[key];
      if (typeof value === 'string') {
        out[key] = value;
      }
    }
    const line = record['line'];
    const limit = record['limit'];
    if (typeof line === 'number' && Number.isFinite(line)) {
      out['line'] = Math.round(line);
    }
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      out['limit'] = limit;
    }
    return out;
  } catch {
    return {};
  }
}

function clampLimit(limit: number | undefined): number {
  const num = typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : VAULT_FIND_DEFAULT_LIMIT;
  return Math.min(VAULT_FIND_MAX_LIMIT, Math.max(1, num));
}

/** One JSON object per line, hard-capped, with a truncation marker line. */
function jsonLines(rows: readonly unknown[], cap: number, noun: string): string {
  const shown = rows.slice(0, cap);
  const lines = shown.map((row) => JSON.stringify(row));
  if (rows.length > shown.length) {
    lines.push(`{"truncated": ${rows.length - shown.length}, "note": "more ${noun} exist — narrow the call"}`);
  }
  return lines.join('\n');
}
