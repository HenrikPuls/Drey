/**
 * The iPad shell's pane state (req-96, canvas decision 12 and 31, D10):
 * whether the left sidebar (the list of the area) and the right sidebar
 * (the Mission Control conversation) are open. The state is kept **per
 * orientation** — landscape opens with all three panes, portrait with the
 * left and the centre — and persisted on this device only, in
 * localStorage under one key per orientation, the way the appearance is
 * (`theme.ts`). Turning the device restores what was open the last time
 * in that orientation. A missing or blocked storage and any broken stored
 * value fall back to the orientation's default. Pure helpers are exported
 * so the specs run without touching globals.
 */
import { Inject, Injectable, InjectionToken, Optional, computed, signal, type Signal } from '@angular/core';

export type Orientation = 'landscape' | 'portrait';

/** What is open beside the centre; the centre is always there. */
export interface PaneState {
  readonly left: boolean;
  readonly right: boolean;
}

/** The localStorage key per orientation (decision 31). */
export const PANES_STORAGE_KEY: Readonly<Record<Orientation, string>> = {
  landscape: 'mc.panes.landscape',
  portrait: 'mc.panes.portrait',
};

/** Landscape opens all three panes, portrait the left and the centre. */
export const DEFAULT_PANES: Readonly<Record<Orientation, PaneState>> = {
  landscape: { left: true, right: true },
  portrait: { left: true, right: false },
};

/** Folds a stored string into a pane state; anything but `{left, right}` booleans is the orientation's default. */
export function parsePanes(raw: string | null, orientation: Orientation): PaneState {
  const fallback = DEFAULT_PANES[orientation];
  if (raw === null) {
    return fallback;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) {
      return fallback;
    }
    const { left, right } = value as { left?: unknown; right?: unknown };
    if (typeof left !== 'boolean' || typeof right !== 'boolean') {
      return fallback;
    }
    return { left, right };
  } catch {
    return fallback;
  }
}

/** Reads one stored string; a missing entry (or storage) is null. */
function readItem(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Persists one string; a blocked storage is ignored — the state still applies. */
function writeItem(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private mode and friends: keep the in-memory state.
  }
}

/** The persisted pane state of one orientation; the default when nothing usable is stored. */
export function storedPanes(storage: Storage | null, orientation: Orientation): PaneState {
  return parsePanes(readItem(storage, PANES_STORAGE_KEY[orientation]), orientation);
}

/** Persists the pane state of one orientation. */
export function persistPanes(storage: Storage | null, orientation: Orientation, state: PaneState): void {
  writeItem(storage, PANES_STORAGE_KEY[orientation], JSON.stringify({ left: state.left, right: state.right }));
}

/** The storage and the live orientation a Panes reads (a fake pair for the specs). */
export interface PanesEnv {
  readonly storage: Storage | null;
  readonly orientation: Signal<Orientation>;
}

/** The DI token for that pair. Defaults to null (→ the browser pair). */
export const PANES_ENV = new InjectionToken<PanesEnv | null>('mc-panes-env', {
  factory: () => null,
});

/** The browser's orientation as a live signal; portrait when matchMedia is missing and the window is taller than wide. */
function browserOrientation(): Signal<Orientation> {
  if (typeof matchMedia !== 'function') {
    const tall = typeof innerWidth === 'number' && typeof innerHeight === 'number' && innerHeight > innerWidth;
    return signal<Orientation>(tall ? 'portrait' : 'landscape').asReadonly();
  }
  const mql = matchMedia('(orientation: portrait)');
  const value = signal<Orientation>(mql.matches ? 'portrait' : 'landscape');
  mql.addEventListener('change', () => value.set(mql.matches ? 'portrait' : 'landscape'));
  return value.asReadonly();
}

function browserEnv(): PanesEnv {
  return {
    storage: typeof localStorage === 'undefined' ? null : localStorage,
    orientation: browserOrientation(),
  };
}

/**
 * The one owner of the iPad pane state: the header's toggles write through
 * `toggleLeft` / `toggleRight`, the shell reads `left` / `right` for the
 * current orientation. Both orientations are read from storage at
 * construction, so a turn of the device restores that orientation's state
 * without a second read.
 */
@Injectable({ providedIn: 'root' })
export class Panes {
  readonly orientation: Signal<Orientation>;
  readonly left: Signal<boolean>;
  readonly right: Signal<boolean>;

  private readonly states: Readonly<Record<Orientation, ReturnType<typeof signal<PaneState>>>>;
  private readonly storage: Storage | null;

  constructor(@Inject(PANES_ENV) @Optional() env: PanesEnv | null = null) {
    const resolved = env ?? browserEnv();
    this.storage = resolved.storage;
    this.orientation = resolved.orientation;
    this.states = {
      landscape: signal(storedPanes(this.storage, 'landscape')),
      portrait: signal(storedPanes(this.storage, 'portrait')),
    };
    this.left = computed(() => this.states[this.orientation()]().left);
    this.right = computed(() => this.states[this.orientation()]().right);
  }

  /**
   * A surface took the right pane's room (boards 5h, 5i: Review, Flow; set by
   * the surface itself). The saved state stays; the toggle reads unpressed.
   */
  readonly covered = signal(false);

  /** The state of the current orientation. */
  current(): PaneState {
    return this.states[this.orientation()]();
  }

  setLeft(open: boolean): void {
    this.update({ ...this.current(), left: open });
  }

  setRight(open: boolean): void {
    this.update({ ...this.current(), right: open });
  }

  toggleLeft(): void {
    this.setLeft(!this.left());
  }

  toggleRight(): void {
    this.setRight(!this.right());
  }

  private update(state: PaneState): void {
    const orientation = this.orientation();
    this.states[orientation].set(state);
    persistPanes(this.storage, orientation, state);
  }
}
