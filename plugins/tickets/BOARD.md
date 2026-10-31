# The tickets board — owner checkpoint handling

The tool-neutral guide to working the tickets board's checkpoints by
hand — review above all the **commit → done** discipline: when a
ticket on `commit` may move to `done`, how to prove it with git, and
how to make the move without breaking the format. The criteria bind
everyone the same — a human at the board, an agent on the owner's
word, or the commit column's own agent once the pipeline runs it
(config-driven, see below). Aimed at any coding agent (referenced
from `AGENTS.md`; skill-capable harnesses carry a thin shim pointing
here) and at the owner working from a terminal. The machine side —
the fleet runner and the chain daemon — has its own guide,
[`FLEET.md`](FLEET.md); the format itself is
[`specs/ticket-schema.md`](../../../specs/ticket-schema.md).

## The rule (owner ruling, 2026-10-18)

A ticket on **commit** goes to **done** exactly when **all three** hold:

1. **Fully implemented** — the ticket's Plan and acceptance criteria
   are met by the code as it exists on the integration branch.
2. **Committed** — the work is merged into the integration branch
   (`main`, or the `branch:` that `_meta/repos.md` records for the
   ticket's repo) — via a pull request where the repo forbids direct
   commits (the repo's `policy:` note says so; the merge commit is the
   evidence, the PR is just the vehicle).
3. **Pushed** — the remote's integration branch contains that merge:
   local `main` is in sync with `origin/main`, not ahead of it.

Any criterion failing → the ticket **stays on commit**; it waits for
testing or more work. Never move a ticket to make a column look tidy.
A reverted feature counts as landed only when the revert is its own,
also-merged ticket (the T-0006 pattern: feature ticket and revert
ticket both on `main` → both go done).

## The evidence recipe (git only, never a host API)

Work in the ticket's **work repo** (frontmatter `repo:` → name in
`_meta/repos.md`, its `path:` the local checkout); the branch/merge
facts live there, not in the tickets repo.

1. **Fresh remote state**: `git fetch`, then check the integration
   branch is not ahead: `git rev-list --count origin/main..main`
   must be `0` (a push is still pending otherwise).
2. **Work merged**: every commit the ticket's Log names — branch tips
   (`t/<id> @ <sha>`) or the integration/merge commit — is an
   ancestor of `main`:
   `git merge-base --is-ancestor <sha> main` (exit 0).
3. **Actually implemented**: spot-check the feature in `main`'s tree —
   `git grep <symbol> main -- <paths>`, `git ls-tree -r --name-only
   main <folder>` — not just "a commit exists"; for a revert ticket,
   confirm the feature is *gone* (`git grep` finds nothing).
4. **Pushed**: the merge commit is an ancestor of `origin/main`
   (`git merge-base --is-ancestor <merge-sha> origin/main`).

## The move (schema-exact, one ticket = one commit)

