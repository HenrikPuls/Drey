# 0054 — Opening files from the OS (Explorer association, pinned external tabs)

## Status

Accepted (milestone 36)

## Context

A Markdown file could only be opened through a registered vault's Files
panel (or a drag from inside the vault). Double-clicking a `.md` in the
Windows Explorer — or choosing Drey under "Open with" — did nothing:
the installer registered no file association, and the app read no launch
arguments. The single-instance lock (`second-instance`) only focused the
window.

Two structural facts constrain the fix:

- **Every document is vault-relative.** `Doc.path`, tab keys
  (`vaultId::path`, ADR-0051), save, re-index, tasks, wikilinks and the
  session snapshot all assume a file sits in a registered vault
  (`PaneDropService` records this as the reason out-of-vault drops are not
  opened). A file from `C:\Downloads` has no vault.
- **The renderer must not read arbitrary files** (ADR-0001). An IPC
  channel "read this absolute path" would be exactly that.

## Decision

**Registered types: `.md`, `.markdown`, `.mdx`, `.txt`** — via
electron-builder `fileAssociations` (NSIS, per-user → `HKCU\Software\Classes`;
the portable build registers nothing). The list lives twice on purpose:
`electron-builder.yml` (what Windows offers) and
`shared/external-open.ts` (what main accepts from argv); keep them in step.
PDF / images / code files are deferred.

**Main collects, classifies and gates** (`electron/external-open.ts`):

- `extractOpenPaths(argv, …)` turns a launch's (or `second-instance`'s)
  argv into absolute, existing files with a registered extension.
- `ExternalFileGate` queues them, then classifies each with
  `locateInVaults` (realpath'd, case-insensitive on win32, deepest vault
  wins): **inside a registered vault → an ordinary vault tab**
  (`OpenRequest { kind: 'vault' }`); **anywhere else → an external tab**
  (`{ kind: 'external', path }`).
- **Allowlist.** Only paths main itself collected from the OS join the
  gate's allowlist. `external:read` and `external:write` refuse everything
  else, plus non-registered extensions and content over 50 MB; a write also
  requires the file to still exist (a file deleted behind our back is not
  silently re-created). The renderer can never turn either channel into a
  general file read or write — it can only touch the exact paths the user
  handed to Drey through the OS.

**Delivery is pull once, then push.** At cold start the renderer *pulls*
the queue (`external:take-pending`) after the vault registry, settings and
session restore are done; a push at that moment would fire before the
listener exists, and classification needs the registry. The pull also marks
the gate ready, after which every later launch (`second-instance`) is
classified and *pushed* (`external:open-request`). The startup daily-note
fallback is skipped when the launch opened a file (its async open would
otherwise land last and steal the focus).

**An external tab is editable, saved in place, and pinned.**
`OpenDoc.external`, `vaultId: null`, absolute `path`, key
`external://<path>` (the same `://` convention as `browser://<n>`,
collision-free against `vaultId::path`). It is:

- **edited like any note** and marked "Outside your vaults" in the meta bar;
- **saved in place** — Ctrl+S / Save writes the buffer back to the original
  path through `external:write` (the file's own line endings restored, last
  writer wins like vault notes). None of the vault pipeline runs: no
  frontmatter bump, no index, no save hooks. A refused write (file gone,
  permission) keeps the tab dirty and shows the error; "Save as…" stays
  available and copies the file into the active vault, swapping the tab for
  that copy (pin kept);
- **pinned** (milestone 35) — never the tab another file replaces, and the
  tab context menu offers no unpin;
- **not restored** after a restart (the allowlist lives for one run; the OS
  association reopens it on demand) and left out of the session snapshot —
  so unsaved edits ride only the normal exit prompt, not a session backup.

*Amended in milestone 36:* the first cut made the tab read-only (the owner's
initial call was "must not be overwritten"); the owner then asked for saving
at the original location, which is what a default editor does. The read-only
plumbing (`EditorState.readOnly`, the write refusals) was removed again.

*Amendment (size gate, post-36):* the cap was raised from 10 MB to 50 MB —
CodeMirror renders viewport-windowed and the decoration passes follow
`visibleRanges`, so a large document costs memory, not correctness (the
known whole-document walks — Live Preview block widgets, word count — stay
"fine at note sizes"; a 50 MB file may prefer source mode). The cap itself
stays: it guards against absurd files (multi-GB logs) freezing the renderer.

### Alternatives considered

- **Read-only external tab (+ "Save as…" copies only).** Safest, and the
  first cut — but unlike what a default editor does; replaced once the owner
  asked for in-place saving. The write channel is the same allowlist as the
  read, so it adds no new reach.
- **Offer "Add folder as vault".** Reuses the whole architecture, but turns
  every one-off double-click into a registry mutation and a dialog.
- **Copy the file into the active vault.** Silently duplicates user data.
- **Pure push at cold start.** Races the renderer's startup; queued-then-pull
  is deterministic.

## Consequences

- Windows 10/11 does not let an app claim the default: the installer adds
  Drey to "Open with", and the user picks "Always use this app".
  electron-builder's NSIS macro also writes the class default for each
  extension, so a `.txt` the user never explicitly bound to another program
  (UserChoice) starts opening in Drey. Removing `txt` from
  `fileAssociations` undoes that.
- External docs get no vault features: no tag/task index entries, no
  relative image resolution (vault-scoped), no assistant chat binding (like
  a scratch tab), and saving skips the vault pipeline (no `updated:`
  frontmatter bump, no on-save Actions). Editing, the Tasks panel's Doc
  scope (live buffer) and buffer rewrites work as usual. A file changed on
  disk by another program is not reloaded and would be overwritten by the
  next save (last writer wins, as ever).
- Dragging an out-of-vault file *into the window* is still not supported
  (`PaneDropService`); it could reuse the gate later via
  `webUtils.getPathForFile`.
- Deferred: PDF/image/code associations, restoring external tabs, live
  reload of a changed external file, "Reveal in Explorer" for them, macOS
  `open-file`.
- Dev: `npm run electron -- C:\path\x.md` passes the argument through
  (`scripts/run-electron.js`), exercising the same path as a double-click.
