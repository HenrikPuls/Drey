# 0080 — Fleet worktrees: a visible home in the tickets repo and git-only cleanup

- Status: accepted (2026-10-20, T-0044; owner request, outside the list)
- Builds on: [ADR-0075](0075-agent-fleet-architecture-governance-and-run-control.md) (one worktree per run),
  [ADR-0076](0076-ticket-repository-format-and-coordination.md) (the tickets repo),
  T-0047's `prepareWorktree` state machine

## Context

The fleet's worktrees hid under the machine-local fleet root
(`<userRoot>/fleet/worktrees/<repo>-<ticket>`). The owner could not see
where a ticket's checkout lived without digging through AppData, several
checkouts shared one opaque pile, and there was no supported way to tidy
it up: deleting a registered worktree by hand leaves admin state under
`<repo>/.git/worktrees/`, and a settled ticket's leftover checkout blocks
every re-run with git's "already checked out".

## Decision

- **Home at the tickets repo root.** New worktrees live in
  `<ticketsRepo>/_worktrees/<ticket-id>/` — a sibling of `tickets/`, on
  the repo's own disk, one folder per ticket. `_`-prefixed folders at the
  **vault root only** are reserved: the file tree, the markdown index and
  the opt-in watcher skip them (no refresh storms from agent writes;
  `tickets/_meta` below the root stays indexed). The repo's `.gitignore`
  covers the base — appended by the boot sweep and the board initialize
  whenever missing, one commit (`tickets: ignore the worktrees base`).
  A repo may override its base with a `worktrees:` key in
  `_meta/repos.md` (absolute, or relative to the tickets repo root).
- **Folder name = the bare ticket id.** Ids are minted board-wide and a
  ticket names exactly one repo, so the old `<repo>-` prefix bought
  nothing.
- **The path is computed in `composeRunRequest`** and carried as the
  required `RunRequest.worktreePath`; the runner never derives paths and
  refuses an empty value. The brief's "Work checkout" line names the
  absolute path.
- **Everything through real git, never a bare rmdir.** Per-ticket removal
  (card menu) is `git worktree remove` — a dirty tree refuses unless the
  owner confirms (`--force`), a tree that no longer answers to git is an
  error; the **branch stays** (it carries the work) and the removal is
  logged on the ticket (one commit). The global control ("Clean up
  worktrees" in the panel header) removes every worktree whose ticket has
  no live run, then runs one `git worktree prune` per mapped repo, and
  reports removed / kept-dirty / failed. Cleanup is plugin-side (the
  plugin holds repos.md, the run history and the stamps; cleanup usually
  happens with the runner down) — no new runner HTTP routes.
- **Liveness is the ticket's `run:` stamp ∪ non-terminal fleet records**,
  never fleet status alone: with the runner down, `readHistory` marks a
  still-live run `stopped`, and the stamps are the persisted truth.
- **Boot sweep.** On every plugin boot until the legacy root is empty:
  clean worktrees under the old fleet root are removed automatically
  (live runs keep theirs until they settle), dirty ones stay and are
  reported; orphan folders under the new base are **listed** as
  cleanable, never auto-deleted. No one-shot marker — the empty legacy
  root is the fixpoint.
- **Re-run healing.** `prepareWorktree` removes a *conflicting
  registered checkout* of the same branch before `worktree add` when it
  is provably clean and not live (never `--force`, never a live run's
  tree) — otherwise the dispatcher would skip-and-retry forever. This is
  the runner's one new power; everything else cleans plugin-side.

## Rejected

- `tickets/_worktrees` — breaks the schema's "nothing else lives beside
  the phase folders" rule and drags `_`-skips into board, normalize and
  phase-folder code.
- A cross-process lock between cleanup (plugin) and prepare (runner):
  cleanup skips protected tickets and tolerates per-item failure; a
  colliding start fails loudly and the dispatcher retries.
- Collecting `.stale-*` move-aside folders or run history — out of scope;
  the stale folders are the kept-not-deleted guarantee.

## Consequences

- The `<repo>-<ticket>` name survives only inside the legacy fleet root,
  which the migration empties; an old runner sharing the fleet root
  lands one tree there once and the next boot collects it.
- `RunRequest.worktreePath` is required; a pre-T-0044 sender is refused
  (same-bundle spawning makes the mix rare and transient).
- The reserved-root skip is a new vault-root convention: any feature that
  wants machine state beside the vault's content uses a `_`-prefix at the
  root and is invisible to the board, the index and the watcher.
