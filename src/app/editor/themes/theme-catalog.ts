import type { Extension } from '@codemirror/state';
import { ANTHRAZIT_THEME, DREY_THEME } from '../../../../shared/app-config';
import { dreyEditorLook } from '../editor-theme';

/**
 * The seed a non-Drey theme derives its *shell* palette from -- the docks,
 * titlebar, panels and Settings, everything outside the CodeMirror surface.
 * `ThemeService` writes `bg` / `fg` onto `--_bg` / `--_fg` at the document
 * root and `src/styles.css`'s `:root[data-theme]` block `color-mix()`es the
 * whole token set off those two (plus `--accent`). `accent` feeds
 * `--accent` when `AppearanceConfig.accent` is the `'theme'` sentinel.
 *
 * The `bg` / `fg` values below are lifted from each package's
 * `defaultSettings*` export (a few `fg`s are nudged where the package's
 * declared foreground is an odd choice for body text). They are inlined --
 * not imported -- so the catalog stays free of the theme bundle and only
 * the *selected* theme's code is pulled in, on demand, by `load()`.
 */
export interface ThemeSeed {
  bg: string;
  fg: string;
  accent: string;
  dark: boolean;
}

export interface ThemeCatalogEntry {
  /** Stored in `AppConfig.appearance.theme`. */
  id: string;
  label: string;
  /** `<optgroup>` bucket in the Settings picker. */
  group: 'Drey' | 'Dark' | 'Light';
  seed: ThemeSeed;
  /**
   * Resolves the CodeMirror 6 theme extension (view theme + syntax
   * highlighting). Drey is local and synchronous; every published theme is
   * a dynamic `import()` of `@uiw/codemirror-themes-all`, so the bundle
   * lands in a lazy chunk instead of the initial payload.
   */
  load: () => Promise<Extension>;
}

type ThemeExport =
  | 'vscodeDark'
  | 'vscodeLight'
  | 'githubDark'
  | 'githubLight'
  | 'dracula'
  | 'nord'
  | 'tokyoNight'
  | 'tokyoNightStorm'
  | 'materialDark'
  | 'gruvboxDark'
  | 'monokai'
  | 'solarizedDark'
  | 'solarizedLight'
  | 'xcodeLight'
  | 'quietlight'
  | 'andromeda'
  | 'aura'
  | 'atomone';

const loadPublished = (name: ThemeExport) => (): Promise<Extension> =>
  import('@uiw/codemirror-themes-all').then((m) => m[name] as Extension);

function published(
  id: string,
  label: string,
  group: 'Dark' | 'Light',
  ext: ThemeExport,
  seed: Omit<ThemeSeed, 'dark'>,
): ThemeCatalogEntry {
  return { id, label, group, seed: { ...seed, dark: group === 'Dark' }, load: loadPublished(ext) };
}

/**
 * The original terracotta look, kept as an optional theme. Its seed
 * mirrors `src/styles.css`'s `:root` so selecting "Drey" is byte-identical
 * to the un-themed sheet (`ThemeService` also clears the `data-theme`
 * attribute for it, so the bespoke `:root` wins outright and none of the
 * derived tokens apply).
 */
const DREY: ThemeCatalogEntry = {
  id: DREY_THEME,
  label: 'Drey',
  group: 'Drey',
  seed: { bg: '#1b1a19', fg: '#e6e3dd', accent: '#c96442', dark: true },
  load: () => Promise.resolve(dreyEditorLook),
};

/**
 * Anthrazit (milestone 43) — **the default theme**: first in the picker,
 * what a fresh install starts on, and what an unknown stored id resolves
 * to. Neutral charcoal-gray surfaces with a blue accent. Like
 * Drey it is a bespoke palette -- `styles.css` carries a
 * `:root[data-theme='anthrazit']` block that overrides the derived tokens
 * with exact values -- and it reuses the token-driven Drey editor look, so
 * the editor follows the same variables.
 */
