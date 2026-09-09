# 39. Drag-and-drop chrome: deferred commit, shared overlay, no-drop feedback

## Status

Accepted. Built at the project owner's request after the tab drag shipped
in milestone 19 felt wrong: it committed the move on every mouse-move, so
the tab jumped between slots and panes under the cursor, and elements
underneath reacted to the pointer as if hovered.

## Context

Two press-then-promote drag gestures existed, built independently:

- **`DockService`** (dock panel header) already deferred its commit to the
  drop and showed a floating chip + a drop-line — the good pattern. But the
  page underneath still fired `:hover` / `mouseover` and could start a text
  selection during the drag.
- **`TabBar`** (editor tab) called `PaneService.moveToPane` on *every*
  `mousemove`, so the tab list mutated live. No drag image, no drop
  indicator, no invalid-target feedback, no ESC / window-blur cancel, and
  it set `body { user-select: none }` **without** the `data-drey-gesture`
  marker that `InputRecoveryService`'s watchdog (ADR-0032) reads — so a
  slow drag could be "recovered" out from under the user.

## Decision

**One shared drag-chrome module, and real drag-and-drop semantics for both
gestures.**

- **`src/app/dnd/` (`drag-chrome.ts` + barrel)** — module-level DOM helpers
  (not an Angular service, so `DockService` and the new `TabDragService`
  share one instance):
  - A **full-viewport `.drag-overlay`** mounted for the drag's duration. It
    captures the pointer, so nothing beneath shows a hover state or starts
    a selection, and it owns the cursor (`grabbing` ⇄ `no-drop`, one
    place). `hitTestUnderPointer` toggles its `pointer-events` off around a
    single `elementFromPoint` call.
  - The **ghost** chip that follows the cursor (`.dock-drag-ghost` /
    `.tab-drag-ghost`, styled in `src/styles.css`).
  - `<body>` gets `user-select: none`, a cursor, and
    `data-drey-gesture` — the watchdog contract, set for the whole gesture
    including while the cursor is `no-drop`.
- **`TabDragService` (`src/app/tab-bar/tab-drag.service.ts`)** — the
  tab-side analogue of `DockService`'s gesture ownership. `TabBar` reports
  the `mousedown` and renders the `.drop-line` from the service's
  `dropTarget` signal; the service runs the whole lifecycle. A press is a
  click until the pointer clears 4px; once promoted the source tab stays
  put, `dropTarget` tracks where a release would land, and the move commits
  **once**, on `mouseup`, via `PaneService.moveToPane`.
  - Valid drop targets: a **tab strip** (`data-tabstrip-pane` on the
    `TabBar` host) at a precise slot, or **anywhere in a pane's body**
    (`data-pane-id` on the `PaneLeaf` host) → appended to that pane.
    Anything else → `dropTarget = null`, cursor `no-drop`, release moves
    nothing.
  - **ESC** or the **window losing focus** mid-drag cancels with no move
    (the tab drag had neither before).
  - The hit-test keys off `data-*` attributes, never tag names — the test
    host renders `TabBar` as a plain `<div>`.
- **`DockService`** header drag now calls `startDragChrome` /
  `moveDragChrome` / `endDragChrome` in place of its own
  `mountDragGhost` / `setGlobalGesture('grabbing')`. Its
  `dropDock` / `dropIndex` / `move()` logic is unchanged — it already
  deferred to the drop. The splitter / dock-edge gestures keep their own
  `setGlobalGesture` (a separate path, `row-resize` / `col-resize`).

## Consequences

- Both drags feel the same: source stays put, a titled chip follows the
  cursor, a 2px accent drop-line marks the landing slot, invalid targets
  show `no-drop`, and nothing underneath reacts to the pointer.
- The tab move is now atomic and cancellable; `PaneService.moveToPane` is
  called exactly once per drop (or never).
- `InputRecoveryService`'s watchdog no longer races the tab drag — the
  `data-drey-gesture` marker is set for the whole gesture, and a lost
  `mouseup` (Alt-Tab) is caught by the `window` `blur` handler.
- A dock panel drag has no `no-drop` state — every position resolves to a
  dock, by design (unchanged).
- The shared `src/app/dnd/` overlay is the natural place to hang the pane
  header drag when [ADR-0038](0038-editor-panes-in-docks.md) (editor panes
  in docks) is built.
