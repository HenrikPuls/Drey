# 89. Views: saved layouts with their own tabs

## Status

Accepted (2026-11-04) and built as E13-1, milestone 123 -- the base half
(views, switching, tabs per view, session). Plugin-contributed presets and
`homeView` (decision 2, 7) are E13-2 and not built yet. The direction was
confirmed by the owner on 2026-11-04 (a view switcher, tabs per view, hidden
elsewhere but addable). The owner made saved layouts mandatory and first in
the build order: without them the agent system and the note app are unusable
side by side.
Extends ADR-0019 (dock layout state), ADR-0037/0038 (panes and docked editor
bands) and ADR-0043 (session snapshot). Design: `docs/design/work-panel/
desktop-integration.md`, boards 7a to 7i.

## Context

Drey has one layout: three docks, a centre pane tree, one set of open tabs.
That fits a note app. Bringing the agent system (tickets, board, review, team,
Mission Control in the Assistant) onto the desktop puts a second kind of work
next to notes. With one layout the two compete for the same docks and the same
tab bar, and every switch of activity means rearranging panels and closing or
hunting tabs. The owner's words: it gets annoying to tell the agent system and
the note app apart.

Constraints that shape the answer:

- The base knows no plugin features (ADR-0044). "Work" cannot be hard-wired
  into the shell; a plugin has to contribute it.
- Documents already have one registry and one buffer per file
  (`OpenDocsStore`, ADR-0003/0037). A file open in two places must not become
  two buffers, two dirty states or two save conflicts.
- The assistant's vault tools read and change open files through their tab
  (milestone 78, `OpenDocsBridge`); that must keep working whichever view is
  active.
- The session snapshot restores layout and tabs across restarts (ADR-0043,
  ADR-0038 "As shipped").

## Decision

1. **A view is a named, saved layout.** It holds the dock state (which panel in
   which dock, open or closed, flexes and sizes: ADR-0019), the pane tree with
   the docked editor bands (ADR-0037/0038), the tab set with the active tab per
   pane, and the default conversation target of the Assistant. It does not hold
   the vault registry, settings, theme, the status bar, notifications or the
   Assistant's history; those are global.
2. **Notes and Work are the first two views.** Notes is today's layout and
   receives the existing state on migration. Work is contributed by the tickets
   plugin, not by the base: a plugin registers a *view preset* (id, label,
   initial layout, default Assistant target) through a new SDK call. The base
   offers the same mechanism to the user ("Save current layout as a view…",
   "Edit views…"). Built-in and plugin views cannot be deleted by the user,
   user views can.
3. **Switching.** A segmented control in the title bar (a menu when there are
   more views than fit), `Ctrl+1` to `Ctrl+9`, and a "Switch view" command.
   Switching restores the other view's panes, sizes and tabs exactly as left.
4. **Tabs belong to views.** Each view has its own tab set. The tabs of other
   views are fully hidden: not in the tab bar, not in the quick switcher. They
   can be brought in on purpose, and one tab may belong to several views: the
   tab's context menu ticks the views it appears in, and the Open windows panel
   lists "In other views" with a "Show here" button. A tab is not copied; it is
   one document shown in several views.
5. **One document, one buffer.** The document registry stays global. A view
   only owns the *placement* of a document (a pane leaf). The one-pane-per-path
   rule of ADR-0037 holds per view. Dirty state, save, mtime conflicts
   (ADR-0060) and external reloads act on the document, so they are seen
   whichever view is active.
6. **Closing.** Closing a tab removes it from the active view. The document
   closes for good, with the usual unsaved-changes prompt, when no view still
   holds it.
7. **Where a new tab opens.** The active view, unless the opener names a home
   view. A plugin may name one for its doc kind or file opener (a ticket file,
   the Board, the Review: `Work`). Opening such a document from another view
   adds it to its home view and switches there; an explicit "Open in this view"
   keeps the user in place. The same rule applies the other way (opening a note
   from Work goes to Notes).
8. **Signals cross views.** The status bar, the Assistant history and
   notifications are global. A change in another view shows as a status item
   ("3 need you in Work"), which needs plugin status bar items in the SDK (a
   companion change, not part of this ADR).
9. **Persistence.** `localStorage['drey.dock']` and the pane layout in the
   session snapshot become a map keyed by view id plus the active view id. The
   snapshot version stays 1 and the new fields are additive, as ADR-0038 did for
   docked panes; a snapshot without views restores into Notes. "Reset layout"
   resets the active view only.
10. **Hidden views cost nothing at rest.** The panes of an inactive view are
    unmounted; per-tab state (selection, scroll, fold state) is kept with the
    placement so that switching back restores it.