const ANTHRAZIT: ThemeCatalogEntry = {
  id: ANTHRAZIT_THEME,
  label: 'Anthrazit',
  group: 'Drey',
  seed: { bg: '#18191b', fg: '#f4f5f6', accent: '#8ecbef', dark: true },
  load: () => Promise.resolve(dreyEditorLook),
};

export const THEME_CATALOG: readonly ThemeCatalogEntry[] = [
  ANTHRAZIT,
  DREY,
  published('vscode-dark', 'VS Code Dark', 'Dark', 'vscodeDark', { bg: '#1e1e1e', fg: '#d4d4d4', accent: '#569cd6' }),
  published('vscode-light', 'VS Code Light', 'Light', 'vscodeLight', { bg: '#ffffff', fg: '#383a42', accent: '#0067c0' }),
  published('github-dark', 'GitHub Dark', 'Dark', 'githubDark', { bg: '#0d1117', fg: '#c9d1d9', accent: '#58a6ff' }),
  published('github-light', 'GitHub Light', 'Light', 'githubLight', { bg: '#ffffff', fg: '#24292e', accent: '#0969da' }),
  published('dracula', 'Dracula', 'Dark', 'dracula', { bg: '#282a36', fg: '#f8f8f2', accent: '#bd93f9' }),
  published('nord', 'Nord', 'Dark', 'nord', { bg: '#2e3440', fg: '#d8dee9', accent: '#88c0d0' }),
  published('tokyo-night', 'Tokyo Night', 'Dark', 'tokyoNight', { bg: '#1a1b26', fg: '#a9b1d6', accent: '#7aa2f7' }),
  published('tokyo-night-storm', 'Tokyo Night Storm', 'Dark', 'tokyoNightStorm', { bg: '#24283b', fg: '#c0caf5', accent: '#7aa2f7' }),
  published('material-dark', 'Material Dark', 'Dark', 'materialDark', { bg: '#2e3235', fg: '#bdbdbd', accent: '#82aaff' }),
  published('gruvbox-dark', 'Gruvbox Dark', 'Dark', 'gruvboxDark', { bg: '#282828', fg: '#ebdbb2', accent: '#fabd2f' }),
  published('monokai', 'Monokai', 'Dark', 'monokai', { bg: '#272822', fg: '#f8f8f2', accent: '#a6e22e' }),
  published('solarized-dark', 'Solarized Dark', 'Dark', 'solarizedDark', { bg: '#002b36', fg: '#93a1a1', accent: '#268bd2' }),
  published('solarized-light', 'Solarized Light', 'Light', 'solarizedLight', { bg: '#fdf6e3', fg: '#586e75', accent: '#268bd2' }),
  published('xcode-light', 'Xcode Light', 'Light', 'xcodeLight', { bg: '#ffffff', fg: '#3d3d3d', accent: '#1f6feb' }),
  published('quiet-light', 'Quiet Light', 'Light', 'quietlight', { bg: '#f5f5f5', fg: '#333333', accent: '#4b83cd' }),
  published('andromeda', 'Andromeda', 'Dark', 'andromeda', { bg: '#23262e', fg: '#d5ced9', accent: '#00e8c6' }),
  published('aura', 'Aura', 'Dark', 'aura', { bg: '#21202e', fg: '#edecee', accent: '#a277ff' }),
  published('atomone', 'Atom One', 'Dark', 'atomone', { bg: '#272c35', fg: '#9d9b97', accent: '#61afef' }),
];

const BY_ID: ReadonlyMap<string, ThemeCatalogEntry> = new Map(
  THEME_CATALOG.map((entry) => [entry.id, entry]),
);

/** The catalog entry for a stored theme id; an unknown id falls back to the default, Anthrazit. */
export function resolveTheme(id: string): ThemeCatalogEntry {
  return BY_ID.get(id) ?? ANTHRAZIT;
}
