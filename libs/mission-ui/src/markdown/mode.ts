/**
 * The Markdown surface's mode per surface (E12-6): which of Live Preview,
 * View and Source the owner last picked on THIS device for each place text
 * is shown — the plan sheet, the ticket text, the proof. Saved in
 * localStorage; a missing or blocked storage and any broken value fall
 * back to the surface's own default (View wherever results are presented,
 * Live Preview where the owner writes).
 */
export type MdMode = 'live' | 'view' | 'source';

export const MD_MODES: readonly MdMode[] = ['live', 'view', 'source'];

/** The segmented control's labels. */
export const MD_MODE_LABEL: Record<MdMode, string> = {
  live: 'Live',
  view: 'View',
  source: 'Source',
};

const KEY_PREFIX = 'mc.md-mode.';

/** The minimal storage the helpers need (a `Storage` or a test fake). */
export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isMdMode(value: unknown): value is MdMode {
  return value === 'live' || value === 'view' || value === 'source';
}

/** The remembered mode for a surface, or the default. Never throws. */
export function storedMode(storage: ModeStorage | null, surface: string, fallback: MdMode): MdMode {
  try {
    const raw = storage?.getItem(KEY_PREFIX + surface) ?? null;
    return isMdMode(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** Remembers the pick. A blocked storage is silently skipped. */
export function storeMode(storage: ModeStorage | null, surface: string, mode: MdMode): void {
  try {
    storage?.setItem(KEY_PREFIX + surface, mode);
  } catch {
    /* storage blocked: the pick lasts for this session only */
  }
}

/** The device's storage, or null where there is none (SSR, a blocked browser). */
export function deviceStorage(): ModeStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
