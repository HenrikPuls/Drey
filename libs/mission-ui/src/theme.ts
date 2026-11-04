/**
 * The device's appearance (E12-3, design boards 5f / 5g): the theme
 * (Anthrazit, Drey, Cyberpunk), the highlight colour, the text size
 * S–XXXL, Compact lists and Reduce motion. All of it is saved on this
 * device only (localStorage) and applies at once: the theme and the two
 * switches ride `data-*` attributes on the document element that the
 * token blocks and component styles key off, the highlight colour is a
 * `--accent` override, the text size a `--mc-text` factor every
 * font-size multiplies. A missing or blocked storage and any broken
 * stored value fall back to the defaults. Pure helpers are exported so
 * the specs run without touching globals.
 */
import { Inject, Injectable, InjectionToken, Optional, signal } from '@angular/core';

/** The themes styles.css ships a token block for. */
export type ThemeName = 'anthrazit' | 'drey' | 'cyberpunk';

/** The order the settings screen lists them in. */
export const THEMES: readonly ThemeName[] = ['anthrazit', 'drey', 'cyberpunk'];

/** The theme before the owner ever chose (and after any broken read). */
export const DEFAULT_THEME: ThemeName = 'anthrazit';

/** The user-facing names. */
export const THEME_LABEL: Record<ThemeName, string> = {
  anthrazit: 'Anthrazit',
  drey: 'Drey',
  cyberpunk: 'Cyberpunk',
};

/** The three swatches of a theme's preview chip: ground, panel, accent. */
export const THEME_SWATCH: Record<ThemeName, { readonly bg: string; readonly panel: string; readonly accent: string }> = {
  anthrazit: { bg: '#18191b', panel: '#222326', accent: '#8ecbef' },
  drey: { bg: '#1d1916', panel: '#292420', accent: '#e08a68' },
  cyberpunk: { bg: '#100b1a', panel: '#1b1330', accent: '#ff5ad9' },
};

/** The highlight colours; `default` keeps the theme's own accent. */
export type AccentName = 'default' | 'blue' | 'teal' | 'violet' | 'pink' | 'orange' | 'yellow';

export const ACCENTS: readonly AccentName[] = ['default', 'blue', 'teal', 'violet', 'pink', 'orange', 'yellow'];

export const ACCENT_LABEL: Record<AccentName, string> = {
  default: 'Theme default',
  blue: 'Blue',
  teal: 'Teal',
  violet: 'Violet',
  pink: 'Pink',
  orange: 'Orange',
  yellow: 'Yellow',
};

/** The override colour; `default` has none (the theme's accent stands). */
export const ACCENT_COLOR: Record<Exclude<AccentName, 'default'>, string> = {
  blue: '#8ecbef',
  teal: '#7fd1b9',
  violet: '#a78bfa',
  pink: '#f2a0d0',
  orange: '#f0a58a',
  yellow: '#e6d27a',
};

/** Text sizes (canvas decision 2026-11-04): S / L / XL / XXL / XXXL, L the default. */
export type TextSize = 'S' | 'L' | 'XL' | 'XXL' | 'XXXL';

export const TEXT_SIZES: readonly TextSize[] = ['S', 'L', 'XL', 'XXL', 'XXXL'];

/** The body text size in px each step stands for (the board's "L · 17 px"). */
export const TEXT_BODY_PX: Record<TextSize, number> = { S: 15, L: 17, XL: 19, XXL: 21, XXXL: 24 };

/** The px every stylesheet writes its base font-sizes in (the body at the scale's origin). */
export const TEXT_BASE_PX = 15;

/** The factor each size multiplies every font-size by: body px over the base. */
export const TEXT_SCALE: Record<TextSize, number> = {
  S: TEXT_BODY_PX.S / TEXT_BASE_PX,
  L: TEXT_BODY_PX.L / TEXT_BASE_PX,
  XL: TEXT_BODY_PX.XL / TEXT_BASE_PX,
  XXL: TEXT_BODY_PX.XXL / TEXT_BASE_PX,
  XXXL: TEXT_BODY_PX.XXXL / TEXT_BASE_PX,
};

