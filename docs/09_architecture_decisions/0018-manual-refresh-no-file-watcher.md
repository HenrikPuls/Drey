# 18. Manual refresh instead of a file watcher (Variant B)

## Status

Accepted — implemented with the milestone-10 follow-up items.
Amended by [ADR-0045](0045-optional-vault-file-watcher.md): an optional,
off-by-default chokidar watcher on top of this design (req-14), and the
manual refresh button now runs a full round (indexes included).

## Context

`specs/roadmap.md` (Phase 1) specified a **chokidar file watcher** that
distinguishes a frontmatter-only change from a body change from a new
external file, feeds `TagIndex`, and surfaces autosave conflicts with a
"keep mine / take external" prompt.
[ADR-0007](0007-on-save-tag-pipeline.md) already recorded "no file
watcher yet". Two things then changed the calculus:

- With [ADR-0017](0017-tags-as-labels-and-section-index.md), frontmatter
  is thin and app-managed — there is **no "frontmatter-only change"
  category left to detect**, which was the watcher's main justification.
- The tag system is now an in-memory index rebuilt from a plain scan, so
  "reflect what is on disk" is a single operation.

Weighed against that, a watcher is strictly more moving parts: an
ignore-window per write path (so the app's own writes don't echo back), a
debounce, and a start/stop lifecycle tied to the active vault — the
error-prone part.

## Decision

No watcher. `VaultService.refresh()` re-reads the file tree and triggers
`TagIndex.rebuild()`. It runs:

- from a **sidebar refresh button** (new `refresh-cw` icon), and
- automatically after the writes the app itself makes — a note save, the
  first save of a daily-note draft, and file/folder create or delete.

## Consequences

- An external tool changing vault files is not noticed until the next
  manual refresh. Accepted for a single-user, single-machine tool
  (`specs/roadmap.md` "Open Risks", `docs/11`).
- Nothing to build or maintain for ignore-windows, debouncing or watcher
  lifecycle.
- The autosave-vs-external-edit conflict UX that
  [ADR-0003](0003-multi-document-editor-tab-model.md) and earlier `save()`
  notes deferred is deferred further — there is no autosave, saves are
  explicit, and a stale open tab is reloaded on the next save or reopen.
- Variant B does not preclude a watcher later: chokidar would be a purely
  additive layer calling the same `refresh()` / `rebuild()`.
