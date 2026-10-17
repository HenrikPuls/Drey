/**
 * Collapsed-column state for the board (T-0005): which phase ids are
 * folded down to their narrow vertical strip. Pure view state — it
 * never enters the tickets repo (ADR-0076 keeps the repo free of
 * board state); it persists in localStorage like the dock layout
 * ('drey.dock') and the tasks panel prefs ('drey.tasks'), keyed
 * 'drey.tickets'.
 *
 * The storage is a structural interface so the spec runs on an
 * in-memory stub (the plugin spec project has no DOM by policy);
 * the board wires the real `window.localStorage`.
 */
const STORAGE_KEY = 'drey.tickets';

interface CollapsedState {
  collapsed: string[];
}

/** What the store needs from localStorage — nothing more. */
export interface ColumnCollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ColumnCollapseStore {
  isCollapsed(phaseId: string): boolean;
  setCollapsed(phaseId: string, collapsed: boolean): void;
  /** Drops ids the board no longer lists (a renamed phase). Returns
   *  whether something went — the caller may re-render then. */
  prune(knownPhaseIds: readonly string[]): boolean;
}

export function createColumnCollapseStore(storage: ColumnCollapseStorage): ColumnCollapseStore {
  let ids = readCollapsed(storage);

  const persist = (): void => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ collapsed: [...ids] } satisfies CollapsedState));
    } catch {
      // Storage disabled / quota: a non-persisted session is fine.
    }
  };

  return {
    isCollapsed: (phaseId) => ids.has(phaseId),
    setCollapsed(phaseId, collapsed) {
      const before = ids.has(phaseId);
      if (collapsed) {
        ids.add(phaseId);
      } else {
        ids.delete(phaseId);
      }
      if (ids.has(phaseId) !== before) {
        persist();
      }
    },
    prune(knownPhaseIds) {
      const known = new Set(knownPhaseIds);
      let changed = false;
      for (const id of ids) {
        if (!known.has(id)) {
          ids.delete(id);
          changed = true;
        }
      }
      if (changed) {
        persist();
      }
      return changed;
    },
  };
}

function readCollapsed(storage: ColumnCollapseStorage): Set<string> {
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as Partial<CollapsedState>;
    return new Set(
      Array.isArray(raw.collapsed)
        ? raw.collapsed.filter((id): id is string => typeof id === 'string' && id !== '')
        : [],
    );
  } catch {
    return new Set();
  }
}
