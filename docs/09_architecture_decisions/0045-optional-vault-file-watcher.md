# 45. Optional vault file watcher (additive to manual refresh)

## Status

Accepted — amends [ADR-0018](0018-manual-refresh-no-file-watcher.md)
(manual refresh stays the default; the watcher is the opt-in additive
layer that ADR-0018 explicitly left open).

## Context

ADR-0018 chose manual refresh over a file watcher: with thin
app-managed frontmatter there was no "frontmatter-only change" category
left to detect, the indexes are rebuilt from a plain scan, and a watcher
meant three more moving parts (an ignore-window per write path, a
debounce, a start/stop lifecycle). req-14 kept the watcher on the
backlog "if manual refresh proves too coarse".

It did prove too coarse, in two independent ways:

- **External edits go unnoticed.** The vault lives on OneDrive; changes
  synced from another machine (or made in another editor) stay invisible
  in the file tree, the tag/task indexes, and — worst — in open editor
  tabs, until a manual click.
- **The manual refresh itself was only a half refresh.** The Files
  panel's refresh button re-pulled the renderer's file tree but never
  emitted a vault-change event, so the tag/task indexes were *already*
  stale after clicking it. (`vault:select` did rebuild; only the button
  had the gap.) Fixing that fell out of this work.

Two deliberate hooks were already in place: `OpenDoc.modifiedMs` was
round-tripped through `vault:read-file` "for the future file watcher",
and both index plugins implemented (dead) `delete`-kind branches in
their vault-change listeners.

## Decision

An **opt-in** chokidar watcher (`vault.watch`, Settings → Vault, off by
default) that funnels into the same machinery a refresh uses — plus the
fix that makes the refresh button a real refresh:

1. **One external-change round** (`VaultChangeAnnouncer`), shared by
   every change source — watcher batch, manual refresh, MCP write:
   per-file plugin vault-change events (`write`/`delete` with path) for
   `.md` files, then one `vault:changed` push to the renderer carrying
   the changed paths (capped at 200; over the cap the payload omits
   `paths` and consumers treat it as a full refresh).
2. **The push channel is renamed and generalized**: `mcp:vault-changed`
   (MCP-only, payload-less) becomes `vault:changed` with a
   `{ paths?: string[] }` payload. Tree, plugin panels and the editor
   all consume the same push.
3. **Self-write echo suppression** (`OwnWriteLedger`): every mutating
   `VaultManager` method records itself. Content writes record the
   post-write `mtimeMs` — a watcher event whose stat mtime matches
   (±2 ms) is the app's own echo, dropped no matter how late it arrives.
   Structural ops (create/delete/rename/copy/asset) record the path with
   a short TTL, matched exactly or as a directory prefix. **A missed
   suppression costs one redundant refresh round, never corruption** —
   ambiguity always resolves towards "external event".
4. **Watcher hygiene** (`VaultWatcher`): chokidar v3 (CJS — the main
   process compiles to CommonJS; v5 is ESM-only), `ignoreInitial` +
   a `ready` gate (no initial-scan storm), dot-entries ignored (same
   exclusions as the file tree and the indexes: `.git`, `.drafts/`,
   `.chat.json` sidecars), `awaitWriteFinish` 500 ms (never index half a
   OneDrive sync), and a ~300 ms trailing debounce so a sync burst is
   one round.
5. **Clean tabs auto-reload; dirty tabs are untouched.** On a scoped
   push, `EditorService` re-reads every open text tab in `paths` whose
   buffer is still clean (the existing same-path in-place reload picks
   it up). A file that no longer exists flips its tab to draft
   semantics — the tab stays, and a later edit + save resurrects the
   file. A dirty tab keeps its buffer: last-writer-wins on save stays.
   The ADR-0003 conflict dialog ("keep mine / take external") remains
   unbuilt — deliberate scope cut, not an oversight.
6. **The manual refresh button** invokes a new `vault:refresh` round in
   main (full index rebuild + push) instead of the renderer-only tree
   pull. Works whether or not the watcher is on.

Lifecycle: started/stopped from the stored config (`config:set` →
`syncVaultWatcher`, the `syncMcpHttp` pattern), restarted on
`vault:select`, stopped on quit. A watcher `error` (vanished vault
root) logs a warning and stops; the next lifecycle event re-arms.

## Consequences

- With the watcher on, external changes surface on their own: the tree
  and indexes update, clean open tabs reload. With it off, nothing
  changes except the refresh button, which now also rebuilds the
  indexes.
- `DailyNoteManager` still writes the quick-capture daily note with raw
  `fsp.writeFile`, outside `VaultManager` — deliberately: its echo is
  *not* suppressed, so with the watcher on the new daily note shows up
  in the tree on its own (this fixes the old quick-capture staleness
  gap for free). With the watcher off, that gap remains as before.
- chokidar is a runtime `dependencies` entry (it must ship in the
  packaged app); v3 is frozen upstream but battle-tested and CJS.
- Sidecar pruning on external delete (docs/11) is still not implemented,
  but the `delete`-kind event the watcher emits is the hook it will use.
- The deferred conflict UX stays deferred: a dirty tab and an external
  edit still resolve by last-writer-wins, silently.

## Later change — multiple vaults

[ADR-0051](0051-multi-vault-registry.md) generalizes the watcher from
"the active vault" to **every registered vault**: one chokidar instance
per registration, reconciled by `syncFromConfig` (start missing, stop
removed, keep untouched — no restart churn on unrelated registry edits),
a shared debounce, and per-vault announce batches stamped with the
vault id. The own-write ledger's keys became `vaultId:path`, so a write
in one vault can never suppress another vault's echo.
