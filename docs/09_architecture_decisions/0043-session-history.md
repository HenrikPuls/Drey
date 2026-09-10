# 0043 — Session history (layout + open-tab restore)

## Status

Accepted

## Context

The project owner asked for the app to relaunch into the *exact* state it
was left in: the same pane split tree, the same tabs in the same panes,
the same active tab and focused pane — and for tabs that were never saved
anywhere to keep their text across a restart, the way Notepad++ does.

The dock layout already persists (`localStorage['drey.dock']`), but the
editor pane layout deliberately did **not** (ADR-0037: "there is no
open-tab restore across a restart today, so a restored layout with no tabs
would just be empty panes"). `EditorService.docs` is likewise in-memory
only.

## Decision

Add a `SessionService` (`src/app/session/`) that persists and restores the
editor session, and lift `PaneService`'s "not persisted" restriction.

### What is stored where

- **Layout + tab list** → `localStorage['drey.session']`, one
  `SessionSnapshot` (`version`, `savedAt`, `vault`, `layout`, `tabs`). This
  is small per-machine window state, same class as the dock layout.
  `layout` is `PaneService.snapshot()` (the split tree + each pane's tab
  strip + the focused id). Each `tabs` entry is `{ path, kind }` plus, for
  a browser tab, its last `url`, and for a text tab, `onDisk` and an
  optional `backupId`.
- **Unsaved buffer text** → a main-process store,
  `<userData>/session-backups/<uuid>.txt`, one file per backup id
  (`electron/session/SessionBackupStore`, IPC `session:*`). Buffer text can
  be large and must never be lost, so it gets a real file, not
  localStorage. A backup exists only for a text tab with nothing on disk to
  reload from: a never-saved scratch buffer, or unsaved edits to a real
  file.

### Persistence

`SessionService` runs **one** effect subscribed to `EditorService.openDocs()`
and `PaneService.snapshot()`. It no-ops until `restore()` has finished, then
on any change it debounces a layout write (400 ms) and a backup write
(700 ms). `beforeunload` flushes the layout synchronously; a
`visibilitychange` to `hidden` flushes both. A hard kill can lose up to
~700 ms of edits to an unsaved buffer — the Notepad++ bar.

Backup files are reference-counted against the live tabs: when a tab is
saved or closed its backup is deleted, and on startup any backup not
referenced by the restored session is pruned.

### Restore

`App` calls `session.restore()` once, after the vault path and config are
known and **before** the "open today's daily note" fallback. If it
restored at least one tab, that fallback is skipped (the layout is "exactly
as left"). The snapshot records the vault it belongs to; restore is
skipped when the active vault differs.

Per tab kind:

- **browser** → `BrowserViewService.restoreTab(tabId, url)` re-creates the
  view under the *same* `browser://<n>` key the layout references.
- **image** / **on-disk text (clean)** → `EditorService.openFile(path)`.
- **on-disk text with unsaved edits** → `openFile(path)` then
  `updateBuffer(path, <backup>)` re-applies the edits over the fresh disk
  content.
- **never-saved scratch** → `openScratch(path, <backup>)`; if the backup is
  gone the tab is dropped.

`PaneService.restore(snapshot, keepPath)` then rebuilds the tree: a tab
whose path did not restore is removed, a pane left empty is pruned
(`removeLeaf`), and `nextPaneNum` / `nextSplitNum` are advanced past the
restored ids so later splits don't collide. It returns `false` (and leaves
the fresh single-pane default) when nothing survives.

## Consequences

- **`PaneService` is now persisted** — the ADR-0037 note is superseded.
  `snapshot()` / `restore()` are the only additions; the mutation methods
  are untouched.
- **Per vault.** Switching vaults and relaunching does not drag the other
  vault's tabs in.
- **A corrupt `drey.session` never blocks startup** — parse failures fall
  through to the empty default.
- **Backup store growth** is bounded by the number of unsaved tabs and
  self-cleans; a crash mid-session can leave a few orphan `.txt` files,
  removed on the next launch.
- **Interaction with req-25** (a future "always autosave named files"):
  once real files autosave, the only tabs still needing a backup are truly
  pathless buffers, shrinking this store further. No conflict — the backup
  path already only triggers on `!existsOnDisk || dirty`.
- New feature modules `electron/session/` + `src/app/session/` (ADR-0016
  barrels, registered in `eslint.config.mjs`).
