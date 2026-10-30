# 0085 — Multi-repo tickets and named projects

Status: Accepted (req-72, owner request 2026-10-30 — not yet manually verified)

## Context

A ticket worked exactly one repository: `repo:` named a `repos.md`
entry, the fleet prepared one worktree, the gate ran there, and the
whole chain (request, runner, removal, UI) was single-repo by
construction. Real steps sometimes span two repos — a Drey change and
its consumer, a schema and its migration — and until now the owner
carried them as two tickets and two runs.

Separately, the app could hold several boards but showed exactly one:
`detect()` silently picked the first registered vault that carried
`tickets/_meta/pipeline.md`. Living with two projects (two tickets
repositories) meant remembering which one wins. And the repositories
registry itself was a hand-edited YAML file — the owner asked to select
the repos the runners work on, from folders, not from YAML.

The owner named the model themselves: **per tickets repository, one
project**; possibly several projects, each with its folders and its
tickets.

## Decision

**Projects are tickets vaults, named and switchable.** A project is a
registered vault carrying a board — the one-repo-per-board rule of
ADR-0076 stands. The board panel header gains a switcher listing every
vault with a board; the selection writes the existing `vaultId` plugin
config (the same key `probeVaults` already ordered by) and the board
follows on its next refresh. No second config, no path layout change,
no multi-board-per-vault — the runner, the transition discipline and
the files guard keep their single-board assumptions per vault.

**A ticket may name several work repos; the first is the primary.**
Frontmatter carries the new `repos:` list beside the legacy `repo:`
line. The parser reads the list as the truth when present (the legacy
line reads as a one-entry list otherwise); a mismatch between the two
is a visible noise finding, never a guess. The primary keeps every role
it had today:

- the run's worktree (`RunRequest.repoPath`/`worktreePath`), where the
  gate commands run and the context pack reads (instructions, diff
  stat);
- the record's worktree — takeover, "Open work folder", the Files
  panel's `_worktrees/<id>` target;
- the worker pin ladder's repo rung (the first named repo that pins a
  worker decides the card's display worker).

Every further repo gets **one worktree per repo, all on the ticket's
branch** (`t/<id>` exists independently in each repo; base per repo =
its `branch:`, `link:` folders honored). The worktrees are prepared by
the same state machine as the primary's (reuse/create/recreate/
move-aside), before the run starts — a failure refuses the start, the
primary's worktree stays for the retry. The brief lists the extra
checkouts by absolute path so the worker never hunts the disk. "Remove
worktree" removes them again (best effort; a failure is a warning).

**Refusals stay refusals.** A ticket naming a repo that is not in
`repos.md`, or an extra repo without a local `path:`, refuses compose
— the board already badges the unknown name, the runner skips with a
note. Nothing is half-prepared silently.

**The registry gets a surface.** Settings → Tickets gains the
Repositories section over `_meta/repos.md` as editable rows: the file
stays the store (the page re-reads it like the prompts section), a save
regenerates the frontmatter and keeps the owner's prose, one commit per
save. "Add from folder…" is a scan, not a live reference: the picked
folder and its non-hidden subfolders are probed once for `.git`
entries, and the found checkouts arrive as ordinary, editable entries
(origin URL, current branch, absolute path). No new runtime concept —
a repo that appears in the folder later is registered by running the
scan again.

**The interactive offer rule (req-65, amended).** Refine is offered in
every manual column — the queues before the first automatic column
included — and in no automatic column (`agent` and `ci` both count as
automatic; the runner works them). Recorded as a later change on
ADR-0084.

## Consequences

- `RunRequest` carries `extraRepos` (name, repoPath, worktreePath,
  baseRef, links) beside the unchanged primary fields; stored records
  of old runs stay valid, and single-repo tickets produce requests
  byte-compatible with today's.
- The gate stays where it was: acceptance commands run in the primary
  worktree. A step that must verify in the second repo says so in its
  acceptance commands (they are shell lines and may `cd`); the runner
  does not fan the gate out per repo in this round.
- The push discipline is per repo by the commit prompt's text, not by
  new machinery: the worker commits and pushes each repo it touched.
- Multi-repo costs one extra worktree per named repo per ticket —
  cleanup (card action and global sweep) must and does cover them.
- The project switcher makes vault order irrelevant: with several
  boards installed, the silent "first one wins" becomes an explicit,
  visible choice.

## Alternatives considered

- **Several boards inside one vault** (`tickets/<project>/…`): rejected
  — every path, the normalizer, the files guard, the runner config and
  the transition commits assume one `tickets/` tree; the split would
  touch all of them for a benefit the vault model already delivers.
- **A live folder reference in `repos.md`** (repos appear dynamically
  as the folder changes): rejected — it merges two sources of truth;
  scanned, ordinary entries keep the file the single authority the
  board validates against.
- **Fan-out gates per extra repo**: deferred — without an owner need
  for per-repo gate output, the primary gate plus the brief's paths is
  the smaller machine.
