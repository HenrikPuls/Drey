# 37. Split-view editor panes

## Status

Accepted. Built at the project owner's explicit request, in the same pass
as milestone 19's editor/tab-bar polish (frontmatter-fold alignment,
per-file syntax highlighting, tab reordering) — see `CLAUDE.md`'s Build
Order, item 19.

## Context

The editor was a strict singleton: one `EditorView` (`MarkdownSurface`)
reused across every tab, one flat tab list, one "active path" — the whole
app (Assistant, Tasks, Actions/Save, the status bar, MCP tools,
keybindings, the calendar, tag search's "open at line", ~20 files in all)
read that single "current document" straight off `EditorService`.

The owner asked for three related things: reorder tabs by dragging (built
separately, see the tab bar's own comment), show two documents side by
side, and be able to move an editor into a dock. The middle one — side by
side — needs *more than one simultaneous `EditorView`*, which the
singleton model cannot express at all.

Two scope decisions were made explicitly with the owner before building
(not assumed):

- **One open path per pane, not per note.** A note already open in another
  pane is *revealed* there (that pane is focused) rather than opened a
  second time. Two independent CodeMirror views editing the same shared
  buffer — independent cursor/scroll/undo, one `docChanged` racing the
  other — is real complexity for a use case ("the same note open twice")
  that was never the actual ask (different documents side by side).
- **An arbitrary split tree, not a fixed two-pane layout.** Repeated
  "Split right" / "Split down" builds any grid; the tree model costs
  little more than a fixed pair and avoids a rebuild later.
- **Docking a pane into the left/right/bottom dock is out of scope for
  this pass.** The dock's `WidgetDescriptor` registry is a *closed, static*
  set of eight singleton panels (ADR-0034) — making an editor pane a
  dynamic, N-instance dock citizen is a real, separate design (how a
  pane's identity survives a dock ↔ centre-column move, how the View menu
  and Settings → Widgets treat something that isn't a fixed descriptor)
  and is left as a follow-up.

## Decision

**A `PaneService` owns the split-tree layout; `EditorService` becomes a
facade over the *focused* pane, so every other consumer needs no change.**

- **`src/app/panes/pane-tree.ts`** — pure tree helpers (`PaneNode`: a
  `leaf` or a `split` with `direction`/`children`/`sizes`), split out for
  unit testing the same way `tagPillDecorations` / `concealDecorations`
  are: `leafIds`, `replaceLeaf`, `removeLeaf` (refuses to remove the
  tree's only leaf — collapsing an empty non-root pane is the caller's
  job), `moveWithinArray`.
- **`src/app/panes/pane.service.ts`** — `PaneRecord { id, tabs, active }`
  per leaf; `focusedId` (which pane is focused). `open(path)` reveals an
  already-open path or adds it to the focused pane; `activate`, `reorder`,
  `closeInPane` / `closeEverywhere` / `closeAllInPane` / `closeOthersInPane`,
  `moveToPane` (cross-pane drag), `splitPane` (moves one tab into a new
  sibling), `resizeSplit`, `renamePath` (keeps a pane's tab list in sync
  with an `EditorService.retargetTabs` rename). **Not session-persisted**
  — there is no open-tab restore across a restart today (`EditorService`
  starts with an empty `docs`), so a restored *layout* with empty panes
  would just be clutter; the layout always starts as one pane, like the
  tab bar always did.
- **`EditorService`** keeps `docs` (the registry: buffer, dirty state,
  kind, eol — unchanged) but no longer owns tab placement. `activePath` /
  `activeDoc` (and everything derived: `isDirty`, `viewMode`, word count,
  …) are now `computed` from `PaneService.focusedPane()`. Methods that
  used to implicitly act on "the" active document gained an **optional
  explicit path** defaulting to the focused doc: `save({ path? })`,
  `saveAs(path?)`, `setViewMode(mode, path?)`, `updateBuffer(path,
  content)` (required — a pane's buffer edit is never ambiguous about
  which document it is). `closeAll(paneId)` / `closeOthers(paneId, path)`
  are pane-scoped (a split's other panes are untouched); `closeTab(path)`
  stays global (closes wherever the path is open — in practice its one
  pane, since a path lives in only one). This design means **every one of
  the ~20 existing "current document" consumers needed zero changes** —
  they already only ever read the facade.
- **`PaneLayout`** (`src/app/panes/`) recursively renders the tree — a
  leaf becomes `PaneLeaf`; a split becomes a flex row/column of children
  with a draggable splitter between each adjacent pair, resizing only that
  pair's `sizes` entries (the same "measure current pixel size, redistribute
  a delta, keep the pair's total constant" recipe as `DockService.startSplit`).
  A standalone component can import *itself* for the recursive case — a
  supported Angular pattern, confirmed against this project's Angular
  version rather than assumed.
- **`PaneLeaf`** renders one pane's own `TabBar` + `EditorComponent` (text)
  or `ImageTab` (image, ADR-0026), or an empty state (only reachable for
  the tree's sole, tabless pane — a non-root pane collapses out of the
  layout the instant its last tab closes). A `mousedown` anywhere in the
  pane focuses it (`PaneService.focus`).
- **`TabBar`** gained a `[paneId]` input; its tab list, activate, close,
  reorder and "Close all"/"Close others" are now pane-scoped through
  `PaneService`/`EditorService`. Its existing press-then-promote drag
  gesture (mousedown → threshold → live reorder as the pointer crosses a
  neighbour's midpoint) is extended to detect the pointer over *another*
  pane's tab bar (`document.elementFromPoint` + a `[data-pane-id]` marker
  on the host — simpler than a shared drag-registry service, since this is
  the only place that needs cross-component hit-testing) and move the tab
  there instead of reordering in place. Its context menu gained "Split
  right" / "Split down" alongside "Close others" / "Close all".
- **`EditorComponent`** gained a `[paneId]` input; `shownPath`/`shownDoc`
  (from `PaneService.pane(paneId)`) replace the old `EditorService`-global
  reads for anything that must reflect *this* pane specifically (path,
  dirty state, view mode, the `⋯` menu's Markdown check). Two requests
  that travel as an app-wide id + payload signal (`newEntryRequest` —
  quick-capture — and `insertRequest` — the assistant's insert-into-note)
  are now gated on `PaneService.focusedId() === paneId()`: every open
  pane's `Editor` instance sees the same request, and without the gate
  every pane would apply it at once. `revealRequest` (tag search's "open at
  line") needs no such gate — it is scoped by path, and a path lives in
  exactly one pane, so exactly one instance's `loadedPath` ever matches.
- **`ImageTab`** gained `path` and `focused` inputs (was reading
  `EditorService.activePath` directly); `focused` gates the global
  `+`/`-`/`0` zoom keydown and the status-bar viewport feed, so a
  background pane's image tab can't steal either from the focused one.
- **`App`** renders `<app-pane-layout [node]="panes.root()">` in place of
  the old fixed `<app-tab-bar>` + `<app-editor>`/`<app-image-tab>` pair,
  still behind the existing "at least one document open" gate.

## Consequences

- Side-by-side editing works today: split right/down from a tab's context
  menu, drag a tab between panes, resize the splitter. Each pane is a real
  independent `EditorView` with its own Live Preview, spellcheck, zoom.
- The ~20 files that only ever cared about "the current document" —
  Assistant, Tasks, Actions, the status bar, MCP tools, keybindings, the
  calendar, tag search — are unmodified, because `EditorService`'s public
  surface for them is unchanged in shape, only in what "focused" now means.
- A narrow accepted gap: `EditorService.saveAll()` iterates the whole
  registry by explicit path, so `saveAs()`'s native save-path dialog for an
  unsaved scratch tab in a *non-focused* pane can still fire during "Save
  all"; after it resolves, `openFile` reopens the saved file into whichever
  pane is *currently* focused, which may not be the scratch tab's original
  pane. Rare (an untouched scratch tab sitting in a background pane during
  a bulk save) and not a data-loss risk — worth revisiting only if it comes
  up in practice.
- Frontmatter fold-per-path memory (`Editor.frontmatterFoldByPath`) is
  local to each pane's own `Editor` instance, so an expanded fold's memory
  does not follow a tab dragged to a different pane — it re-collapses
  there. Acceptable: the fold always defaults to collapsed anyway.
- Docking an editor pane into the left/right/bottom dock is not built —
  designed as its own milestone in
  [ADR-0038](0038-editor-panes-in-docks.md) (a `PaneService` region model +
  a dock "editor slot"; the `WidgetDescriptor` registry stays untouched).