export const DEFAULT_TEXT_SIZE: TextSize = 'L';

/**
 * The first build's steps (S M L XL XXL) onto the new ones, one step up
 * from M on, so a stored choice keeps its place in the order and the old
 * default M lands on the new default L. Nobody loses a setting.
 */
const LEGACY_TEXT_SIZE: Readonly<Record<string, TextSize>> = { S: 'S', M: 'L', L: 'XL', XL: 'XXL', XXL: 'XXXL' };

/** The localStorage keys, one per setting. */
export const THEME_STORAGE_KEY = 'mc.theme';
export const ACCENT_STORAGE_KEY = 'mc.accent';
export const TEXT_SIZE_STORAGE_KEY = 'mc.textSize';
/** Present once the text size is stored in the S / L / XL / XXL / XXXL scale. */
export const TEXT_SIZE_SCALE_KEY = 'mc.textSizeScale';
export const COMPACT_STORAGE_KEY = 'mc.compact';
export const MOTION_STORAGE_KEY = 'mc.reduceMotion';

/** The document/storage pair a Theme reads and writes (a fake pair for the specs). */
export interface ThemeEnv {
  readonly doc: Document | null;
  readonly storage: Storage | null;
  /** The OS "reduce motion" preference, the switch's default; absent = false. */
  readonly prefersReducedMotion?: boolean;
}

/**
 * The DI token for that pair. Defaults to null (→ the browser pair);
 * the specs construct a Theme with a fake pair directly.
 */
export const THEME_ENV = new InjectionToken<ThemeEnv | null>('mc-theme-env', {
  factory: () => null,
});

/** Folds an unknown stored value into a theme name; the first build's `anthracite` is Anthrazit. */
export function parseTheme(value: unknown): ThemeName {
  if (value === 'anthracite') {
    return 'anthrazit';
  }
  return THEMES.find((name) => name === value) ?? DEFAULT_THEME;
}

export function parseAccent(value: unknown): AccentName {
  return ACCENTS.find((name) => name === value) ?? 'default';
}

/** Folds a value of the current scale into a size; anything else is the default. */
export function parseTextSize(value: unknown): TextSize {
  return TEXT_SIZES.find((name) => name === value) ?? DEFAULT_TEXT_SIZE;
}

/** A pre-2026-11-04 stored value (S M L XL XXL) as its new step. */
export function migrateLegacyTextSize(value: unknown): TextSize {
  return typeof value === 'string' ? (LEGACY_TEXT_SIZE[value] ?? DEFAULT_TEXT_SIZE) : DEFAULT_TEXT_SIZE;
}

/** Applies the theme on the document element — the token blocks key off it. */
export function applyTheme(name: ThemeName, doc: Document): void {
  doc.documentElement.dataset['theme'] = name;
}

/** The accent override as the `--accent` value; null = remove the override. */
export function accentValueOf(name: AccentName): string | null {
  return name === 'default' ? null : ACCENT_COLOR[name];
}

/** Reads one stored string; a missing entry (or storage) is null. */
function readItem(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Persists one string; a blocked storage is ignored — the choice still applies. */
function writeItem(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private mode and friends: keep the in-memory choice.
  }
}

/** Reads the persisted theme; a missing entry (or storage) is the default. */
export function storedTheme(storage: Storage | null): ThemeName {
  return parseTheme(readItem(storage, THEME_STORAGE_KEY));
}

/**
 * The persisted text size. Names S, L, XL and XXL exist in both scales,
 * so a value is read as the current scale only when the marker key says
 * it was written by it; an unmarked value is the first build's and is
 * migrated (and re-saved) once.
 */
