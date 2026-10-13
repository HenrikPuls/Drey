/**
 * Which vaults and which paths a tool call may touch (ADR-0071). The
 * scope is enforced here, where the tool runs — what the model was told
 * about it in the prompt is only a courtesy.
 */
import { isChatNotePath, isDraftPath } from '../../../shared/structural-folders';
import type { ToolVault, VaultCallOptions } from './types';

export interface ScopedVault {
  id: string;
  name: string;
}

/** The vaults of one call, resolved from its `vault` argument. */
export interface ResolvedVaults {
  vaults: ScopedVault[];
  /** Whether results name their vault: only when more than one is in play. */
  labelled: boolean;
}

export class ToolScope {
  /** The registered vaults this call may touch, in registry order. */
  readonly inScope: readonly ScopedVault[];
  private readonly activeId: string | null;

  constructor(
    vault: ToolVault,
    private readonly options: VaultCallOptions,
  ) {
    const registered = vault.listVaults().filter((entry) => entry.exists);
    const allowed = options.scope;
    this.inScope = registered
      .filter((entry) => allowed === undefined || allowed.includes(entry.id))
      .map((entry) => ({ id: entry.id, name: entry.name }));
    this.activeId = vault.getActiveVaultId();
  }

  private listing(): string {
    return this.inScope.map((vault) => `"${vault.id}" (${vault.name})`).join(', ');
  }

  private notInScope(raw: string): string {
    return this.inScope.length === 0
      ? `Error: no vault is available to this call.`
      : `Error: vault "${raw}" is not available to this call. Pass one of: ${this.listing()}.`;
  }

  /**
   * The one vault a single-file tool works in: the `vault` argument, or —
   * without it — the only vault in scope, or the active one when it is
   * in scope. Anything else is a refusal that lists the choices.
   */
  one(raw: unknown): ScopedVault | { error: string } {
    if (typeof raw === 'string' && raw !== '') {
      const named = this.inScope.find((vault) => vault.id === raw);
      return named ?? { error: this.notInScope(raw) };
    }
    if (this.inScope.length === 1) {
      return this.inScope[0];
    }
    const active = this.inScope.find((vault) => vault.id === this.activeId);
    if (active !== undefined) {
      return active;
    }
    return {
      error:
        this.inScope.length === 0
          ? 'Error: no vault is available to this call.'
          : `Error: pass the "vault" argument — one of: ${this.listing()}.`,
    };
  }

  /** The vaults a listing or search covers: the named one, or all in scope. */
  many(raw: unknown): ResolvedVaults | { error: string } {
    if (this.inScope.length === 0) {
      return { error: 'Error: no vault is available to this call.' };
    }
    const labelled = this.inScope.length > 1;
    if (typeof raw === 'string' && raw !== '' && raw !== 'all') {
      const named = this.inScope.find((vault) => vault.id === raw);
      return named !== undefined ? { vaults: [named], labelled } : { error: this.notInScope(raw) };
    }
    return { vaults: [...this.inScope], labelled };
  }

  /**
   * The vault and path of a single-file call. Results print a file as
   * `vaultId:path` when several vaults are in play, and a model copies
   * that into `path` — so such a label is taken apart here instead of
   * being looked up as a file name.
   */
  locate(rawPath: unknown, rawVault: unknown): { vault: ScopedVault; path: string } | { error: string } {
    let path = cleanPath(rawPath);
    let vaultArg = rawVault;
    const colon = path.indexOf(':');
    if (colon > 0) {
      const prefix = path.slice(0, colon);
      if (this.inScope.some((vault) => vault.id === prefix)) {
        if (typeof rawVault !== 'string' || rawVault === '') {
          vaultArg = prefix;
        }
        path = cleanPath(path.slice(colon + 1));
      }
    }
    if (path === '') {
      return { error: 'Error: "path" is empty — pass a vault-relative path such as notes/topic.md.' };
    }
    const vault = this.one(vaultArg);
    return 'error' in vault ? vault : { vault, path };
  }

  /** `vaultId:path` where several vaults are in play, the bare path otherwise. */
  label(vault: ScopedVault, path: string, labelled: boolean): string {
    return labelled ? `${vault.id}:${path}` : path;
  }

  /** Whether `path` is one of the app's own folders this call must leave alone. */
  isProtected(path: string): boolean {
    return this.options.protectAppFolders === true && (isChatNotePath(path) || isDraftPath(path));
  }
}

/**
 * A path argument in the form the vault uses: forward slashes, no
 * leading `./` or `/`, no trailing slash.
 */
export function cleanPath(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** True when `path` is `folder` or lies inside it; an empty folder matches everything. */
export function isUnder(path: string, folder: string): boolean {
  return folder === '' || path === folder || path.startsWith(`${folder}/`);
}
