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

## Later change — per-vault index + the all-vaults scope (milestones 33/34)

Multi-vault (ADR-0051) turned the single index into a liability: it
mirrored whichever vault was active at boot, and a save landing before
that lookup resolved (or in any *other* vault) was silently dropped.
The tasks plugin now mirrors the tags plugin's milestone-33 shape: one
`TaskIndex` map per registered vault (per-vault rebuild coalescing, the
boot-race vault guard deleted), every `TaskRecord` stamped with its
`vaultId`, and the panel's scope switch grew from
Doc | Vault to **Doc | Vault | All**. Vault scope filters the
main-side list to the registry's active vault at pull time; the All
scope groups per file with a vault-name badge. Toggles and row clicks
carry the vault (`vault.writeFile { vaultId }` for closed files; open
tabs resolve by bare path as the Search panel does), and the
unsaved-buffer fold keys on `(vaultId, path)` so the same relative path
in two vaults cannot clobber rows. This closed the last item of
milestone 28's announced M-B follow-up.

## Later change — inline metadata: due date + priority (req-37, milestone 51)

Task lines can now carry an **Obsidian-Tasks-compatible due date**
(`📅 YYYY-MM-DD`) and **priority glyph** (`🔺` highest, `⏫` high, `🔽`
low; absent = normal) anywhere on the line. This is deliberately not a
`#task/id:`-style machine token: the emojis are human-legible
annotations with an established ecosystem meaning, the vault stays
readable/writable by Obsidian's Tasks plugin, and the scanner
(`plugins/tasks/shared/tasks.ts`) strips them from the task text — so
the text+kind matching of `resolveTaskLine` is unaffected by metadata
edits (the hazard the id scheme tried to fix never even arises). The
scanner exposes `due` / `priority` on `TaskRecord`, pure
`setDueOnLine` / `setPriorityOnLine` setters write the tokens back
(append-or-replace, guarded to task lines), the panel sorts by both
and shows badges, and a plugin completion source with a native
date-picker popover authors them in the editor. See
`specs/frontmatter-schema.md` for the line format.

## Later change — the completion date (milestone 57d)

"Which tasks were completed recently" was unanswerable: a done task
carried no date (`[x]` has none, and the meeting import's `done:` date
was parsed but discarded). Task lines now carry Obsidian Tasks' done
date `✅ YYYY-MM-DD`, exposed as `TaskRecord.completed`.

This is the first task token the app **writes on its own** — due and
priority are only ever written through an explicit picker. The
trade-off was accepted deliberately (owner decision): an exact
completion date needs a write at the moment of completion, and the
alternative (approximating by the note's date or mtime) reports a task
ticked today in an old note as old. Same reasoning as the due/priority
tokens otherwise — a human-legible, ecosystem-compatible annotation,
stripped from the task text so `resolveTaskLine` is unaffected.

- `setDoneOnLine` stamps `✅ today` on completion and removes it on
  reopen; a line already in the requested state is left untouched, so a
  legacy done task never gains a date it did not earn.
- The editor's own toggles (`Ctrl+Enter`, the base Live Preview checkbox
  click) flip the box directly; a tasks-plugin transaction filter keyed
  on their `input.toggleTask` user event appends the same stamp to the
  same transaction (one undo step). The base editor stays grammar-free.
  A `[x]` typed by hand gets no date.
- Legacy fallback, read-only: `completionKey` falls back to the first
  `YYYY-MM-DD` in the note's file name. File mtime was considered and
  dropped — the index holds no stat data, and any unrelated save would
  make every old task in the note "recent".
- The provider gained the matching view (SDK 1.13): `status`
  (`open` | `done` | `all`), `completedSince` and the `completed` sort
  (newest first, undated last). See ADR-0058's 57d note.

## Considered and rejected — stable `#task/id:` addressing (req-35, milestone 44)

The roadmap's "Task Center" item named a real hazard: a panel tick
resolved against a *recorded* line can mis-route when lines shifted.
Investigation showed the design already re-scans fresh content at tick
time (`resolveTaskLine`) and matches by text+kind, so plain line drift
was never the issue — only duplicate task texts under a shift are, and
in a single-user vault that window is negligible.

The implemented fix — `#task/id:<id>` attributes minted into task lines
on their first panel tick — was **reverted before release**: the token
is permanent noise in plain Markdown (source mode, exports, every other
tool reading the vault), adoption is inherently partial (editor
checkboxes and external editors never mint), and the guarded case
barely occurs. What survived is a hardening of the resolution itself:
`resolveTaskLine` follows a *unique* task across any shift, and when
duplicate texts leave the recorded line ambiguous it returns `null` —
the toggle skips (safe no-op) instead of ticking the nearest twin.
An id-style addressing scheme stays open for a genuine multi-writer
future, but not at the cost of machine tokens in single-user notes.
