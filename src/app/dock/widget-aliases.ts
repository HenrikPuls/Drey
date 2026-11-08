import type { DockState } from './dock.service';

/** Earlier widget id -> the id that replaced it (SDK 1.54, `PluginWidgetContrib.aliases`). */
export type WidgetAliasTable = ReadonlyMap<string, string>;

type Stored = Partial<DockState>;

const SIDES = ['left', 'right', 'bottom'] as const;

/**
 * Renames the legacy widget ids in a stored layout blob to the panel that
 * replaced them: the panel takes the place of the first alias in the dock
 * list, a second alias is dropped; it is open when any of its aliases was,
 * folded when any was, and takes the first stored size. Pure and idempotent;
 * a blob that names no alias is returned as it is.
 */
export function migrateWidgetAliases(saved: Stored, aliases: WidgetAliasTable): Stored {
  if (aliases.size === 0) {
    return saved;
  }
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const renamed = (id: string): string => aliases.get(id) ?? id;
  const touches = SIDES.some((side) => names(saved.dock?.[side]).some((id) => aliases.has(id)));
  const keys = [saved.flexes, saved.open, saved.collapsed].some(
    (map) => map !== undefined && map !== null && Object.keys(map).some((id) => aliases.has(id)),
  );
  if (!touches && !keys) {
    return saved;
  }

  const dock = Object.fromEntries(
    SIDES.map((side) => {
      const seen = new Set<string>();
      const list: string[] = [];
      for (const id of names(saved.dock?.[side])) {
        const next = renamed(id);
        if (!seen.has(next)) {
          seen.add(next);
          list.push(next);
        }
      }
      return [side, list];
    }),
  ) as unknown as DockState['dock'];
  // A panel named in two docks keeps the first dock's place.
  const placed = new Set<string>();
  for (const side of SIDES) {
    dock[side] = dock[side].filter((id) => {
      if (placed.has(id)) {
        return false;
      }
      placed.add(id);
      return true;
    });
  }

  const fold = <T>(
    map: Record<string, T> | undefined,
    merge: (current: T | undefined, incoming: T) => T,
  ): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [id, value] of Object.entries(map ?? {})) {
      const next = renamed(id);
      out[next] = next === id || out[next] === undefined ? value : merge(out[next], value);
    }
    return out;
  };
  // A canonical id's own entry wins its size; the open state is an OR.
  const flexes = fold<number>(saved.flexes as Record<string, number> | undefined, (current) => current as number);
  const open = fold<boolean>(saved.open as Record<string, boolean> | undefined, (a, b) => a === true || b);
  const collapsed = fold<boolean>(
    saved.collapsed as Record<string, boolean> | undefined,
    (a, b) => a === true || b,
  );
  return { ...saved, dock, flexes, open, collapsed } as Stored;
}
