# 3. Multi-document `EditorService` and the tab model

## Status

Accepted — implemented in the "visual shell" milestone (rebuild of the
design prototype).

**Amended (milestone 32):** opening a file now closes the focused pane's
*clean* active tab, so following documents replaces the view instead of
accumulating tabs. A dirty focused tab stays and the new file opens
alongside; registered plugin doc kinds and the already-open reveal path
are excluded (their state is not behind the file), and internal flows
(session restore, `saveAs`, the Files panel's multi-select open) pass
`keepFocused` to opt out. See `EditorService.openFile` / `openDailyNote`.

## Context

Milestone 3 built the editor as strictly one document at a time:
`EditorService` held a single `openPath` / `savedContent` / `bufferContent`
triple, and opening another file replaced it (prompting via `confirm()` if
the buffer was dirty). That was a deliberate "build it when it has more
than one thing to hold" call — see
[05_building_block_view.md](../05_building_block_view.md) §5.5.

The design prototype (`Notizen Desktop.dc.html`) and CLAUDE.md's "UI/UX
Design" both put a **tab bar** across the top of the main area, with a
close affordance per tab and a dirty indicator. CLAUDE.md's build order,
item 5, is explicit: "x to close tab, only prompts to save if program is
closed, not by switching editors". Rebuilding the prototype's shell
therefore needs more than one live buffer.

Two shapes were considered:

1. **One `EditorService` holding an array of open documents**, each with
   its own saved/buffer content, view mode, EOL and dirty state; one
   `activePath`. The `Editor` component keeps a single CodeMirror
   `EditorView` and swaps its document when the active tab changes.
2. **One `EditorService` instance per open document**, created/destroyed
   as tabs open and close, plus a separate registry service tracking the
   list and the active one. The `Editor` component keeps N `EditorView`s
   (one per tab), showing the active one.

## Decision

Option 1. `EditorService` now owns `openDocs: OpenDoc[]` and
`activePath: string | null`. The historical accessors (`openPath`,
`savedContent`, `bufferContent`, `viewMode`, `isDirty`) are kept as
computed signals over the active document, so `App`, `Sidebar` and
`DailyNoteService` did not have to change.

- **Switching tabs never prompts.** Unsaved buffers stay in memory. Only
  `closeTab()` on a dirty tab asks (`confirm()`), matching the build-order
  note; the program-close prompt is a later concern (needs the same
  file-watcher-driven conflict UX that `save()` is still waiting on).
- **The `Editor` component keeps one `EditorView`** and swaps its document
  in `loadActiveDoc()` on an `activePath` change. Trade-off: CodeMirror's
  per-document undo history does not survive a tab switch. Accepted for
  now; mounting N views is the fallback if it proves annoying in use.
- **Draft (unsaved) documents.** Clicking a calendar day opens that day's
  daily note. If the file exists it opens normally; if not, `EditorService`
  opens a draft `OpenDoc` (`existsOnDisk: false`) whose `savedContent` is
  the substituted `templates/daily.md` (fetched via the new
  `daily:build-content` IPC channel, which writes nothing). An untouched
  draft is not dirty, so `save()` skips it — clicking around the calendar
  never creates empty files. The first real edit makes it dirty; the first
  `save()` writes `daily/<date>.md` (with `VaultManager.writeFile` now
  `mkdir`-ing `daily/` first) and flips `existsOnDisk`.

## Consequences

- One place still owns all document state; the tab bar and open-windows
  list are thin views over `openDocs`. No new registry service, no
  per-tab service lifecycle to manage.
- The single-`EditorView` swap means undo history is per session-at-a-tab,
  not per document. Documented in the `Editor` class comment.
- `EditorService` grew a draft concept (`existsOnDisk`, `activeIsDraft`).
  This is the first document state that is legitimately "open but not on
  disk"; the file watcher work will need to keep drafts out of its
  reconciliation.
- New IPC surface: `daily:build-content` (renderer → main), returning the
  substituted daily-note template for a given date without side effects.
  `DailyNoteManager` gained `noteContentFor(dateStr)` and a non-scaffolding
  `readTemplate()` alongside the existing `ensureTodayNote()`.
- The milestone-3 statement "one open document, no tab bar" in
  §5.5 is now superseded; §5.7 records the new shape.

## Addendum (milestone 11.8–11.9): scratch tabs and Save-as

The draft concept above (a daily note not yet on disk) generalised into
two more cases:

- **`EditorService.openScratch(path, content)`** — opens (or replaces) an
  `existsOnDisk: false` tab holding arbitrary text. Used by the tag
  search panel's **Export** button
  ([ADR-0017](0017-tags-as-labels-and-section-index.md)) for
  `search-results.md`. Its `savedContent` is set to `''` so the tab is
  **dirty from the start** — the chrome Save button (disabled while not
  dirty) is live without a throwaway edit — and it carries
  `askOnSave: true`.
- **`EditorService.saveAs()`** — `VaultManager.pickSavePath(name)` shows a
  native save dialog rooted at the vault, forces a `.md` extension, and
  **rejects a target outside the vault** ("The file must be saved inside
  the current vault."). On confirm it writes via `note:save`, re-keys the
  tab to the chosen path and refreshes the tree + tag index. `save()` on
  an `askOnSave` doc routes to `saveAs()` before its not-dirty return, so
  the first `Ctrl+S` on an export prompts for a location. `Ctrl+Shift+S`
  and the `⋯` menu's "Save as…" reach it for any document.

Daily-note drafts are unchanged — they still save silently to their
`daily/<year>/<month>/` path, `askOnSave` is not set on them.

## Later change — image tabs (`kind: 'image'`, ADR-0026)

`OpenDoc` gained `kind: 'text' | 'image'`. `EditorService.openFile` routes
a path whose extension `imageExtension()` recognises to `makeImageDoc`
instead of `readVaultFile` + `makeDoc`: an image tab holds **no buffer**
(`savedContent === bufferContent === ''`, so `isDirty` is always false and
the close prompt never fires), and `save` / `saveAs` / `setViewMode` /
`updateBuffer` early-return on it. It is otherwise an ordinary tab — the
tab bar, the open-windows panel, dedupe-on-reopen, the Files-tree active
highlight and `closeTabsUnder` (folder delete) all treat it like any
other. The centre column renders `<app-image-tab>` instead of
`<app-editor>` when `editor.activeKind() === 'image'`. Still no
cross-restart persistence.
