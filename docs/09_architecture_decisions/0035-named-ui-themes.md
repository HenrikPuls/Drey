# 35. Named UI themes (published CodeMirror themes + a derived shell)

## Status

Accepted. A deliberate scope addition at the project owner's request,
amending [ADR-0020](0020-app-wide-appearance-accent-and-ui-scale.md) (which
shipped a single hard-coded look with only a swappable accent) and relaxing
`handoff/DESIGN.md`'s "one high-fidelity look" constraint.

## Context

ADR-0020 gave the app one palette (`src/styles.css` `:root`, dark-only) plus
a runtime-overridable `--accent`. The owner asked for selectable **themes**
in Settings -> Appearance -- "VS Code", "Zen"-style, and so on -- and, after
a first pass that hand-authored two or three, asked specifically that the
**publicly available CodeMirror 6 themes be usable** and that the shell
track them, so "add another later" is a data change rather than a design
exercise.

Two problems:

- **Where do the editor themes come from?** Hand-authoring a faithful VS
  Code / Dracula / Nord `EditorView.theme` + `HighlightStyle` each is a lot
  of tuning and drifts from the originals.
- **The shell.** A community CM theme colours only the editor. The docks,
  titlebar, panels and Settings still need a palette, and maintaining a
  hand-tuned token set per theme does not scale past a handful.

## Decision

**A theme catalog built on `@uiw/codemirror-themes-all`, with the shell
palette derived from a per-theme seed.**

- **Dependency: `@uiw/codemirror-themes-all`** (MIT, ~40 CM6 themes, each an
  `Extension` bundling its own `HighlightStyle`). Chosen over `thememirror`
  (no VS Code / Nord / Solarized-dark) and
  `@fsegurai/codemirror-theme-bundle` (smaller, fewer marquee names). Its
  sub-packages `import _extends from "@babel/runtime/..."` without declaring
  it, so `@babel/runtime` is added as a direct dependency too.
- **`src/app/editor/themes/theme-catalog.ts`** -- `THEME_CATALOG`, a
  `ThemeCatalogEntry[]`: `id` (stored in `AppConfig.appearance.theme`),
  `label`, `group` (`Drey` / `Dark` / `Light`), a `seed`
  (`{ bg, fg, accent, dark }`), and `load(): Promise<Extension>`.
  - `drey` -- the built-in look; `load` resolves the local `dreyEditorLook`
    synchronously and its seed mirrors `styles.css` `:root`.
  - ~18 published entries -- `load` is a **dynamic** `import('@uiw/...')`,
    so the whole theme bundle lands in a lazy chunk, not the initial
    payload. `bg` / `fg` are lifted (inlined) from each package's
    `defaultSettings*`; `accent` is a hand-picked representative token
    colour (the packages expose no single accent).
- **Derived shell (`src/styles.css` + `ThemeService`)** -- a new
  `:root[data-theme] { … }` block re-expresses every surface / text-ramp /
  border / hover token as a `color-mix()` of two seed vars, `--_bg` and
  `--_fg`. `ThemeService` (new, mirrors `AppearanceService`) writes those
  two + `color-scheme` onto `<html>` and sets `data-theme` for a published
  theme; for **Drey** it clears them, so the bespoke `:root` is used
  verbatim -- selecting "Drey" is byte-identical to the pre-theme app. The
  ratios read as "N% toward the text colour", so a light seed works without
  a separate light block.
- **`AppConfig.appearance.theme: string`** (`shared/app-config.ts`, plain
  string -- `shared/` cannot import the renderer catalog; an unknown id
  resolves to `'drey'`). Accent gains a **`'theme'` sentinel** (the new
  default) meaning "follow the theme's seed accent"; `resolveAccentHex`
  takes the seed accent as a second argument. Explicit `ACCENT_PRESETS` /
  custom hex still override.
- **Live editor swap** -- `MarkdownSurface` holds the CM theme in a
  `Compartment`, seeded with Drey and reconfigured from `entry.load()` on
  every `ThemeService.theme()` change, with a token guard against an
  out-of-order lazy load. No view rebuild, undo history kept; the shared
  surface means the full-page editor and the compact "Add entry" field
  follow together.
- **Settings** -- Appearance gains a grouped `<select>` (Drey / Dark /
  Light) and a "match the theme" swatch in the highlight-colour row. Draft-
  previewed live like the other Appearance controls (ADR-0020 later change).

### Scope

The compartment carries each theme's own `EditorView.theme` +
`HighlightStyle`. Structural editor extensions with no palette of their own
(`gutterTheme`, `compactTheme`, `frontmatter-fold`, `tag-pill`, spellcheck
underline, live-preview widget theme) stay `var(--token)`-driven and follow
the derived shell tokens.

### Alternatives considered

- **Hand-authored `EditorView.theme` per named theme.** Rejected -- tuning
  cost and drift from the originals; the owner explicitly asked for the
  published themes.
- **A hand-tuned `[data-theme]` token block per theme.** Rejected -- does
  not scale past a handful; the seed derivation gives every catalog entry a
  coherent shell for free.
- **Static import of the catalog's theme extensions.** Rejected -- pushed
  the initial bundle past budget; the dynamic `import()` moves ~18 themes
  into a lazy chunk and keeps "add another = one array entry" cheap.
- **A `prefers-color-scheme` light/dark axis.** Deferred -- light themes are
  in the catalog, but a full system-driven light/dark mode (revisiting every
  `{ dark: true }` CM extension) is out of scope here.

## Consequences

- Two new runtime dependencies (`@uiw/codemirror-themes-all`,
  `@babel/runtime`) and a lazy chunk (~70 kB raw) loaded when the editor
  first mounts or on a theme switch.
- `ThemeService` is the second service (after `AppearanceService`) that
  writes `:root`-level CSS variables at runtime; both are instantiated once
  from `App`.
- `AppConfig.appearance` gains `theme`; the default `accent` changes from
  `'terracotta'` to the `'theme'` sentinel (resolves to the same terracotta
  hex for Drey, so no visible change). `app-config.spec.ts` /
  `settings.service.spec.ts` updated.
- `styles.css` `:root` is unchanged for Drey; the new `:root[data-theme]`
  block only ever applies to a published theme.
- New surface for `specs/` -- `roadmap.md` Phase 1 UI-shell bullet now
  mentions selectable themes; `handoff/DESIGN.md` notes Drey as the
  reference look, others derived.
