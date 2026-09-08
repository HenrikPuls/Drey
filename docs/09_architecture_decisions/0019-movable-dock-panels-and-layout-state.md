# 19. Movable dock panels, a custom titlebar, and one layout state

## Status

Accepted — implemented with the milestone-14 "v3 visual system" pass.

## Context

The v3 UI handoff (`handoff/DESIGN.md` + the `Drey App v3.dc.html`
prototype) replaces the fixed shell — a `sidebar | main | assistant`
row with three drag handles — with a **dock system**: the calendar, the
file tree, the tag search and the open-windows list (previously fixed
children of `Sidebar`) plus the note assistant become five panels that
the user drags between a left and a right dock, resizes with splitters,
and collapses to their header. It also asks for an HTML menu bar
(File / Edit / Selection / View) in a frameless titlebar ("VS Code
style"), and a 26px status bar.

Before this, layout state was four scalar pane sizes in
`LayoutService` (`localStorage['drey.layout']`); there was no persisted
notion of panel arrangement, and `Menu.setApplicationMenu` drew a native
menu the design does not use.

## Decision

- **`DockService`** owns the whole layout as one `LayoutState`
  (`dock: {left,right: PanelId[]}`, `flexes`, `open`, `leftW`, `rightW`),
  persisted synchronously to `localStorage['drey.dock']` and merged
  defensively onto the defaults on read. It also runs the live gestures
  (`window`-level mouse listeners for the header drag; pointer capture for
  splitters and the dock-edge resizers), because those need element rects
  and must survive the panel reordering under the pointer — component
  code only registers host elements and starts a gesture. Ported from the
  prototype's `onDragMove` / `startSplit` / `startDockWidth`.
- **`Sidebar` is removed.** Its file-tree markup + context menu + inline
  create flow move into a `FilesPanel`; `App` composes
  `titlebar / [left dock | main | right dock] / status bar` directly. The
  five panels are a descriptor registry (`PANEL_TITLES` /
  `PANEL_COMPONENTS`) rendered through `*ngComponentOutlet` and wrapped in
  a shared `PanelFrame` (the identical 32px header: chevron, mono-uppercase
  title, optional status value, drag grip).
- **Frameless window.** `titleBarStyle: 'hidden'` (Windows/Linux) /
  `'hiddenInset'` (macOS). A renderer `Titlebar` draws the accent square,
  the HTML `MenuBar` (a `MenuService` holds the menu model; wired rows
  call `KeybindingService` command ids, unwired rows render disabled), and
  — off macOS — minimize / maximize / close buttons over four new IPC
  channels (`window:minimize` / `window:toggle-maximize` / `window:close`
  / `window:is-maximized` + a `window:maximize-changed` push). The native
  `Menu` is kept only on macOS.
- `LayoutService` keeps only the drawer height and the assistant composer
  height — the two sizes that are not part of the dock.
- `dock` and `titlebar` are feature modules with `index.ts` barrels
  ([ADR-0016](0016-feature-module-convention.md)).

## Consequences

- One place to reason about layout; `View → Reset layout` is
  `DockService.reset()`. Panel arrangement now survives a restart.
- The window has no OS chrome on Windows/Linux; the app is responsible
  for the drag region (`-webkit-app-region`) and the window controls.
  macOS keeps its traffic lights and system menu bar (best-effort — the
  dev/test target is Windows).
- `Ctrl+S` / `Ctrl+Shift+S` moved from an `Editor` host listener to
  app-wide `KeybindingService` commands, so the titlebar menu and the
  keyboard share one definition.
- Deviation from the prototype, recorded here and in `specs/`: the editor
  stays CodeMirror 6 + Live Preview ([ADR-0009](0009-live-preview-decorations.md)) —
  the prototype's `contenteditable` block model and its per-block-type
  gutter offsets are not reproduced; line numbers use CM's standard
  line-based gutter, re-themed. The multi-vault switcher is reduced to
  "Open other vault …" (no vault registry in the backend).
- The dock gestures are hand-rolled on native events, keeping the "no
  CDK / split-pane dependency" line the shell already held.

## Later change — a third dock, and "Add entry" as a panel

The two-dock model (`left | right`) became `left | right | bottom`. The
bottom dock is a resizable band **under the editor** — `DockService.bottomH`
plus a horizontal edge splitter. Panels stack vertically inside it exactly
as in a side dock, so no new gesture code was needed — only a `'bottom'`
branch in the drop hit-test and `startDockResize`, and a `bottom` list +
`bottomH` in the persisted `DockState` (a stored blob without them
re-homes the new panel from the defaults).

The "Add entry" drawer — previously a fixed strip owned by `App` with its
own toggle button and a `LayoutService.drawerHeight` — is now a normal
dock panel (`PanelId 'entry'`, default home: the bottom dock, opens
collapsed). `PanelFrame`'s chevron governs show/hide, the unsent-draft
dot moved to the panel header status value, and `App` lost all its
imperative drawer-resize code. `DockService.contentHeight(id)` (a small
set, currently just `calendar`) marks a panel that takes its content
height instead of a `flex-grow` share and draws no splitter on its edges.
`LayoutService.drawerHeight` is now unused but left in place.
