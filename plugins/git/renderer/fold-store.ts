/**
 * Which groups of the Source control panel are folded, per repository and
 * per viewer (board 9d: every group head folds). Kept in the renderer's
 * storage like the Work panel's `GroupFoldStore`, so a status refresh, a
 * repaint or a restart leaves a fold where the owner put it. History
 * starts folded; the others start open.
 */
export type FoldGroup = 'conflicts' | 'staged' | 'changes' | 'history';

export interface FoldStore {
  isOpen(repo: string, group: FoldGroup): boolean;
  setOpen(repo: string, group: FoldGroup, open: boolean): void;
}

const FOLD_KEY = 'drey.git.folds';

/** The group's state when nothing was saved for it. */
function openByDefault(group: FoldGroup): boolean {
  return group !== 'history';
}

export function createFoldStore(storage: Storage | null): FoldStore {
  const read = (): Record<string, Partial<Record<FoldGroup, boolean>>> => {
    try {
      const raw = storage?.getItem(FOLD_KEY) ?? null;
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, Partial<Record<FoldGroup, boolean>>>)
        : {};
    } catch {
      return {};
    }
  };
  let saved = read();
  return {
    isOpen: (repo, group) => {
      const value = saved[repo]?.[group];
      return typeof value === 'boolean' ? value : openByDefault(group);
    },
    setOpen: (repo, group, open) => {
      saved = { ...saved, [repo]: { ...saved[repo], [group]: open } };
      try {
        storage?.setItem(FOLD_KEY, JSON.stringify(saved));
      } catch {
        // A blocked storage keeps the fold for this session only.
      }
    },
  };
}
