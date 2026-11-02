/**
 * The shell's theme switch (concept §7 chrome): two palettes keyed off
 * `[data-theme]` on the document element — anthracite (the default,
 * this repo's chrome) and cyberpunk (the UI prototype's palette, Draft
 * v11). The choice persists in localStorage; a missing or blocked
 * storage and a broken stored value all fall back to the default.
 * Pure helpers are exported so the specs run without touching globals.
 */
import { Inject, Injectable, InjectionToken, Optional, signal } from '@angular/core';

/** The themes styles.css ships a token block for. */
export type ThemeName = 'anthracite' | 'cyberpunk';

/** The stable order the toggle cycles through. */
export const THEMES: readonly ThemeName[] = ['anthracite', 'cyberpunk'];

/** The theme before the owner ever toggled (and after any broken read). */
export const DEFAULT_THEME: ThemeName = 'anthracite';

/** The localStorage key the choice persists under. */
export const THEME_STORAGE_KEY = 'mc.theme';

/** The user-facing names the toast reports. */
export const THEME_LABEL: Record<ThemeName, string> = {
  anthracite: 'Anthracite',
  cyberpunk: 'Cyberpunk',
};

/** The document/storage pair a Theme reads and writes (a fake pair for the specs). */
export interface ThemeEnv {
  readonly doc: Document | null;
  readonly storage: Storage | null;
}

/**
 * The DI token for that pair. Defaults to null (→ the browser pair);
 * the specs construct a Theme with a fake pair directly.
 */
export const THEME_ENV = new InjectionToken<ThemeEnv | null>('mc-theme-env', {
  factory: () => null,
});

/** Folds an unknown stored value into a theme name; anything odd is the default. */
export function parseTheme(value: unknown): ThemeName {
  return value === 'cyberpunk' ? 'cyberpunk' : DEFAULT_THEME;
}

/** Applies the theme on the document element — the token blocks key off it. */
export function applyTheme(name: ThemeName, doc: Document): void {
  doc.documentElement.dataset['theme'] = name;
}

/** Reads the persisted theme; a missing entry (or storage) is the default. */
export function storedTheme(storage: Storage | null): ThemeName {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persists the theme; a blocked storage is ignored — theming still works. */
export function persistTheme(name: ThemeName, storage: Storage | null): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, name);
  } catch {
    // Private mode and friends: keep the in-memory choice.
  }
}

/** The browser pair; both guarded so a DOM-less test environment stays harmless. */
function browserEnv(): ThemeEnv {
  return {
    doc: typeof document === 'undefined' ? null : document,
    storage: typeof localStorage === 'undefined' ? null : localStorage,
  };
}

/**
 * The one theme owner for the shell: the tabbar's toggle writes through
 * `toggle()`, the toast reads the label, and every component picks the
 * palette up via the token blocks (no per-component theme logic).
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  /** The active theme; applied on the document element at construction. */
  readonly name = signal<ThemeName>(DEFAULT_THEME);

  private readonly env: ThemeEnv;

  constructor(@Inject(THEME_ENV) @Optional() env: ThemeEnv | null = null) {
    this.env = env ?? browserEnv();
    this.apply(storedTheme(this.env.storage));
  }

  /** Switches to `name`, persists it, applies it and returns the active name. */
  set(name: ThemeName): ThemeName {
    persistTheme(name, this.env.storage);
    this.apply(name);
    return this.name();
  }

  /** The toggle button: anthracite → cyberpunk → anthracite. */
  toggle(): ThemeName {
    return this.set(this.name() === 'cyberpunk' ? 'anthracite' : 'cyberpunk');
  }

  private apply(name: ThemeName): void {
    this.name.set(name);
    if (this.env.doc !== null) {
      applyTheme(name, this.env.doc);
    }
  }
}
