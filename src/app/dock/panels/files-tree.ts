import { VaultFileEntry, VaultStatus } from '../../../../shared/ipc-api';
import { docKey } from '../../services/editor.service';

/**
 * The Files panel's tree as plain data: which rows are visible, how they
 * are keyed, what a selection range covers and where a drop may land. No
 * Angular, no DOM, no IPC -- `FilesTreeState` holds the signals over it and
 * `FilesPanel` renders it.
 */

/** One row in the flat, keyboard-walkable model: a vault header or a file entry. */
export type VisibleNode =
  | { kind: 'vault'; vault: VaultStatus }
  | { kind: 'entry'; vaultId: string; entry: VaultFileEntry; depth: number };

/** A tree entry together with the vault it lives in. */
export interface TreeTarget {
  vaultId: string;
  entry: VaultFileEntry;
}

/** The modifier keys that turn a click or an arrow key into a selection change. */
export interface SelectionModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
}

/** The identity string a visible row is keyed by. */
export function keyOf(node: VisibleNode): string {
  return node.kind === 'vault' ? node.vault.id : docKey(node.vaultId, node.entry.relativePath);
}

/** The vault-relative folder of a path; '' for an entry in the vault root. */
export function parentDir(relativePath: string): string {
  const i = relativePath.lastIndexOf('/');
  return i === -1 ? '' : relativePath.slice(0, i);
}

/**
 * All vault sections flattened to the rows that are actually visible (a
 * collapsed vault hides its whole tree; an unexpanded folder drops its
 * children), in display order -- the model the arrow keys step through.
 */
export function flattenVisible(
  vaults: readonly VaultStatus[],
  trees: Readonly<Record<string, readonly VaultFileEntry[]>>,
  collapsedVaults: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  for (const vault of vaults) {
    out.push({ kind: 'vault', vault });
    if (collapsedVaults.has(vault.id)) {
      continue;
    }
    const walk = (entries: readonly VaultFileEntry[], depth: number): void => {
      for (const entry of entries) {
        out.push({ kind: 'entry', vaultId: vault.id, entry, depth });
        if (
          entry.type === 'directory' &&
          entry.children?.length &&
          expanded.has(docKey(vault.id, entry.relativePath))
        ) {
          walk(entry.children, depth + 1);
        }
      }
    };
    walk(trees[vault.id] ?? [], 0);
  }
  return out;
}

/** The composite key of every folder in every tree. */
export function directoryKeys(
  trees: Readonly<Record<string, readonly VaultFileEntry[]>>,
): Set<string> {
  const keys = new Set<string>();
  for (const [vaultId, tree] of Object.entries(trees)) {
    const walk = (entries: readonly VaultFileEntry[]): void => {
      for (const entry of entries) {
        if (entry.type === 'directory') {
          keys.add(docKey(vaultId, entry.relativePath));
          if (entry.children?.length) {
            walk(entry.children);
          }
        }
      }
    };
    walk(tree);
  }
  return keys;
}

/** True when no folder of any tree is still collapsed (also for trees without folders). */
export function everyFolderExpanded(
  trees: Readonly<Record<string, readonly VaultFileEntry[]>>,
  expanded: ReadonlySet<string>,
): boolean {
  for (const key of directoryKeys(trees)) {
    if (!expanded.has(key)) {
      return false;
    }
  }
  return true;
}

/** The keys of `dir` and every folder above it, outermost first; none for the vault root. */
export function ancestorKeys(vaultId: string | null, dir: string): string[] {
  if (!dir) {
    return [];
  }
  const parts = dir.split('/');
  return parts.map((_part, i) => docKey(vaultId, parts.slice(0, i + 1).join('/')));
}

/** The keys from `from` to `to`, both included, over the visible rows. */
export function rangeOver(nodes: readonly VisibleNode[], from: string, to: string): ReadonlySet<string> {
  const i = nodes.findIndex((n) => keyOf(n) === from);
  const j = nodes.findIndex((n) => keyOf(n) === to);
  if (i < 0 || j < 0) {
    return new Set([to]);
  }
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return new Set(nodes.slice(lo, hi + 1).map((n) => keyOf(n)));
}

/**
 * The absolute OS path of a tree row: the vault root joined with the
 * vault-relative path (contract: forward slashes) in the root's separator
 * style. Without a root (the vault vanished from the registry) it degrades
 * to the relative path.
 */
export function absolutePath(root: string | undefined, relativePath: string): string {
  if (!root) {
    return relativePath;
  }
  const trimmed = root.endsWith('\\') || root.endsWith('/') ? root.slice(0, -1) : root;
  if (root.includes('\\')) {
    return `${trimmed}\\${relativePath.replace(/\//g, '\\')}`;
  }
  return `${trimmed}/${relativePath}`;
}

/** Where a drop on `entry` lands: a folder takes the entry in, a file's row means its parent folder. */
export function destinationDir(entry: VaultFileEntry): string {
  return entry.type === 'directory' ? entry.relativePath : parentDir(entry.relativePath);
}

/**
 * False for a no-op (same folder, same vault) and for a folder dropped
 * into itself / its own subtree (same vault only -- a cross-vault drop
 * can never nest inside itself). A drop ON a vault header row targets
 * that vault's root and is answered by `canDropOnVault`.
 */
export function canDropOnEntry(dragged: TreeTarget | null, vaultId: string, entry: VaultFileEntry): boolean {
  if (!dragged) {
    return false;
  }
  if (dragged.vaultId === vaultId) {
    const dest = destinationDir(entry);
    if (dest === parentDir(dragged.entry.relativePath)) {
      return false;
    }
    return dest !== dragged.entry.relativePath && !dest.startsWith(`${dragged.entry.relativePath}/`);
  }
  return true; // cross-vault moves are always valid (copy + delete in main)
}

/** Whether a drop on the vault header row (that vault's root) is valid. */
export function canDropOnVault(dragged: TreeTarget | null, vault: VaultStatus): boolean {
  if (!dragged || !vault.exists) {
    return false;
  }
  if (dragged.vaultId === vault.id) {
    // Moving to the vault's own root: a no-op only when already there.
    return parentDir(dragged.entry.relativePath) !== '';
  }
  return true; // a cross-vault move to another vault's root
}

/** A typed file or folder name that is no single path segment. */
export function isInvalidEntryName(name: string): boolean {
  return name.includes('/') || name.includes('\\') || name === '.' || name === '..';
}
