/**
 * The vault's scan rules (T-0044, ADR-0080): which root-level names are
 * reserved for machine state and therefore invisible to the vault's
 * surfaces — the file tree, the markdown index and the opt-in watcher.
 *
 * `_`-prefixed folders at the **vault root only** are reserved (the
 * fleet's worktrees base `_worktrees/` lives there; the board and the
 * md index skip it so agent writes never cause refresh storms). Under
 * `tickets/` nothing changes: `tickets/_meta` stays indexed and
 * watched. Dot entries stay invisible everywhere, as before.
 */

/**
 * Whether a vault-ROOT folder name is reserved machine state: the
 * `_`-prefix convention (ADR-0080). Root depth only — `tickets/_meta`
 * is not affected (it is not at the root).
 */
export function isReservedRootName(name: string): boolean {
  return name.startsWith('_');
}

/** Any path segment starting with a dot — the pre-T-0044 ignore rule. */
function hasDotSegment(p: string): boolean {
  return /(^|[\\/])\./.test(p);
}

/** The same drive-letter/case/slash form on both sides of the compare. */
function comparable(p: string, foldCase: boolean): string {
  const resolved = p.replaceAll('\\', '/');
  return foldCase ? resolved.toLowerCase() : resolved;
}

/**
 * The watcher's ignore filter (chokidar `ignored`): dot entries
 * anywhere, plus reserved root folders and everything under them. The
 * root prefix is matched case-insensitively on win32 and tolerates both
 * slash directions; paths outside the vault root are not ours to judge.
 */
export function vaultScanIgnore(root: string): (p: string) => boolean {
  const fold = process.platform === 'win32';
  const rootKey = comparable(root, fold);
  return (p: string): boolean => {
    if (hasDotSegment(p)) {
      return true;
    }
    const key = comparable(p, fold);
    if (key !== rootKey && !key.startsWith(`${rootKey}/`)) {
      return false; // outside the vault
    }
    const rel = key === rootKey ? '' : key.slice(rootKey.length + 1);
    const [first] = rel.split('/');
    return first !== undefined && isReservedRootName(first);
  };
}
