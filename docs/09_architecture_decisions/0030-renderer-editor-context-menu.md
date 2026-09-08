# 30. A renderer-owned editor context menu, replacing the OS menu

## Status

Accepted. Introduced with the template library
([ADR-0029](0029-template-library.md)); interacts with the native context
menu in `electron/menu.ts` and reuses the edit-command routing from the
titlebar menu ([ADR-0019](0019-movable-dock-panels-and-layout-state.md)).

## Context

The project owner wanted "Insert template" on the editor's right-click
menu, showing template names. Electron builds that menu in the main process
(`attachContextMenu`, `webContents.on('context-menu')`) from hit-test
params — the renderer cannot add rows to it or read its state. The choice
was: keep the native menu and expose templates only elsewhere (the panel,
the `⋯` menu, the `Mod+T` picker), or have the renderer own the editor's
context menu entirely. The owner picked the renderer-owned menu.

The native menu still has to stay for real form fields — the Settings
screen's `<input>`/`<textarea>`, the entry-drawer topic field — where
`webContents` clipboard roles are exactly right.

## Decision

**The renderer draws the context menu for every CodeMirror surface; the
main process suppresses its native menu there, keyed on `formControlType`.**

- **Suppression.** In `attachContextMenu`, bail before `Menu.popup` when
  `params.isEditable && params.formControlType === 'none'`. CodeMirror's
  editing surface is a `contenteditable` div: Chromium reports
  `isEditable === true` but `formControlType === 'none'`; a real `<input>`
  is `'input-text'`, a `<textarea>` `'text-area'`. So form fields keep the
  OS menu and the CM surface loses it. (Electron ≤ some version exposed
  this as `inputFieldType`; Electron 44 renamed it to `formControlType`.)
  The non-editable "just Copy on a selection" branch is untouched.
- **The renderer menu.** `EditorContextMenuService` (`providedIn: 'root'`,
  started from `App` like `DropGuardService`) adds one capture-phase
  `contextmenu` listener on `window`: if the target is inside `.cm-editor`
  it `preventDefault()`s and opens the menu at a viewport-clamped anchor;
  anywhere else it does nothing. `EditorContextMenu` (mounted at App level)
  renders `.ctx-menu` with Cut / Copy / Paste / Select all — routed through
  `MenuService.execEdit` (renamed from the private `exec`), so they behave
  exactly like the titlebar Edit menu (CM commands for undo/redo/selectAll,
  `webContents` clipboard ops after re-focusing the view) — then, when a
  note is open, the recent templates and "All templates…".
- **The entry-drawer surface** uses the same shared `MarkdownSurface`, so
  it gets the same renderer menu automatically (clipboard rows only — the
  template section hides with no active note). Acceptable: it is a small
  capture field and the clipboard rows still work.

### Alternatives considered

- **Keep the native menu, add templates only to the `⋯` menu / panel /
  picker.** Simpler, no `menu.ts` change, but not what was asked — no
  right-click affordance in the editor.
- **Publish the editor's bounding rect(s) to main and skip the native menu
  for points inside them.** Deterministic and version-proof, but needs a
  new IPC channel, a `ResizeObserver`/scroll publisher, and rect
  bookkeeping in `menu.ts`. Kept in reserve as the fallback if
  `formControlType` proves unreliable in the field; the one-line param
  check ships first.
- **A per-component `(contextmenu)` handler on the editor host.** Would
  miss the drawer surface and duplicate the listener; the single
  capture-phase `window` listener mirrors `DropGuardService`.

## Consequences

- Right-click inside any CodeMirror surface now shows an in-app menu, not
  the OS one; right-click in a native input still shows the OS one.
- `MenuService.exec` is now the public `execEdit` — one behaviour for the
  titlebar Edit menu and the context menu.
- If a future Electron changes `formControlType` semantics for
  `contenteditable`, the native menu could reappear over the editor (or
  vanish from a field) — caught by the manual right-click checks in the
  ADR-0029 verification list; the bounding-rect fallback is the fix.
- One more capture-phase `window` listener (`contextmenu`), alongside the
  `wheel` (ADR-0015) and `dragover`/`drop` (ADR-0027) guards.
