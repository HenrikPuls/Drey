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
  line-based gutter, re-themed. ~~The multi-vault switcher is reduced to
  "Open other vault …" (no vault registry in the backend).~~ Superseded:
  the full vault registry landed in
  [ADR-0051](0051-multi-vault-registry.md).
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

**Every panel reaches every dock.** `move()` was always generic, but two
things made the bottom band feel like `entry`-only: `App` unmounted a dock
the instant it held no panels (so an emptied dock stopped registering as a
drop target), and the `bottom` drop test only matched the band's live
rect (~32 px with `entry` collapsed). Now `App` also mounts a dock while
`DockService.dragActive()` (any header drag in progress), an emptied dock
mounted this way shows a dashed "Drop a panel here" band (bottom: a fixed
140 px via `Dock.hostHeight()`), and the `onDragMove` region test treats
the whole lower band as `bottom` unless the pointer is horizontally over a
side dock — the same "whole half" leniency the side docks already had.
Dock resize splitters still render only for a non-empty dock.

## Later change — low-profile headers, click-to-collapse, drag feedback

Panel headers were reworked to be quieter and to carry their own drag
affordance:

- **No chevron button.** `PanelFrame`'s header is now a single
  `role="button"` region. `mousedown` opens a *press* gesture in
  `DockService.beginHeaderPress(id, title, event)`: released under a ~4 px
  move → `toggleCollapse`; past it → the existing header drag. Enter /
  Space on the focused header also toggles. The header no longer takes an
  accent-tinted background while dragging — only `cursor: grab/grabbing`
  and a faint text lift on hover/focus.
- **Drag ghost.** On promotion to a drag, `DockService` appends a
  `position: fixed` `.dock-drag-ghost` chip (the panel title, `styles.css`)
  that follows the cursor and is removed on drop — the "something is
  happening" signal that used to be a status-bar sentence.
- **Drop target.** The accent inset ring on the target dock
  (`--drop-ring`) is replaced by a translucent dark wash
  (`:host(.drop-target)::after`); the 2 px accent drop-line stays.
- **Collapse animation.** The panel body stays mounted while collapsed
  (its `*ngComponentOutlet` panel keeps its state) inside a
  `grid-template-rows: 1fr ⇄ 0fr` wrapper that transitions over 140 ms;
  `content-visibility: hidden` (with `allow-discrete`) skips rendering once
  folded. Previously the body — and the panel component — were destroyed on
  collapse.
- **Status bar.** The idle "Drag a panel header…" hint (and its drag-state
  variant) is gone; `StatusBar` no longer injects `DockService`.

## Later change — data-driven registry + a true hide/show ([ADR-0034](0034-internal-widget-model.md))

- The closed `PanelId` union and the `Record<PanelId, …>` maps
  (`panel-registry.ts`, `CONTENT_HEIGHT_PANELS`, the `defaultState()`
  literals) are replaced by a `WIDGETS: WidgetDescriptor[]` registry
  (`src/app/dock/widget-registry.ts`). `PanelId` is now an open `WidgetId`
  string alias; `defaultState()` / `merge()` / `contentHeight()` /
  `PanelFrame` title + flush all read the registry.
- `DockState` gains **`hidden: WidgetId[]`**. `DockService.hide(id)` pulls a
  widget out of every dock; `show(id)` puts it back at its descriptor's
  default slot, expanded; `isHidden(id)` reports it. `move()` /
  `openAndExpand()` clear `hidden`. It persists in `localStorage['drey.dock']`.
- The View menu toggles **visibility** now, not collapse: `widgetRow`'s
  check mark is `!isHidden(id)`, and the rows are generated from
  `WIDGETS.filter(w => w.removable)` so every panel — including `tasks` and
  `entry`, which had none — gets one. Collapsing to the header stays the
  header-click gesture.

## Later change — controls in the panel header (req-7)

Panels no longer draw their own control band under the shared 32px header
(the Tasks scope/hide-done/kind toggles, the Files/Templates refresh
buttons). Instead a panel
body may mark one `<ng-template>` with the `[appPanelHeaderActions]="<id>"`
directive; `PanelFrame` renders it inside a `.head-actions` slot in the
header, pinned to the right edge immediately left of the drag grip (only
`.head-actions` takes the `auto` margin — `.head-actions + .grip` resets
the grip's, so the controls don't drift toward the centre). The slot stops
`mousedown` / `keydown` so operating a control never triggers the header
collapse/drag gesture (the idiom DESIGN.md §193 describes for the old
chevron).

The template is relayed through `PanelHeaderActionsStore` — a leaf
`providedIn: 'root'` service (`src/app/dock/panel-header-actions.ts`,
a `Map<widgetId, TemplateRef>` signal) rather than `DockService`, so a
panel component can import the directive without an import cycle back
through `widget-registry.ts` (which references every panel class). The
directive registers on `afterNextRender` and clears (identity-guarded, for
the destroy/recreate of a panel move) on destroy. Not a new mechanism for
the widget registry — `WidgetDescriptor` is untouched.

## Later change — sentence-case headers, shared icon controls, no default bottom panel ([ADR-0057](0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md))

Milestone 43 supersedes two points above:

- **Header typography.** The panel title is sentence-case sans (13px,
  600) instead of mono uppercase; the header controls of every panel —
  core and plugin — are the global `.icon-btn` / `.seg`, not per-panel
  button styles. Chevron-less click-to-collapse, the status value and the
  drag grip are unchanged.
- **The bottom dock has no default resident.** The "Add entry" panel was
  removed, so a default layout shows no bottom band; the dock itself
  (and docking a panel or an editor band there) is unchanged. A stored
  layout that still names the `entry` widget drops the id on load.

Bar heights moved with the same change: titlebar and tab bar 36px, the
editor meta bar 40px, the status bar 28px.
