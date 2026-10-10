# 60. Save conflicts are asked, and every overwrite leaves a local version

## Status

Accepted (milestone 60). Closes the conflict UX that ADR-0003, ADR-0018
and ADR-0045 (decision 5) each deferred; supplies the safety net ADR-0059
named as missing. Builds on ADR-0010 (app data lives outside the vault)
and ADR-0011 (the diff the dialogs show).

## Context

Two gaps, one cause — the app overwrote note text without a trace:

- **A dirty tab won silently.** A note changed on disk (another device
  through the sync folder, another program, the quick-capture hotkey)
  while its tab held unsaved edits was simply overwritten by the next
  save. On a synced vault that loses data, and the watcher being off (the
  default) made it invisible as well.
- **No net under unconfirmed writers.** Live edit, the assistant's
  template tools, MCP in YOLO mode, replace-all, the tag rename and the
  link update all rewrite notes; the only undo was the editor's own
  history of an open tab.

Questions with real alternatives: where a conflict is detected, where
earlier versions live, which writes produce one, and how the user reaches
them.

## Decision

**1 · The conflict is detected at save time, in main.** `note:save`
carries `baseModifiedMs` — the file's mtime as the tab last read or wrote
it (`0` for a draft: "there is no file yet"). `NoteManager` compares it
with the file on disk; on a mismatch it writes **nothing** and returns
the disk text as `NoteSaveResult.conflict`. This works with the watcher
off, which is the default and exactly the case that used to lose data.

The renderer then separates noise from conflict: if the disk text equals
what the tab last read, only the timestamp moved (a sync client touching
the file) and the save is repeated with `force`, without a question.
Otherwise `ConflictDialog` opens as a **merge view** — three aligned
columns, *On disk* | *Result* | *Your version*, one row per block
(`src/app/conflict/merge-model.ts`, a line diff of the two versions cut
into shared runs and differing blocks). Each differing block has a
checkbox per side: one side, both (disk's lines, then mine) or neither;
"Take all" in a column head sets every block. The Result column is
editable everywhere, shared runs included — typing in a block replaces
what the checkboxes put there, and ticking a checkbox again discards the
typing of that block only. The dialog answers with the resulting text:
equal to the disk version it reloads the tab, anything else becomes the
buffer and is written. Cancel leaves the tab dirty; raised by "Save all"
on quit, it also aborts the quit (the existing "a document is still
dirty" rule).

What the tab last read (`savedContent`) serves as the base, but only for
the **preselection**: a block one side left as it was in the base is
taken from the other side; a block both changed is flagged and starts on
"mine". That is a hint the user sees and can flip, not an automatic
three-way merge.

**2 · With the watcher on, the tab says so early.** The watcher round
marks a dirty tab whose file changed (`OpenDoc.diskChanged`) instead of
ignoring it; the meta bar shows a **Changed on disk** button that opens
the same dialog without saving. Chat notes keep following the disk
(ADR-0048) and auto-saved paths send no base at all.

**3 · Earlier versions live under the user-data dir, not in the vault.**
`NoteHistoryStore` keeps them in `<userData>/history/<vaultId>/`: an
`index.json` (vault path → random folder id) and per note a folder with
`entries.json` + one `.md` per version. Nothing syncs, nothing shows up
in the vault, and the history cannot itself become a sync conflict.

**4 · One choke point records them.** `VaultManager.writeFile` hands the
store the text a write is about to replace — every writer passes through
it, so no writer has to remember. Each write names its `origin` (`save`,
`assistant`, `mcp`, `links`, `conflict`, `app`, or a plugin id). The
user's own saves are **throttled** to one version per note per five
minutes; everything else is recorded each time. Three versions exist
only in the renderer and are sent explicitly (`history:capture`): the
buffer a conflict resolution or a restore replaces, and the previous
text of a clean tab the watcher reloads. After a conflict both original
versions are in the history, whatever the result was.

Not versioned: chat notes and `.drafts/` (auto-saved), non-note files,
notes over 2 MB, text identical to the newest version. Bounds:
`vault.history` — `enabled` (default on), `keepDays` (30), `maxPerFile`
(50); pruned on every capture and once per start. A rename or move keeps
the history attached (`VaultManager.renameEntry` → `rename`, folders by
prefix, across vaults too). A failing store never fails a write.

**5 · Reached through a dialog, restored into the editor.** "File
history…" (editor `⋯` menu, tab context menu, command palette) lists the
versions with their origin and shows the selected one against the current
buffer. **Restore** replaces the buffer — one undo step, nothing written
until the user saves, and that save records the state it replaces.

**6 · One diff component.** The line diff moved out of the ADR-0011
dialog into `DiffView` (`src/app/diff-view/`), shared by the confirmation,
the conflict and the history dialog.

## Consequences

- A save can now be refused. Callers of `EditorService.save` already
  treat "still dirty afterwards" as "not saved"; nothing else needed to
  change.
- Every overwrite of a note costs one extra read of the old file and, at
  most, one small file under the user-data dir.
- The quick-capture hotkey writing into a daily note that is open and
  dirty now raises the dialog instead of losing the captured entry.
- The history is per machine and deliberately so. It is not a backup: it
  is gone with the user-data dir and bounded in time and count.
- Not covered: external tabs (`external://`, their own write channel);
  a file changed while the app was closed under a tab restored with
  unsaved edits (the restore reads the disk fresh — its text is recorded
  by the next save, but no question is asked); browsing the history of a
  deleted note (the versions stay until they expire, without a UI);
  attachments.
- The merge is manual and line-based: blocks are chosen or rewritten by
  hand, nothing is merged automatically, and there is no in-line
  (word-level) highlighting inside a block.

## Considered and rejected

- **Detect conflicts only through the watcher** — the watcher is opt-in
  and off by default; the default setup would have kept losing data.
- **History inside the vault (`.drey/history/`)** — travels to other
  devices, but multiplies the sync volume and lets the sync client
  conflict the history itself.
- **Git as the history** — a dependency and a `.git` folder in a vault
  that is meant to stay a plain folder on a sync drive.
- **A version on every save, unthrottled** — a Ctrl+S habit would push
  the meaningful versions out of a bounded list within minutes.
- **A two-way "keep mine / use disk version" question only** — the
  first cut of this milestone. Either answer throws one side's work away
  when both changed different parts of a note, which is the common case
  on a synced vault.
- **CodeMirror's merge extension for the dialog** — a second editor
  stack inside a modal, for a view that needs checkboxes per block and
  "both" as a first-class answer, which that extension does not offer.
- **A History dock panel** — permanent chrome for a rarely needed
  function; a dialog reached from three places is enough.