The tickets repository is a vault of its own — `chain.json`'s
`config.ticketsVaultPath` names it (the board's Settings show it too).
A transition is one commit there, per
[`specs/ticket-schema.md`](../../../specs/ticket-schema.md). Phase
folders are numbered (`NN-<id>`, position × 10 — T-0041); the move
uses whatever directory names exist (`70-commit`, `80-done` in the
default 8-phase pipeline; unprefixed names work the same):

```
git mv tickets/70-commit/<id>.md tickets/80-done/<id>.md
```

then, in the moved file:

- frontmatter: add `entered-done: '<UTC now, quoted, seconds>'`
  (`'2026-10-18T22:16:32Z'`) next to the other `entered-*` keys — the
  key keeps the CLEAN phase id, never the number;
- `## Log`: append one machine-shaped line —
  `- '<UTC timestamp>' owner@<host> — commit -> done` — plus the
  evidence in a few words (work sha, merge sha, "main pushed");
- commit with exactly `tickets: <id> commit -> done`.

Shortcut that stays schema-exact: `git mv` the file and commit only
that — the board's next refresh completes the treatment
(`entered-done` stamp + Log line, T-0041's
normalization) in its own commit. Writing the stamp by hand is still
fine; both paths converge.

Discipline that keeps the repo clean:

- **Stage only that ticket's file.** The tickets repo often carries
  unrelated pending changes (prompt edits, other moves); they never
  ride along into a transition commit.
- **Moves run sequentially** — parallel `git mv`/`git commit` in one
  repo race on `index.lock` (a lost race is recoverable: wait for the
  lock to clear, retry).
- UTF-8, LF; the `LF will be replaced by CRLF` warning on Windows is
  harmless. Log lines use `—` (em-dash) after the who, `->` (ASCII)
  for the transition.
- **Leave foreign uncommitted changes alone** — they are someone's
  work in progress, not cleanup targets. Pushing the tickets repo is
  the owner's call, not part of the move — unless pipeline.md sets a
  `push:` remote (T-0041): then every transition the BOARD or the
  RUNNER writes is pushed automatically; a move made by hand in a
  terminal pushes when the owner pushes (never sweep unrelated commits
  into a manual push to "help").
- **Archiving is not deleting** (T-0041): a ticket that will never be
  worked goes to `tickets/archive/` (the Work row's menu → Archive…,
  armed two-step; Accept on a finished ticket; or a plain file move —
  normalization finishes it: `— archived` Log line, one commit
  `tickets: <id> archived`). Archived tickets are invisible on the board; reviving is a
  move back into a phase folder; final deletion inside `archive/` is
  the owner's manual act — and the owner's alone.
- **A blocked ticket waits by itself** (T-0050): a ticket with
  `blocked-by: [T-00xx]` in its frontmatter is blocked while any
  referenced ticket has not reached the last phase — the Work panel
  says so in the row, the fleet refuses to pick or run it, and nothing needs doing to
  keep it waiting. Moving the blocker to `done` unblocks it on the
  next refresh. The owner may still move a blocked ticket anywhere (a
  move into a worker phase asks for confirmation); an id that names
  no board ticket — deleted, renamed, or in `archive/` — no longer
  blocks. Removing the
  dependency is a frontmatter edit, the owner's.
- The board picks the moves up on its next refresh; the chain
  daemon's master switch is irrelevant for manual columns.

## What is — and is not — automated

- Whether a column runs itself is the **pipeline's call**
  (`_meta/pipeline.md`): `handover: manual` = the human's queue;
  `handover: agent <prompt-ref>` = the chain dispatches it (worker,
  model, pool size per the M85 column keys; the settings dialog
  writes them). The live board has run `plan`, `build` and — since
  2026-10-19 — `commit` as agent columns; a `commit` column with an
  agent handover lets the machine move tickets **into `done`** on a
  green gate (the same mechanism that does `build -> review (fleet)`).
  Note the terminal phase itself never dispatches (it has nothing to
  move into); moving **into** `done` is humans, or — since the owner
  ruling of 2026-10-19 — the commit column's agent: its
  `commit-default` prompt is the push step (branch onto the
  integration branch and the remote; a `policy:`-protected repo
  waits for the owner's merge), and on completion the machine moves
  the ticket `commit -> done`.
- An agent column dispatches only when its prompt file exists
  (`tickets/_meta/prompts/<ref>.md`) — a missing ref logs
  `dispatch skips <id>: prompt "<ref>" is missing` and the column
  idles. Check the prompt exists before expecting moves.
- The chain orchestrator automates only `agent` and `ci` handovers
  (M85): `ci` runs the phase's acceptance command runner-side — green
  → one column right, red → a 10-minute backoff. The machine never
  pulls from a `manual` column.
- **No push/PR/merge detection exists anywhere in the fleet**
  (ADR-0075: hosts are interchangeable, the fleet never calls a host
  API). "Merged and pushed" as a *done* criterion is enforced either
  by this guide (a human/agent on the owner's word, local git as the
  only witness) or by whatever the owner's commit-column prompt tells
  the agent to check — never by the runner itself.

A future `handover: merge` mode (branch merged into the integration
branch ⇒ move right) would stay local-git-only and ADR-0075-clean,
but it changes the "never into the last phase" rule — an owner
decision with its own roadmap ticket, not a drive-by.

## Pointers

- Format, validation, agent lane rules:
  [`specs/ticket-schema.md`](../../../specs/ticket-schema.md)
- The runner and the chain daemon: [`FLEET.md`](FLEET.md)
- ADR-0075/0076/0077, `specs/changelog.md` M83+
