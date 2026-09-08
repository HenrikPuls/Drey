# 20. App-wide Appearance: highlight colour + UI scale

## Status

Accepted — extends the "Appearance" settings category (previously
editor-typeface only) and builds on [0015](0015-editor-content-zoom.md)
(editor content zoom) and [0010](0010-app-settings-storage.md) (app config
storage).

## Context

The v3 visual system (milestone 14, [0019](0019-movable-dock-panels-and-layout-state.md))
shipped with a single hard-coded accent (`--accent: #c96442` plus ~10
hand-expanded `rgba(201,100,66,…)` tints) and a fixed 13px body size. The
project owner wanted the base type a step larger and heavier, an in-app
**highlight colour** picker (presets + custom), and a **base font size**
control from which every other size follows.

[0015](0015-editor-content-zoom.md) deliberately scoped the editor
`fontScale` / `fontFamily` to the `<app-editor>` host, and explicitly
rejected `webContents.setZoomFactor` **for the editor** because it scales
the whole renderer. The new "base font size" wants exactly that whole-app
reach, so the earlier rejection does not apply here — it is a different
requirement.

Options considered for the app-wide scale:

1. **Refactor `styles.css` to a `rem` cascade** — `html { font-size }` off
   a `:root` variable, convert every `px` font-size in the token layer and
   in ~15 component stylesheets to `rem`. Correct in principle, but a large
   mechanical sweep with real regression surface (missed literals, `em`
   values, JS-string sizes in `editor-theme.ts`), and literal `px` in any
   component that was missed simply would not scale.
2. **CSS `zoom` on `:root`** — near-zero churn, scales everything. But
   `zoom` and pointer-coordinate math disagree in a few places (the drawer
   resize uses `window.innerHeight − event.clientY`; `innerHeight` is not
   zoomed, `clientY` is), so drag gestures would drift with the setting.
3. **`webContents.setZoomFactor` via IPC** — real browser zoom: layout and
   pointer coordinates scale together, exactly as Ctrl +/− in a browser.
   One new IPC channel; resets on reload so the renderer re-applies it from
   config on startup. This is what VS Code does for its UI zoom.

## Decision

**A new `appearance` config slice, applied at the document root by one
renderer service.**

- `shared/app-config.ts` grows `appearance: { uiScale, accent }`:
  - `uiScale: 'small' | 'default' | 'large' | 'xlarge'` — a **preset**, not
    a free number (four steps are enough; a slider invites fiddling).
    `UI_SCALE_FACTORS` maps each to a `setZoomFactor` value
    (0.9 / 1 / 1.15 / 1.3).
  - `accent: string` — either an `ACCENT_PRESETS` id (terracotta default,
    plus sage / slate / violet / amber / teal) or a `#rrggbb` hex for a
    custom pick. `normalizeAccent` / `resolveAccentHex` keep it valid.
  - Rides in the existing `app-config.json`, guaranteed present by
    `normalizeAppConfig`, same as the `editor` slice.
- `styles.css`: `--accent` stays the one authored colour; every `--accent-*`
  tint became `color-mix(in srgb, var(--accent) N%, …)` so a single
  override at `:root` re-colours chips, buttons, the text selection, quote
  rules and splitter hovers. The three remaining `rgba(201,100,66,…)` uses
  in component CSS and one in `editor-theme.ts` were converted the same
  way. Body size went 13 → 14px.
- `SettingsService.setAppearanceUiScale` / `setAppearanceAccent` persist
  immediately (update `_config`, mirror into an open draft, write through) —
  the same "outside a Settings editing session" pattern as
  `setEditorFontFamily` / `setTriggerConfirmImmediate`, factored into a
  shared `applyImmediate` helper.
- `AppearanceService` (`providedIn: 'root'`, instantiated by `App`) runs two
  effects: write `resolveAccentHex(accent)` onto
  `document.documentElement.style['--accent']`, and call
  `dreyApi.setUiZoomFactor(UI_SCALE_FACTORS[uiScale])`. It is the **first**
  code to override a `:root`-level CSS variable at runtime.
- New IPC `ui:set-zoom` → `mainWindow.webContents.setZoomFactor(factor)`.
- The "Appearance" settings pane gains a segmented "Base font size" control
  and a swatch row + custom `<input type="color">` for the highlight
  colour, alongside the existing editor-typeface `<select>`.

## Consequences

- One control scales the whole renderer — titlebar, docks, tabs, status
  bar, editor — with layout and pointer coordinates consistent, because it
  is genuine browser zoom. It composes with the editor's own
  `--drey-editor-scale` (Ctrl +/−): the editor ends up scaled by both,
  which is the intuitive result.
- `setZoomFactor` resets on reload; `AppearanceService`'s effect re-applies
  it whenever `SettingsService` (re)loads the config, so a refresh is
  invisible. **Cold start is the exception:**
  the renderer's single post-load `setUiZoomFactor` call races the window's
  first navigation and Chromium drops it, so `createMainWindow` also
  re-applies the stored factor on every `webContents` `did-finish-load`
  from the main process — the authoritative path.
- The accent is now a single source of truth. A custom hex with poor
  contrast is possible; the presets are the safe path and the default.
- `styles.css` no longer needs a `rem` refactor. Component stylesheets keep
  their `px` sizes; they scale because the zoom factor does, not because
  they were rewritten.
- No ADR-0015 reversal: the editor knobs stay host-scoped; this is a second,
  deliberately app-wide axis.
- `normalizeUiScale` / `normalizeAccent` / `resolveAccentHex` are pure and
  unit-covered; the mutators are covered against a fake `SettingsService`.

## Later change — Appearance joins the draft / Save / Discard flow

**Status:** Accepted (supersedes the "persist immediately" decision above
for the three in-`Settings` Appearance controls).

The immediate-apply choice made the Appearance category behave unlike
every other Settings category: its footer showed "All changes saved", the
**Save** button never enabled, and **Discard** had nothing to revert —
the project owner read this as the Save/Discard buttons being broken.

`setAppearanceUiScale` / `setAppearanceAccent` / `setEditorFontFamily` now
write to the **draft only** (`mutate()`), exactly like `patchLlm` and the
rest. They still preview **live**: `editorFontFamily()` /
`appearanceUiScale()` / `appearanceAccent()` read a new
`appearanceSource` computed — the draft while `screenOpen()`, the saved
config otherwise — so `AppearanceService`'s effects and the editor host
follow the draft as the user tries values, and a **Discard** / close
(which resets the draft) rolls the preview back. **Save** persists them
with the rest of the draft. `applyImmediate` is gone.

Unchanged and still immediate, because they fire **outside** the Settings
screen where there is no Save to wait for: `setEditorFontScale` (the
`Ctrl +/-/0` editor zoom) and `setTriggerConfirmImmediate` (the
confirmation dialog's "don't ask again").
