# 15. Editor content zoom (Ctrl +/−/0), not whole-window zoom

## Status

Accepted — replaces the main-process window zoom added earlier on the
"visual shell" milestone (never committed with an ADR).

## Context

A first pass at "make the text bigger" wired Ctrl +/−/0 (plus Ctrl+wheel
and the touchpad pinch) to `webContents.setZoomFactor` in the main process
(`electron/zoom.ts`), with the factor persisted in `window-config.json`.

That scales the **entire renderer** — sidebar, tab bar, calendar, the
entry drawer, the assistant panel, every dialog — like a browser's page
zoom. What was actually wanted is what a text editor does: change the size
of the document you are reading and writing, and nothing else. At a larger
factor the old behaviour just meant less of everything on screen.

Two things had to be decided: where the zoom logic lives, and how the
scale reaches the text.

**Ownership options considered:**

1. **Keep it in the main process, retarget the effect.** Menu items and
   the `zoom-changed` event stay, but instead of `setZoomFactor` the main
   process sends an IPC message to the renderer to bump an editor font
   scale. Keeps the View-menu entries discoverable, but adds a one-way IPC
   channel and a preload binding for what is a pure view concern.
2. **Move it to the renderer entirely.** The renderer owns the scale, the
   keys, and the wheel handler. Electron's application-menu accelerators
   would otherwise swallow `CmdOrCtrl+Plus/-/0` before the renderer sees
   them, so the View-menu zoom items have to go.

**Applying the scale:**

- A CodeMirror theme compartment reconfigured with a new base `font-size`
  works, but every heading size in `dreyHighlightStyle` was an absolute
  `px` value and would not follow.
- Drive one base `font-size` from a CSS custom property and make every
  other size in the editor theme `em`-relative to it. Headings, inline and
  fenced code, and the Live Preview widgets then all scale from the single
  knob.

## Decision

**Renderer-owned, applied through one CSS custom property.**

- `shared/app-config.ts` grows an `editor: { fontScale }` section with
  `EDITOR_FONT_SCALE_MIN/MAX/STEP` and `clampEditorFontScale` (bounds +
  0.05-grid snap so a long run of steps can't drift). It rides in the
  existing `app-config.json` — the user's choice over `localStorage` — so
  the size is one of the things `normalizeAppConfig` guarantees.
- `SettingsService.setEditorFontScale` persists it the same way the
  confirmation dialog's "don't ask again" does (`setTriggerConfirmImmediate`):
  update `_config` at once so the editor re-renders, mirror the value into
  an open draft, then write to disk — it is not part of a Settings editing
  session, so it does not wait for a Save.
- `EditorZoomService` (`providedIn: 'root'`) maps keydowns and Ctrl+wheel
  onto `stepIn` / `stepOut` / `reset`, and installs one capture-phase,
  non-passive `wheel` listener on `window` that calls `preventDefault()`
  for any Ctrl+wheel — Chromium's built-in page zoom would otherwise still
  scale the chrome. `App` instantiates it at startup so that guard is live
  before the first document opens.
- `Editor` binds `--drey-editor-scale` on its host from `zoom.scale()` and
  listens for the zoom keys on `document` (so they work from any pane
  while a document is open) and for Ctrl+wheel on its own element.
- `editor-theme.ts`: `.cm-scroller` is
  `font-size: calc(14.5px * var(--drey-editor-scale, 1))`; heading sizes
  became `em` (2.14 / 1.31 / 1.14 / 1 — the old px over the 14.5 base).
  The `, 1)` fallback means every other CodeMirror surface — the entry
  drawer's body field, which shares this theme — is unaffected: it never
  sets the property, and its own `compactTheme` pins its size anyway.
- `electron/zoom.ts` is deleted; the View-menu zoom items are removed;
  `main.ts` calls `webContents.setVisualZoomLevelLimits(1, 1)` so the
  pinch gesture cannot zoom the window.

## Consequences

- Zoom changes the editor text only. The sidebar, tabs, drawer, assistant
  panel and dialogs keep their size at every scale.
- `window-config.json` is no longer written by the app (any stale file
  from the earlier pass is simply ignored).
- The scale is global, like every other `app-config.json` value — not
  per-note, not per-tab.
- Source mode and Live Preview scale together, because both render through
  the same `.cm-scroller`.
- A Settings pane for the editor (a slider, a numeric field) is now a
  small addition — the config field and the service method already exist —
  but is not built yet; there is no "Editor" settings category.
- `clampEditorFontScale` is pure and unit-covered; the key/step mapping in
  `EditorZoomService` is unit-covered against a fake `SettingsService`.
