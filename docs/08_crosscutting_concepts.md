# 8. Crosscutting Concepts

*(Placeholder — filled in as concrete cross-cutting decisions get made,
e.g. error handling/logging conventions, the IPC message/type conventions,
autosave-vs-watcher conflict handling. Tracked as an open risk in
[11_risks_and_technical_debt.md](11_risks_and_technical_debt.md) until
resolved.)*

## IPC typing convention (established in milestone 1)

Every data shape crossing the `contextBridge` boundary is defined once as
a TypeScript interface in a shared module (`shared/`), imported by both
the main process (implementation) and the renderer (consumer) — no
untyped `any` payloads across IPC. See
[05_building_block_view.md](05_building_block_view.md).

## Crash-safe file writes

`electron/safe-file.ts` is the one place that decides how the main
process replaces a file it must not lose.

- **Atomic replace.** `atomicWriteFile` / `atomicWriteFileSync` write the
  new content to a temp file beside the target, flush it, and rename it
  over the target. A crash, a power cut or a sync client (OneDrive)
  reading mid-write sees the old file or the new one, never a cut-off
  one. The temp name is `.<name>.<random>.tmp` — a dot-entry, so the file
  tree, the indexes and the vault watcher skip it. Used by
  `VaultManager.writeFile` / `writeBinaryFile` (every note write goes
  through the first), `app-config.json`, `vault-config.json`, the note
  history's index files and the session backups.
- **It never makes a save fail that used to work.** A rename blocked for
  a moment (virus scanner, sync client) is retried; if it stays blocked,
  or the temp file cannot be created, the write falls back to the plain
  in-place write. A read-only target is written in place directly, so
  the user still gets the error they got before. A linked note is
  written through the link.
- **Not covered, on purpose:** external tabs (`external:write`) keep the
  in-place write — a file outside the vault keeps its identity
  (hard links, its own permissions). Files that are only ever created,
  not replaced (a new daily note, a pasted asset), have nothing to lose.
- **An unusable config file is set aside, not overwritten.**
  `readJsonObjectGuarded` tells a missing file (first run) from one that
  exists but cannot be used (empty, cut off, not JSON). The latter is
  moved to `<name>.corrupt-<timestamp>` next to it and the app starts on
  defaults for that file; after the main window is shown, main names the
  file and the kept copy in one dialog. Applies to `app-config.json` and
  `vault-config.json`. Plugin config files keep the older "corrupt means
  empty" stance.

## Uncaught errors in the main process

Listening for `uncaughtException` (to log it, ADR-0032) switches off
Electron's own error dialog. `main.ts` therefore shows one itself, once
per session: what happened, where the log is, and *Quit Drey* / *Keep
running*. Quitting takes the ordinary exit path, so unsaved documents
are still asked about. `unhandledRejection` is logged only.
