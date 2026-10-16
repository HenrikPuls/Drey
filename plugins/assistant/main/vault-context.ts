/**
 * The Vault chip's context lookup (ADR-0072): the words of the question
 * are searched in the section index another plugin registered (the tags
 * plugin, through the SDK's section-search seam), the hits are ranked
 * (`shared/vault-context.ts`) and the best ones ride the question. The
 * index lives in memory and is kept fresh by its owner, so a lookup reads
 * no file and builds nothing.
 */
import type { SectionSearchProvider } from '../../../shared/plugin-api';
import {
  VAULT_CONTEXT_TOP_K,
  isVaultContextPath,
  queryTerms,
  rankLexical,
  resolveTargetVaultIds,
  type ActiveVaultScope,
  type LexicalHit,
  type RetrievalOutcome,
  type TermHits,
} from '../shared/vault-context.js';

/** The lookup's view of the host; narrow so the spec can fake it. */
export interface VaultContextDeps {
  listVaults(): Promise<readonly { id: string; name: string; active: boolean }[]>;
  /** The registered section index, or `null` when no plugin provides one. */
  sectionSearch(): Pick<SectionSearchProvider, 'search'> | null;
}

/**
 * The sections for one ask turn. No provider returns `unavailable`
 * (nothing was searched — the caller can say so); a custom selection
 * whose ids no longer resolve returns `noTargets` (no silent fallback to
 * the active vault); a failing search throws, the caller catches and
 * degrades to no context.
 */
export async function retrieveVaultContext(
  deps: VaultContextDeps,
  question: string,
  scope: ActiveVaultScope,
  vaultIds: readonly string[] = [],
): Promise<RetrievalOutcome> {
  const provider = deps.sectionSearch();
  if (provider === null) {
    return { hits: [], unavailable: true };
  }
  const vaults = await deps.listVaults();
  const targetIds = resolveTargetVaultIds(vaults, scope, vaultIds);
  if (targetIds.length === 0) {
    return scope === 'custom' ? { hits: [], noTargets: true } : { hits: [] };
  }
  const perTerm: TermHits[] = [];
  for (const term of queryTerms(question)) {
    const hits: LexicalHit[] = [];
    for (const vaultId of targetIds) {
      const found = await provider.search({ tags: [], text: term }, { kind: 'vault', vaultId });
      for (const hit of found) {
        // A heading without a body gives the model nothing to read.
        if (!isVaultContextPath(hit.path) || hit.text.trim() === '') {
          continue;
        }
        hits.push({
          vaultId,
          path: hit.path,
          heading: hit.heading !== '' ? hit.heading : baseName(hit.path),
          line: hit.line,
          text: hit.text,
        });
      }
    }
    perTerm.push({ term, hits });
  }
  const names = new Map(vaults.map((vault) => [vault.id, vault.name]));
  return {
    hits: rankLexical(perTerm, VAULT_CONTEXT_TOP_K).map((hit) => ({
      ...hit,
      vault: names.get(hit.vaultId),
    })),
  };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