## Alternatives considered

- **One layout, richer tab groups.** Cheaper, but the problem is the docks and
  panels as much as the tabs: Work wants Tickets and Capacity docked, Notes
  wants Files and Outline. Rejected.
- **Shared tabs, separate docks.** Rejected by the owner: the tab bar is where
  the confusion shows.
- **A second app window per activity.** Separate window state, no shared
  documents or docks, and the single-instance rules (`electron/main.ts`) get in
  the way. Rejected.
- **Mission Control embedded as a web page in a tab.** Keeps the umbilical
  cord: no editor, no docks, no links to other tools. Rejected in the desktop
  design (option C).
- **Hard-wired "Work" in the base.** Violates ADR-0044. Rejected in favour of
  the plugin-contributed preset.

## Consequences

- `DockService` and `PaneService` gain a view dimension: their state moves from
  one slot to one slot per view, behind the same facades (`EditorService`,
  `pane(id)`), so most consumers stay unchanged. This is the main cost and the
  main regression risk; ADR-0038's band logic must be covered by the same specs
  per view.
- A new SDK call (view presets) and `homeView` on doc kinds and file openers;
  an SDK minor version. Both are content-agnostic: any plugin can contribute a
  view or name a home view.
- The tab bar, the Open windows panel, the quick switcher, the tab context menu
  and the View menu change; the keyboard shortcut list gains `Ctrl+1` to
  `Ctrl+9`, which must not collide with existing bindings (checked when built).
- `OpenDocsBridge` and the assistant's vault tools keep working because they
  address documents, not placements. A document held by no view cannot be open
  by definition.
- The manual (`docs/manual/manual.md`), docs/05 and docs/06 gain a "Views"
  section when this ships; the `specs/frontmatter-schema.md` is not touched (no
  vault file changes).
## As built (E13-1, milestone 123)

- **State.** `DockService` keeps the active view's layout in its signal and
  every other view's as a parked slot; `PaneService` does the same with a
  `ViewSlot` (centre tree, panes, focus, docked bands; pure edits in
  `src/app/panes/view-slot.ts`). Pane and split ids come from one counter, so
  they never repeat across views. `ViewService` (`src/app/views/`) owns the
  list and the active id and switches both services together; the list of user
  views is `localStorage['drey.views']`.
- **Persistence.** `localStorage['drey.dock']` became
  `{ active, views: { <id>: DockState } }`; the old flat blob reads as Notes.
  The session snapshot stays version 2 (the ADR said 1; the shipped version
  is 2) with an additive `views` map: `layout` is the Notes layout, every
  other view sits in `views`, `tabs` is the union over all views. A snapshot
  without `views` restores into Notes; a view that no longer exists drops its
  layout, and a document only that view held is closed.
- **Closing.** The tab's X and "Close all / others" leave only the active view
  while another view shows the document (no prompt: nothing is lost); the
  unsaved-changes prompt comes when the last view lets go. Deleting a file
  closes its tab in every view; so does a rename follow it everywhere.
  Replacing a clean tab (opening another file) is also per view.
- **"Save current layout as a view…"** copies the dock layout and the pane
  tree *including its tabs* (documents are shared, not copied) under fresh
  pane ids, and switches to the new view. Deleting a user view closes the
  documents only it held (asking about unsaved changes; a cancelled prompt
  moves the document into Notes).
- **UI.** The switcher is in the title bar (`src/app/titlebar/view-switcher.*`):
  a segmented control up to four views, a menu above that, nothing at all with
  Notes alone. Right-click on a user view: Rename, Delete. `Ctrl+1`-`Ctrl+9`
  (commands `view.switch.1`-`9`), "Switch view" (next, wrapping),
  "Save current layout as a view…" are commands and View-menu rows. A tab's
  context menu ticks the views it shows in ("Show this tab in"); the last tick
  cannot be removed. The Open windows panel lists the active view's tabs and,
  under "In other views", the other documents with a "Show here" button; its
  header count is the active view's.
- **Not built here (E13-2).** View presets from plugins, `homeView`, the
  Assistant's default target per view. The quick switcher lists vault files,
  not open tabs, so it needed no change; the "include other views" toggle is
  not needed. A history jump (back/forward) to a document that only another
  view shows brings it into the active view. Hidden views cost nothing at rest:
  their pane components are not mounted.

- Open for the implementation: whether the quick switcher gets an "include other
  views" toggle; how many views the title bar shows before it folds into a menu;
  how a plugin preset is versioned when its layout changes; whether user views
  can be exported.
