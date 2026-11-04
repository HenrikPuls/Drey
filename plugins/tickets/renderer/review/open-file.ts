/**
 * "Open in editor" for a file of the ticket's branch (E13-7): the branch
 * lives in a git worktree, which is only a vault file when the owner has
 * registered that folder (or a folder above it) as a vault. Pure
 * resolution -- the view does the opening and the fallback.
 */

export interface VaultRoot {
  readonly id: string;
  readonly path: string;
}

const normal = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * The vault and vault-relative path of `<worktree>/<file>`; null when no
 * registered vault contains it. The longest root wins (nested vaults).
 * Paths compare case-insensitively on Windows drive paths.
 */
export function vaultFileOf(
  vaults: readonly VaultRoot[],
  worktreePath: string,
  file: string,
): { vaultId: string; path: string } | null {
  if (worktreePath === '' || file === '') {
    return null;
  }
  const absolute = `${normal(worktreePath)}/${file.replace(/^\/+/, '')}`;
  const folded = /^[a-z]:\//i.test(absolute);
  const key = (value: string): string => (folded ? value.toLowerCase() : value);
  let best: { vaultId: string; root: string } | null = null;
  for (const vault of vaults) {
    const root = normal(vault.path);
    if (root === '' || !key(absolute).startsWith(`${key(root)}/`)) {
      continue;
    }
    if (best === null || root.length > best.root.length) {
      best = { vaultId: vault.id, root };
    }
  }
  return best === null ? null : { vaultId: best.vaultId, path: absolute.slice(best.root.length + 1) };
}