export function storedTextSize(storage: Storage | null): TextSize {
  const raw = readItem(storage, TEXT_SIZE_STORAGE_KEY);
  if (readItem(storage, TEXT_SIZE_SCALE_KEY) === '2') {
    return parseTextSize(raw);
  }
  if (raw === null) {
    return DEFAULT_TEXT_SIZE;
  }
  const migrated = migrateLegacyTextSize(raw);
  writeItem(storage, TEXT_SIZE_STORAGE_KEY, migrated);
  writeItem(storage, TEXT_SIZE_SCALE_KEY, '2');
  return migrated;
}

/** Persists the theme. */
export function persistTheme(name: ThemeName, storage: Storage | null): void {
  writeItem(storage, THEME_STORAGE_KEY, name);
}

/** The browser pair; both guarded so a DOM-less test environment stays harmless. */
function browserEnv(): ThemeEnv {
  return {
    doc: typeof document === 'undefined' ? null : document,
    storage: typeof localStorage === 'undefined' ? null : localStorage,
    prefersReducedMotion:
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

/**
 * The one appearance owner for the shell: the settings screen writes
 * through the setters; every component picks the result up via the token
 * blocks and the `--mc-text` factor (no per-component theme logic).
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  /** The active theme; applied on the document element at construction. */
  readonly name = signal<ThemeName>(DEFAULT_THEME);
  readonly accent = signal<AccentName>('default');
  readonly textSize = signal<TextSize>(DEFAULT_TEXT_SIZE);
  readonly compact = signal(false);
  readonly reduceMotion = signal(false);

  private readonly env: ThemeEnv;

  constructor(@Inject(THEME_ENV) @Optional() env: ThemeEnv | null = null) {
    this.env = env ?? browserEnv();
    const storage = this.env.storage;
    this.name.set(storedTheme(storage));
    this.accent.set(parseAccent(readItem(storage, ACCENT_STORAGE_KEY)));
    this.textSize.set(storedTextSize(storage));
    this.compact.set(readItem(storage, COMPACT_STORAGE_KEY) === 'true');
    const motion = readItem(storage, MOTION_STORAGE_KEY);
    this.reduceMotion.set(motion === null ? this.env.prefersReducedMotion === true : motion === 'true');
    this.applyAll();
  }

  /** Switches to `name`, persists it, applies it and returns the active name. */
  set(name: ThemeName): ThemeName {
    persistTheme(name, this.env.storage);
    this.name.set(name);
    this.applyAll();
    return this.name();
  }

  setAccent(name: AccentName): void {
    writeItem(this.env.storage, ACCENT_STORAGE_KEY, name);
    this.accent.set(name);
    this.applyAll();
  }

  setTextSize(size: TextSize): void {
    writeItem(this.env.storage, TEXT_SIZE_STORAGE_KEY, size);
    writeItem(this.env.storage, TEXT_SIZE_SCALE_KEY, '2');
    this.textSize.set(size);
    this.applyAll();
  }

  setCompact(on: boolean): void {
    writeItem(this.env.storage, COMPACT_STORAGE_KEY, String(on));
    this.compact.set(on);
    this.applyAll();
  }

  setReduceMotion(on: boolean): void {
    writeItem(this.env.storage, MOTION_STORAGE_KEY, String(on));
    this.reduceMotion.set(on);
    this.applyAll();
  }

  private applyAll(): void {
    const doc = this.env.doc;
    if (doc === null) {
      return;
    }
    applyTheme(this.name(), doc);
    const root = doc.documentElement;
    root.dataset['compact'] = String(this.compact());
    root.dataset['reduceMotion'] = String(this.reduceMotion());
    const style = root.style as CSSStyleDeclaration | undefined;
    const accent = accentValueOf(this.accent());
    if (accent === null) {
      style?.removeProperty('--accent');
    } else {
      style?.setProperty('--accent', accent);
    }
    style?.setProperty('--mc-text', String(TEXT_SCALE[this.textSize()]));
  }
}
