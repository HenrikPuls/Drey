# 0057 — UI refinement: sentence-case icon chrome, the Anthrazit theme, and capture through the `/` menu

## Status

Accepted (milestone 43). Amends
[ADR-0019](0019-movable-dock-panels-and-layout-state.md) (panel-header
typography, the bottom dock's default resident),
[ADR-0013](0013-inline-spellcheck.md) and
[ADR-0022](0022-configurable-entry-templates.md) (the "Add entry" drawer
is gone; the entry format stays) and
[ADR-0035](0035-named-ui-themes.md) (a second bespoke theme).

## Context

After milestone 42 the main window had grown inconsistent. The owner's
feedback, worked through as a design mockup first (the "Drey UI
Refinement" canvas, built on the Anthrazit design system):

- **Too many type styles.** The v3 system set panel titles, tabs, file
  names and the status bar in 10–11.5px mono uppercase next to sans body
  text; every panel had drifted to its own button shape (`.hdr-btn`,
  `.tgl`, `.seg`, three text-button styles on the right-hand side).
- **Text buttons and placeholders as noise.** "File | Vault | All",
  "Export", "Summarize", "Clear", "done", "Prompts", "Live edit" and the
  `+ tag` / `filter text…` placeholders all compete with the content.
- **Search needed two fields.** Searching by tag alone meant moving from
  the text field to a separate tag row.
- **"Add entry" did not earn its place.** A separate capture drawer with
  its own topic field, tag row and (since milestone 42) toolbar; in use it
  was more friction than typing into the note, yet typing directly gave
  less structure.
- **Files:** create and rename happened in a field pinned above the tree,
  away from the row they concern.

## Decision

### 1. One chrome vocabulary, for every theme

- **Sentence-case sans** for all chrome labels (panel titles, tabs, file
  names, status bar, menus). Mono stays where it carries meaning: code,
  the meta-bar path, line numbers. The size tokens keep their historical
  `--fs-mono-*` names so call sites did not have to change; their values
  are 12–13px now and `--ls-mono-title` is 0.
- **One icon button** (`.icon-btn`, 24px, radius 4, `.on` = accent tint)
  and **one segmented switch** (`.seg`) in the global sheet, used by core
  panels and — because plugin CSS and DOM share the document — by every
  plugin panel.
- **Icon-only controls.** Every former text button is an icon with the
  words in `title` + `aria-label`. Plugins get glyphs from the host
  through the new `api.ui.icon(name, size)` (SDK 1.10) instead of carrying
  path tables.
- **No placeholder text** in the panel fields; an icon inside the field
  and the `aria-label` say what it is.
- Grid: titlebar and tab bar 36px, meta bar 40px, panel header 32px, rows
  28px, status bar 28px.

### 2. Anthrazit as a second bespoke theme

`anthrazit` joins the catalog next to `drey` (group "Drey"). Unlike the
published themes it is not derived from two seed colours: a
`:root[data-theme='anthrazit']` block after the derived block replaces
every token with the exact value (surfaces `#1e1b17 / #262220 / #2e2a26`,
lines `#3a3530 / #4d4740`, ink `#f3efe9 / #ada69c`, accent `#8ecbef`,
no shadows). It reuses the token-driven Drey editor look.

The owner chose **a separate theme over replacing Drey's palette**: the
terracotta look stays available unchanged. A **fresh install** starts on
Anthrazit (`DEFAULT_APPEARANCE.theme`); a stored config keeps its theme,
and one without a `theme` key still normalizes to `drey` — nobody's
existing look changes under them.

### 3. One query field for text and tags

The shared `TagField` gains a **free-text mode** (`freeText` option, also
on `api.ui.createTagField`): the single input holds the text query, and a
typed `#name` word lifts out into a coloured chip — on the space after
it, on Enter, on blur, or when picked from the completion dropdown. The
pure tokenizer is `src/app/tags/tag-query.ts`. Search and Tasks both use
it; their separate tag rows are gone. Extending the base field (rather
than a second component in the tags plugin) keeps chip colours and
vocabulary completion in one implementation.

### 4. Capture moves into the `/` menu; "Add entry" is removed

- The slash menu is sectioned: **Templates** (rank 0) then
  **Formatting**. The base source contributes a built-in **Entry**
  option — `composeEntry(EMPTY_ENTRY_DRAFT, activeEntryPattern)`, i.e. the
  configured entry format with the current time, caret left after the
  time where the topic goes. The templates plugin contributes every
  library template through its own completion source
  (`plugins/templates/renderer/slash.ts`); CodeMirror merges both sources
  and equal-named sections.
- The selected template shows a **preview card** beside the list
  (CodeMirror's `info`), rendered as plain text. The Templates panel
  shows the same card on row hover.
- The `EntryPanel` / `EntryDrawer` / `EntryDraftService` / `AutotagButton`
  are deleted, with the `draft` path through the editor command bus.
  `api.ui.registerComposerContribution` stays in the SDK as a deprecated
  no-op, so no plugin API major bump is needed.
- The Settings category survives, renamed **"Entry format"**: it now
  configures what the Entry item inserts.

### 5. Editor meta bar carries the formatting buttons

`<app-markdown-toolbar>` moves from a strip rendered by `MarkdownSurface`
into the `Editor`'s 40px meta bar (path · formatting icons · Unsaved ·
Lines · Save · More). The surface only exposes `applyToolbarAction` /
`insertToolbarImages`. The buttons are on unless switched off in the `⋯`
menu (they are part of the bar, no longer an extra row).

### 6. Files: edit in place; Calendar: Today

A new file/folder is an input row directly under its target folder (or
vault header); a rename turns the row's name into the input. File names
stay on one line and fade out at the right edge; the tooltip carries the
full path. The calendar's month row **replaces the panel title**: the
expanded panel's header is the month/year dropdown plus the nav
(`WidgetDescriptor.headerReplacesTitle`; `Calendar` hands its month row
to the `PanelFrame` through the header-actions store), and the gaps in
that row stay the click-to-collapse / drag area. Collapsed, the header
shows "Calendar" and the month as before. The row gains a **Today** icon
button that jumps to the current month and opens today's daily note.

## Consequences

- **Autotag has no surface.** Its only button lived in the drawer. The
  `suggestTags` backend and IPC stay; re-homing it (e.g. an editor `⋯`
  row) is open work. _(Resolved since milestone 45: the `⋯` menu's
  "Suggest tags" row is its new surface, acting on the caret's note
  section.)_
- **The bottom dock has no default resident.** It renders only when the
  user docks a panel or an editor band there. A persisted layout naming
  the `entry` widget drops the id on load (unknown ids already fold out).
- **Quick capture without an open note** is the daily note: the Today
  button (or the quick-capture hotkey, unchanged) opens it, then `/`.
- Icon-only controls trade discoverability for calm; every one keeps a
  tooltip and an accessible name, and e2e selectors moved from button
  text to `aria-label`.
- The mono-uppercase header described in ADR-0019 and `handoff/DESIGN.md`
  is superseded; the handoff prototype no longer matches the shipped
  chrome.
- Plugins written against SDK 1.9 keep working; `ui.icon` and the
  free-text tag field are additive (1.10).
