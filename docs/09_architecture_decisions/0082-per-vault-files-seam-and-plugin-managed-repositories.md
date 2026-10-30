# 0082 — Per-vault Files operations and plugin-managed repositories

- Status: accepted (2026-10-29, T-0042; owner decisions from the 2026-10-18 rounds)
- Amends: [ADR-0051](0051-multi-vault-registry.md) (the Files panel consults a
  plugin seam before its operations), [ADR-0065](0065-git-vaults-source-control-plugin.md)
  (a plugin-managed vault is read-only in the Source control panel)
- Relates: [ADR-0076](0076-ticket-repository-format-and-coordination.md) (one
  transition is one structured commit — the reason the tickets vault is managed)

## Context

The Files panel operated on every vault the same way: a raw file move is a
file move. But a vault can be **dedicated** — the tickets repository, whose
files, folders and commits are the board's ground state. Letting the tree
create, rename, duplicate or delete there corrupts the board (duplicate ids,
stray stamps); letting the Source control panel stage or commit there
swallows or mixes the structured transition commits (ADR-0076). At the same
time, hiding these vaults from the panels is wrong: the owner wants to SEE
and drag tickets in Files, and see branch, status, log and file history in
Source control.

## Decision

- **One `files` SDK namespace (SDK 1.32), renderer-side.** A plugin
  registers an operations handler and context-menu rows for its vaults
  (`api.files.registerOperations` / `registerContextMenuItems`).
  `FileOperationsService` consults the handler **before any dialog and any
  base-side work** — create, rename, move (drag & drop), copy (paste /
  duplicate) and delete alike. The verdict is `allow` (the base flow),
  `refuse` with a reason (shown in the panel's message dialog, the flow is
  replaced) or `handle` (the plugin performs the operation as a structured
  action). Consultation order is registration order; the first `refuse`
  wins, then the first `handle`. A handled move reports its final path and
  the base re-keys open tabs (`EditorService.retargetTabs`) — a takeover
  must not strand tabs.
- **Why renderer-side and not main.** The operations start renderer-side
  (inline inputs, link planning, confirm dialogs — all of which must be
  skipped for a veto or takeover), and the takeover reuses the plugin's
  existing `backend.invoke` path, so the plugin's single-writer queue stays
  the executor. MCP/assistant vault-tool paths stay unguarded — the board's
  drift normalization remains the backstop there (scope decision).
- **Context rows, not commands.** Palette commands are global; the Files
  rows are tree-scoped — a sync callback re-evaluated per menu open over
  the plugin's cached snapshot, mirroring `editor.registerContextMenuItems`.
- **`plugin-managed` is a main-side, base-owned registry.** A plugin flags
  the vault it structurally manages (`ctx.vault.markManaged`, label =
  manifest name; one claim per plugin, follows the plugin's detection both
  ways; cleared on deactivation and quarantine). The git plugin reads
  `ctx.vault.managedBy` and refuses exactly **stage, discard, commit
  (incl. amend), pull, push** — first statement of each handler, before a
  repository is even located — with "Managed by \<name\>". The vault stays
  fully visible: branch, dirty state, log, file history, decorations.
  Unstage, stash, checkout, fetch and merge stay allowed (the owner's list
  is exact; tightening is follow-up material). Plugins never talk to each
  other — the host is the only broker (ADR-0044 rule).

## The tickets wiring (the first consumer)

- The guard scope is the `tickets/` subtree of the detected tickets vault;
  the rest of that vault (loose notes, `_worktrees/`) stays free. Create /
  rename / delete / copy are refused with educating reasons (capture,
  identity, pipeline, archive); the pure table lives in
  `plugins/tickets/shared/files-guard.ts`.
- **A drag IS a board move**: moving a ticket file between phase folders or
  into `tickets/archive/` is `handle`d and runs the same single-writer
  mutation the board runs — stamp, Log line, pin cleanup, one commit.
  Archiving drags into `tickets/archive/`; a drag out of `tickets/archive/`
  is a new one-commit **unarchive** mutation (`archive -> <phase>`), never
  a raw move plus drift normalization. Rows: "Archive ticket",
  "Unarchive ticket" (to the first phase), "Remove worktree" on
  `_worktrees/<id>` (dormant until T-0044 creates the folder).
- **Sequencing**: the git-repo auto-detection ticket (T-0045) lands AFTER
  this protection, so a scan can never surface a structured repo into the
  panel's unguarded hands.

## Consequences

- The Files panel gains per-vault behaviour without the base knowing any
  plugin; the seam is the SDK, the semantics stay plugin-side.
- Refused menu rows still show (hiding them needs a synchronous menu probe
  — follow-up material); the refusal educates instead.
- Two plugins answering `handle` for one operation is not negotiated: the
  first registrant wins, documented.
- A vault flagged plugin-managed shows a "Managed by \<name\>" banner in
  Source control with the five actions disabled — visible, honest, read-only.
