/**
 * The filesystem explore ports (ADR-0069 later change): the vault explore
 * tools' engine when semantic retrieval is disabled. The tools stay
 * attached to a chip-scoped ask and degrade instead of vanishing — the
 * alternative was a scoped ask with NO in-scope lookup at all, steering
 * the model straight into the base tools' active-vault default (the
 * "docs vault selected, answers from the active vault" trap).
 *
 * `vault_overview` reads each scoped vault's Markdown files fresh and
 * lifts their headings with the shared splitter; `vault_section` picks
 * the requested section with the same shared locator the semantic service
 * uses; `vault_find` ranks sections by plain token overlap with the query
 * — no embeddings, same result shape. `chats/` stays excluded, mirroring
 * `isSemanticIndexPath`.
 */
import {
  DEFAULT_SEMANTIC_SEARCH_LIMIT,
  MAX_SEMANTIC_SEARCH_LIMIT,
  isSemanticIndexPath,
  locateSemanticSection,
  resolveTargetVaultIds,
  semanticSectionsFor,
  type ActiveVaultScope,
  type SemanticSection,
} from '../shared/semantic.js';
import type { SemanticOutlineEntry, SemanticSectionText } from './semantic/service.js';
import type { ExplorePorts } from './vault-explore-tools.js';

/** Files read per vault and call — one tool call never scans a whole huge vault. */
export const SCAN_FILE_CAP = 200;

/** The service's narrow shape; the ports' host, so the spec suite can fake it. */
export interface VaultScanDeps {
  listVaults(): Promise<readonly { id: string; name: string; active: boolean }[]>;
  listMarkdownFiles(vaultId: string): Promise<readonly string[]>;
  readVaultText(vaultId: string, path: string): Promise<string | null>;
}

/** One in-scope file's fresh scan: path plus its split sections. */
interface ScannedFile {
  path: string;
  sections: readonly SemanticSection[];
}

/** One ranked `vault_find` hit — the semantic port's hit shape, text-mode scores. */
interface ScanHit {
  vaultId: string;
  vault?: string;
  path: string;
  heading: string;
  line: number;
  score: number;
  text: string;
}

export function createVaultScanPorts(deps: VaultScanDeps): ExplorePorts {
  const resolveTargets = async (
    scope: ActiveVaultScope,
    vaultIds: readonly string[],
  ): Promise<string[]> => {
    const vaults = await deps.listVaults();
    return resolveTargetVaultIds(vaults, scope, vaultIds);
  };

  const inScopeFiles = async (vaultId: string): Promise<readonly ScannedFile[]> => {
    const files = (await deps.listMarkdownFiles(vaultId))
      .filter((file) => isSemanticIndexPath(file))
      .slice(0, SCAN_FILE_CAP);
    const out: ScannedFile[] = [];
    for (const filePath of files) {
      const content = await deps.readVaultText(vaultId, filePath);
      out.push({
        path: filePath,
        sections: content === null ? [] : semanticSectionsFor(filePath, content),
      });
    }
    return out;
  };

  const outline = async (
    scope: ActiveVaultScope,
    vaultIds: readonly string[],
  ): Promise<readonly SemanticOutlineEntry[]> => {
    const vaults = await deps.listVaults();
    const targetIds = resolveTargetVaultIds(vaults, scope, vaultIds);
    const names = new Map(vaults.map((vault) => [vault.id, vault.name]));
    const out: SemanticOutlineEntry[] = [];
    for (const vaultId of targetIds) {
      const vaultName = names.get(vaultId);
      const cite = vaultName !== undefined ? { vault: vaultName } : {};
      for (const file of await inScopeFiles(vaultId)) {
        out.push({
          vaultId,
          ...cite,
          path: file.path,
          headings: file.sections.map((section) => section.heading),
        });
      }
    }
    return out;
  };

  const readSection = async (
    vaultId: string,
    filePath: string,
    target: { heading?: string; line?: number } = {},
  ): Promise<SemanticSectionText | null> => {
    const content = await deps.readVaultText(vaultId, filePath);
    if (content === null) {
      return null;
    }
    const section = locateSemanticSection(semanticSectionsFor(filePath, content), target);
    if (section === null) {
      return null;
    }
    return {
      vaultId,
      path: filePath,
      heading: section.heading,
      line: section.line,
      text: section.text,
    };
  };

  const searchScoped = async (
    question: string,
    scope: ActiveVaultScope,
    vaultIds: readonly string[],
    limit?: number,
  ): Promise<readonly ScanHit[]> => {
    const tokens = queryTokens(question);
    if (tokens.length === 0) {
      return [];
    }
    const maxHits = clampInt(limit, 1, MAX_SEMANTIC_SEARCH_LIMIT, DEFAULT_SEMANTIC_SEARCH_LIMIT);
    const vaults = await deps.listVaults();
    const targetIds = resolveTargetVaultIds(vaults, scope, vaultIds);
    const names = new Map(vaults.map((vault) => [vault.id, vault.name]));
    const scored: ScanHit[] = [];
    for (const vaultId of targetIds) {
      const vaultName = names.get(vaultId);
      for (const file of await inScopeFiles(vaultId)) {
        for (const section of file.sections) {
          const score = tokenScore(tokens, section);
          if (score <= 0) {
            continue;
          }
          scored.push({
            vaultId,
            ...(vaultName !== undefined ? { vault: vaultName } : {}),
            path: file.path,
            heading: section.heading,
            line: section.line,
            score,
            text: section.text,
          });
        }
      }
    }
    scored.sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line,
    );
    return scored.slice(0, maxHits);
  };

  return { resolveTargets, searchScoped, outline, readSection };
}

/**
 * The text-mode ranking's terms: lowercased words of 3+ characters,
 * deduplicated. Shorter fragments (of, der, #tags' stubs) carry no
 * topical signal worth ranking on.
 */
function queryTokens(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/)
    .filter((word) => word.length >= 3);
  return [...new Set(words)];
}

/** Coverage 0..1: the fraction of query tokens present in heading or body. */
function tokenScore(tokens: readonly string[], section: SemanticSection): number {
  const haystack = `${section.heading}\n${section.text}`.toLowerCase();
  let present = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      present += 1;
    }
  }
  return present / tokens.length;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, num));
}
