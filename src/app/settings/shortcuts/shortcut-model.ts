import type { KeybindingsConfig } from '../../../../shared/app-config';
import {
  canonicalChord,
  DEFAULT_CAPTURE_CHORD,
  effectiveChord,
  sameChord,
} from '../../../../shared/keybindings';

/**
 * The pure half of Settings → Keyboard shortcuts (ADR-0073): the rows the
 * page shows, who holds a chord, and the config slice after an
 * assignment. The quick-capture hotkey is one more row, under its own id,
 * so a command and the hotkey can never silently share a chord.
 */

/** The row id of the quick-capture hotkey (not a registry command). */
export const CAPTURE_ROW_ID = 'app.quickCapture';
export const CAPTURE_ROW_LABEL = 'Quick capture (system-wide)';

/** A command as the registry knows it: its own (default) chord. */
export interface CommandDefault {
  id: string;
  label: string;
  defaultChord: string | undefined;
}

export interface ShortcutRow {
  id: string;
  label: string;
  /** The chord in effect under the given config; `undefined` = none. */
  chord: string | undefined;
  defaultChord: string | undefined;
  /** The user changed this row (an override, or a capture chord other than the default). */
  changed: boolean;
}

/** The capture row first, then the commands by label. */
export function shortcutRows(
  commands: readonly CommandDefault[],
  config: KeybindingsConfig,
): ShortcutRow[] {
  const capture: ShortcutRow = {
    id: CAPTURE_ROW_ID,
    label: CAPTURE_ROW_LABEL,
    chord: config.capture ?? undefined,
    defaultChord: DEFAULT_CAPTURE_CHORD,
    changed: config.capture === null || !sameChord(config.capture, DEFAULT_CAPTURE_CHORD),
  };
  const rows = [...commands]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((command) => ({
      id: command.id,
      label: command.label,
      chord: effectiveChord(command.id, command.defaultChord, config.overrides),
      defaultChord: command.defaultChord,
      changed: Object.prototype.hasOwnProperty.call(config.overrides, command.id),
    }));
  return [capture, ...rows];
}

/** The row other than `exceptId` whose chord in effect is `chord`. */
export function holderOf(
  rows: readonly ShortcutRow[],
  chord: string,
  exceptId: string,
): ShortcutRow | undefined {
  return rows.find((row) => row.id !== exceptId && row.chord !== undefined && sameChord(row.chord, chord));
}

/** Ids of rows whose chord another row also has (two code defaults can collide). */
export function conflictingIds(rows: readonly ShortcutRow[]): ReadonlySet<string> {
  const byChord = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.chord ? canonicalChord(row.chord) : null;
    if (key) {
      byChord.set(key, [...(byChord.get(key) ?? []), row.id]);
    }
  }
  const out = new Set<string>();
  for (const ids of byChord.values()) {
    if (ids.length > 1) {
      ids.forEach((id) => out.add(id));
    }
  }
  return out;
}

/**
 * The slice with `chord` (or none, `null`) on row `id`. A command's chord
 * equal to its default drops the override instead of storing a copy.
 */
export function assignChord(
  config: KeybindingsConfig,
  row: Pick<ShortcutRow, 'id' | 'defaultChord'>,
  chord: string | null,
): KeybindingsConfig {
  const canonical = chord === null ? null : canonicalChord(chord);
  if (row.id === CAPTURE_ROW_ID) {
    return { ...config, capture: canonical };
  }
  const overrides = { ...config.overrides };
  if (canonical !== null && row.defaultChord !== undefined && sameChord(canonical, row.defaultChord)) {
    delete overrides[row.id];
  } else {
    overrides[row.id] = canonical;
  }
  return { ...config, overrides };
}

/** Row `id` back to its default chord. */
export function resetChord(
  config: KeybindingsConfig,
  row: Pick<ShortcutRow, 'id' | 'defaultChord'>,
): KeybindingsConfig {
  if (row.id === CAPTURE_ROW_ID) {
    return { ...config, capture: DEFAULT_CAPTURE_CHORD };
  }
  const overrides = { ...config.overrides };
  delete overrides[row.id];
  return { ...config, overrides };
}

/** `chord` onto row `target`, taking it away from row `holder` (which is left without one). */
export function replaceChord(
  config: KeybindingsConfig,
  target: Pick<ShortcutRow, 'id' | 'defaultChord'>,
  holder: Pick<ShortcutRow, 'id' | 'defaultChord'>,
  chord: string,
): KeybindingsConfig {
  return assignChord(assignChord(config, holder, null), target, chord);
}
