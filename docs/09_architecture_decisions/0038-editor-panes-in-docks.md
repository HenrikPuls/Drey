# 38. Editor panes in the docks (split-view Phase 2)

## Status

Proposed. The follow-up ADR-0037 named but deferred ("Phase 2"): letting an
editor pane live inside the left / right / bottom dock, not only the centre
column. Written now at the owner's request so the milestone is ready to
pick up; **not yet implemented**.

## Context

ADR-0037 built split-view panes as a tree that lives entirely inside
`.main-pane` — the centre column. The three docks (`DockService`) are a
separate world:

- `DockService` is hard-wired to the **static `WIDGETS` registry**
  (ADR-0034): `DockState.dock` / `flexes` / `open` are `Record<WidgetId, …>`
  seeded from `WIDGETS`; `merge()` / `read()` **strip any id not in
  `ALL_WIDGET_IDS`** from a persisted blob; `Dock` renders each panel with
  `NgComponentOutlet` and **passes no inputs**; the View menu and Settings →
  Widgets both enumerate `WIDGETS`.
- `PaneService` models exactly one centre-column split tree (`_root`); it
  has no notion of "this leaf lives in a dock".
- `PaneLeaf` is already self-contained: `[paneId]` input, focus-on-mousedown,
  picks `Editor` / `ImageTab` / empty. It can be rendered anywhere.

Making an editor pane a `WidgetDescriptor` would mean fighting every one of
those `WIDGETS`-coupled code paths (dynamic ids in `DockState` persistence,
`flexes`/`open` records, the View menu, the Settings category). The editor
is not a singleton panel and should not pretend to be one.

## Decision (proposed)

**A dedicated dock "editor slot", not editor-as-widget.** `DockService`
stays widget-only and untouched; `PaneService` grows a notion of *region*.

1. **`PaneService` named regions.**
   `PaneRegion = 'center' | 'dock-left' | 'dock-right' | 'dock-bottom'`.
   `_root` becomes `_roots: Record<PaneRegion, PaneNode | null>` — `center`
   always present, dock regions `null` until an editor is moved there. Pane
   ids stay globally unique, so an internal `paneId → region` lookup keeps
   `paneIds()`, `focusedId`, `focus`, `pane(id)` and every existing call
   site working unchanged. New ops:
   - `detachToDock(paneId, side)` — remove the leaf from `center` (collapse
     as today if it empties the split), seed `dock-<side>`'s root with it,
     focus it.
   - `reattachToCenter(paneId)` — the reverse; drops the dock region to
     `null` when its last leaf leaves.
   A dock region holds **a single leaf**, not a subtree — no nested splits
   inside a dock (revisit only if asked).

2. **`Dock` renders the region above its widget list.** When
   `panes.regionRoot('dock-' + side)` is non-null, `Dock` renders an
   `<app-pane-layout [node]="…">` in a resizable sub-band at the top of that
   dock, wrapped in a `PanelFrame`-style 32px header (title = the pane's
   active tab name). The header reuses `DockService`'s existing
   press-then-promote drag so the whole editor group can be dragged to
   another dock or back to the centre — the gesture's `move()` is
   generalised to accept an `{ kind: 'editor', paneId }` payload alongside a
   `WidgetId`. The dock's existing outer-edge width/height splitters already
   size the column/band; the sub-band gets its own splitter against the
   first widget below it (same recipe as `DockService.startSplit`).

3. **Persistence.** `DockService` stays widget-only — editor panes never
   enter `DockState`, so `merge()` / `ALL_WIDGET_IDS` need no change.
   `PaneService` gains its own `localStorage['drey.panes']` holding the
   region roots (not tab contents). Because there is still no open-tab
   restore across a restart (ADR-0037), on load any dock region whose leaf
   has no live document is dropped — a restored empty editor band would be
   clutter.

4. **Entry points.**
   - Tab context menu: "Move to left / right / bottom dock" and, when the
     pane is already in a dock, "Move back to editor area".
   - Drag the editor-group header onto a dock — reuse
     `DockService.dockEls` hit-testing (already generalised in step 2).
   - Optionally a `pane.moveToDock*` `KeybindingService` command later.

5. **Out of scope even for this milestone.**
   - The same note open in a centre pane *and* a dock pane at once — keep
     ADR-0037's one-pane-per-path rule.
   - Nested splits inside a dock region.
   - Restoring editor layout (centre or dock) across a restart — blocked on
     open-tab restore, which does not exist yet.

## Consequences

- `DockService`, `DockState`, `ALL_WIDGET_IDS`, the View menu and Settings →
  Widgets are all untouched — the editor stays out of the
  `WidgetDescriptor` model entirely.
- `PaneService` carries the whole change: regions, region-aware tree ops, a
  small persistence slice. Every existing consumer still reads the
  `EditorService` facade / `pane(id)` and is unaffected.
- A dock that hosts an editor band shows it above its normal widget stack;
  the band and the widgets below share the dock's width (side) or the
  band's own height splitter (bottom).
- Estimated size: one focused pass on `pane.service.ts` + `pane-tree.ts`,
  `dock.ts` / `dock.html` / `dock.css`, `DockService` drag payload, the tab
  context menu, and a new `drey.panes` persistence path — comparable to
  ADR-0037 itself. Its own milestone, not folded into milestone 19.
