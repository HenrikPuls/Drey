# 33. Tasks panel + a whole-vault task index

## Status

Accepted. Pulls the roadmap's Phase-2 "Daily tasks" / Phase-4 "Task
center" ideas forward into Phase 1 (the same move images made from Phase 3,
[ADR-0024](0024-binary-vault-asset-write.md)) -- a deliberate scope
deviation, at the project owner's request.

## Context

The editor already renders `- [ ]` / `- [x]` list items as checkboxes
(`live-preview/conceal.ts` `CheckboxWidget`), but there was no way to see
every task in a note, let alone across the vault. The owner asked for a
dock panel that lists tasks for the open document **or** the whole vault,
with a "show open only" toggle, and wanted a task to be tickable from the
panel *and* clickable to jump to its line.

Two shaping questions:

- **What is a task?** The owner asked for it to be configurable:
  GFM checkbox items, lines carrying the reserved `#task` marker
  (`shared/tags/tags.ts` -- `#task` and its `#task/*` subtree are
  structural, never ordinary tags), or both.
- **Where does the whole-vault list come from?** Scanning every `.md` on
  each panel refresh is the same problem `TagIndex` already solves (no
  file watcher, incremental re-index on save -- ADR-0018).

## Decision

**A `shared/tasks` pure module, an `electron/tasks/TaskIndex` mirroring
`TagIndex`, a `tasks:list` IPC channel, and a `TaskService` + `TasksPanel`
in `src/app/tasks`.**

- `shared/tasks/tasks.ts` (Vitest-covered):
  - `scanTasks(path, content)` -> `TaskRecord[]` (`path`, 1-based `line`,
    `text`, `done`, `kind: 'checkbox' | 'tag'`, nearest `heading`).
    Fenced code blocks are skipped. A line that is **both** a checkbox and
    `#task` is reported once as `kind: 'checkbox'`, `done` from the box.
    It always emits both kinds -- the *renderer* filters -- so the index
    never rebuilds when the user changes which kinds they want shown.
  - A `#task` line with no checkbox is **done** when it also carries
    `#task/done`. New micro-convention, consistent with "the `#task/*`
    subtree is structural": it stays out of the tag vocabulary, unlike a
    bare `#done` would.
  - `setDoneOnLine(content, line, done)` -- flips `[ ]` <-> `[x]`, or
    appends / strips a trailing ` #task/done`; returns `content` unchanged
    when the line is not a task.
- `electron/tasks/TaskIndex` -- a near-copy of `electron/tags/TagIndex`:
  same `templates/` + configured-templates-folder exclusion, `daily/`
  included, full `rebuild()` on vault open / manual refresh, `reindexFile`
  on `note:save` (wired in `NoteManager` beside the tag re-index),
  `removeFile` on delete, and `rebuild()` on rename / copy / duplicate /
  templates-dir change. Backs `tasks:list`.
- Renderer `TaskService` holds `scope` (`'document' | 'vault'`),
  `hideDone` and `kinds` (all persisted to `localStorage['drey.tasks']`).
  `visible` is a computed:
  - **document** scope scans the **live editor buffer**
    (`scanTasks(openPath, bufferContent)`), so an unsaved edit -- and a
    checkbox ticked in the editor itself -- shows immediately;
  - **vault** scope reads `listTasks()`, refreshed on construction, after
    each save (an `effect` on `EditorService.savedContent`), and on
    `mcp:vault-changed`.
- Ticking a task calls `EditorService.setTaskDone(path, line, done)`: if
  the file is an open text tab the edit goes through that buffer (activating
  the tab if needed) and is saved like any edit, so an unsaved change is
  never lost; otherwise the file is read, patched with `setDoneOnLine` and
  written straight back through `note:save`.
- `TasksPanel` registers in the dock (`PanelId` `'tasks'`,
  `PANEL_COMPONENTS`, default: left dock after Search, collapsed). Rows
  group by file in vault scope; the row checkbox toggles done, the row body
  opens the file at the line (`EditorService.openFileAt`, same as a search
  hit).

### Alternatives considered

- **A dedicated `tasks:set-done` write channel.** Rejected -- `note:save`
  already writes and re-indexes; a second write path would duplicate the
  frontmatter / on-save-action handling.
- **Rebuilding the index when the kind filter changes.** Rejected -- the
  index carries `kind` per record and the renderer filters, so the filter
  is instant and the index is config-independent.
- **`#done` as the tag-task completion marker.** Rejected -- it would
  become an ordinary searchable tag and pollute the vocabulary; `#task/done`
  is already covered by the reserved `#task/*` rule.
- **Scan the whole vault in the renderer per refresh.** Rejected for the
  same reasons `TagIndex` exists.

## Consequences

- A third feature module trio (`shared/tasks`, `electron/tasks`,
  `src/app/tasks`), each behind an `index.ts` barrel enforced by
  `eslint.config.mjs` (`MODULES` gains `'tasks'`).
- Like the tag index, an **external** edit to a vault file is not reflected
  in vault-scope task counts until the next vault open / structural op
  (no file watcher, ADR-0018). Document scope is always live.
- `NoteManager` now takes a `TaskIndex` (constructor arg added; one
  call-site in `electron/main.ts`).
- The `#task/done` convention is new surface area in `specs/` --
  `classifier-spec.md` / `frontmatter-schema.md` mention `#task` only as a
  marker; this ADR is the reference for completion.
