# 27. Window-level drag-and-drop navigation guard

## Status

Accepted. Prerequisite for drag-and-drop into the editor
([ADR-0028](0028-drag-drop-into-the-editor.md)); builds on
[ADR-0015](0015-editor-content-zoom.md) (the sibling global `wheel`
guard) and [ADR-0001](0001-electron-process-split-contextbridge.md).

## Context

Chromium's default behaviour for a file or link dropped **anywhere on the
page** is to navigate the `BrowserWindow` to it — `file:///…/that.png`, or
the dragged URL. In a single-page Electron app that replaces the whole
renderer with a raw image / a "can't be reached" page, with no way back
except restarting.

Only `.cm-content` (the CodeMirror editing surface) and native
`<input>` / `<textarea>` fields have their own drop handling. Every other
region — the frameless titlebar, the docks, the tab bar, the status bar,
the empty state, the editor chrome bar — is an unguarded drop zone.

Before adding "drag an image/file into a note", the stray-drop case had to
become a safe no-op.

## Decision

**A renderer service that installs one capture-phase `window` guard, plus
`will-navigate` / `setWindowOpenHandler` in the main process as
belt-and-braces.**

- `DropGuardService` (`providedIn: 'root'`, `src/app/services/`),
  force-instantiated in `App`'s constructor next to `EditorZoomService` —
  the same pattern as the global `Ctrl`+wheel guard (ADR-0015):
  - `window.addEventListener('dragover' | 'drop', …, { capture: true, passive: false })`.
  - `drop`: if `event.target.closest('.cm-content, input, textarea, [contenteditable="true"]')`
    → do nothing (those own their drop); otherwise `preventDefault()` —
    no navigation.
  - `dragover`: same target check; otherwise `preventDefault()` **only**
    when `dataTransfer.types` carries something a drop handler might act on
    (`Files`, `text/uri-list`, `text/html`,
    `application/x-drey-vault-path`), so the "copy" cursor appears while
    dragging a real payload and not for every unrelated drag.
  - **Never `stopPropagation`.** The early-return for editable targets
    means CodeMirror's `drop` (`image-paste.ts`, which calls its own
    `preventDefault`) and native-field text-drop are byte-for-byte
    unchanged; the guard only suppresses the browser's default on the
    parts of the page that have no handler.
- `electron/main.ts` `createMainWindow()`:
  - `webContents.on('will-navigate', …)` — `preventDefault` unless the URL
    is the dev server (`DREY_RENDERER_URL`) or `app://`. Catches anything
    the renderer guard misses.
  - `webContents.setWindowOpenHandler(…)` — `{ action: 'deny' }`, and an
    `http(s)` URL is handed to `shell.openExternal` (the OS browser).

### Alternatives considered

- **Unconditional `window` `preventDefault` on every `dragover`/`drop`.**
  Kills text-drag into the topic / tag / search `<input>`s, and shows the
  "copy" cursor for every unrelated drag.
- **A per-region directive / handler.** Easy to miss a spot; a new panel
  or overlay silently reintroduces the hole. One window guard is
  exhaustive by construction.
- **Only the main-process `will-navigate`.** It fires too late — the
  renderer has already begun tearing down for the navigation, and the
  flash/again is user-visible. The renderer guard stops it cleanly; the
  main-process hooks are the safety net.

## Consequences

- A file / link dropped on any chrome is a silent no-op; dropped on the
  editor text or a native field it works as before / as designed
  (ADR-0028).
- One more always-on renderer service; trivial and dependency-free.
- `will-navigate` also blocks a stray `<a href>` click to an external
  site from replacing the app; such links now open in the OS browser via
  `setWindowOpenHandler`. No such links exist today, but the behaviour is
  now the safe one.
