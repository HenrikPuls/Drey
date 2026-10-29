# 0076 — Ticket system: a separate tickets repository, one file per ticket, transitions as git moves

## Status

Accepted (2026-10-17, owner plan review; milestone 83 implements the
foundation). The full machine-facing format specification lives in
[`specs/ticket-schema.md`](../../specs/ticket-schema.md) — this ADR
records the decisions behind it. Extends the multi-vault registry
([ADR-0051](0051-multi-vault-registry.md)) and Git vaults
([ADR-0065](0065-git-vaults-source-control-plugin.md)); the fleet that
works the tickets is [ADR-0075](0075-agent-fleet-architecture-governance-and-run-control.md).

## Context

The owner wants kanban-style development tickets that external agent
sessions (ADR-0075) and the owner both work, with Drey as the board.
Early sketches put `tickets/` inside each work repo; the owner amended
this (2026-10-17): **tickets are not bound to one code repository** —
one ticket's work may touch any repo (or none yet), and a board that
spans repos must not live inside one of them. A separate, dedicated
**tickets repository** is the system of record; it is registered in
Drey as an ordinary vault (ADR-0051), so the board, search and the
Files panel all come for free.

Who writes what, and what enforces it, were decided with the owner:

- Agents work in work repos and must never be able to corrupt the
  board, cross a manual gate, or "finish" their own ticket.
- Concurrent claims must not need a lock server — and must degrade to
  correct behavior even with no server at all.
- No CI on the tickets repo (owner's ruling): one committer, no agent
  pipelines there. Validation must still exist — where the data is
  consumed.
- Hosts are interchangeable (ADR-0075): GitHub first in practice,
  Azure DevOps first-class, plain git everywhere.

## Decision

**One Markdown file per ticket; the phase is the directory; the
filename is the identity.** `tickets/<phase>/<id>.md`, id `T-` + at
least four digits (`T-0042`), minted as the next free number, never
renamed or reused. A phase transition is `git mv` + exactly one commit
(`tickets: T-0042 inbox -> prioritized`); the file's history is the
ticket's timeline. The pipeline's phase list is itself configuration in
the tickets repo — `tickets/_meta/pipeline.md` (ordered phases with
id, title, optional WIP limit, optional claim flag, and the
per-handover spec `manual | agent <prompt-ref> | ci | none`). Default:
inbox → prioritized → plan → plan-review → build → review → commit →
done. Board state is never stored: everything (columns, order, claims,
ages) is derived from the files on every render.

**Strict frontmatter, tolerant readers, free humans.** Machine writers
(Drey's tickets plugin, the fleet runner, from milestone 84 on also
agent CLIs given the spec) write the strict schema of
`specs/ticket-schema.md` exactly: `id`, `title`, `repo`, `priority`,
`rank`, `branch`, and when present `claimed-by`/`claimed-at`, `run`,
one `entered-<phase>` UTC stamp per phase visited, optional
`references`, `parked-reason`/`parked-at`. Humans edit ticket files
freely — any YAML the `yaml` package parses is read; anything
ambiguous is reported visibly, never guessed: **tolerate noise, never
ambiguity**. The branch rule is deterministic — `t/<id>` — and the
`branch:` field is cross-validated against it; on conflict the rule
wins and the mismatch is shown.

**The single-writer rule.** Ticket files are written only by Drey (the
owner's actions in the board) and, from milestone 84, the fleet runner
performing transitions on an agent's behalf. Agents never write the
tickets repo; they physically cannot cross a manual gate or vote their
own work done. The board's writer semantics are: rewrite frontmatter
canonically on a transition (normalize-on-write), never rewrite a file
merely because it was read.

**Claims are phase transitions; push is the compare-and-swap.** Moving
a ticket into a claim-flagged phase (default: build) stamps
`claimed-by` + `claimed-at`. Two writers racing for one ticket both
commit locally; the first push wins, the loser's push is rejected by
plain git — re-read, re-evaluate, pick the next ticket. No lock
server, no protocol; with a remote (private GitHub or Azure DevOps,
owner's ruling) the CAS is real, and the single local runner makes it
rarely needed anyway. A stale claim (lease) is visible by age on the
board in milestone 83; the automatic reaper lands with milestone 85.
Takeover discards the old claim and logs it.

**Order: derived, with sparse pins.** Within a column, tickets sort by
`priority`, then `rank`, then `entered-<phase>`, then id — no stored
board state. `tickets/_meta/order.md` optionally pins ids per column:
the pinned ids, in listed order, form the top of the column; unpinned
ids follow in derived order. The file is sparse (only overridden
columns, only pinned ids), so additions from two sides union cleanly
on merge. A drag within a column pins the cards above and including
the drop position. The pinned head of `prioritized` is exactly the
queue an agent lane reads (ADR-0075: agents take only the top).

**Validator, not CI.** One deterministic validation module (schema
fields, id ↔ filename, branch grammar, phase membership, order/pipeline
consistency) runs where the data is consumed: the board normalizes
visibly and badges issues; the fleet runner (M84) refuses to act on an
erroneous ticket. No CI on the tickets repo; a work repo's CI is an
optional amplifier, never a dependency — the machine gate is the
ticket's executable acceptance criteria run locally by the runner.
Host-specific surface is only the remote's branch-policy configuration
(Azure DevOps branch policies, GitHub branch protection, a receive
hook), recorded per work repo in `tickets/_meta/repos.md` beside the
name → URL/path mapping.

**Repos are named, not embedded.** A ticket's `repo:` field carries a
name from `repos.md`; the mapping to clone URL / local path, default
branch and policy note lives in the tickets repo, so the board travels
with its own configuration and an agent can read it through the
governed path (ADR-0075).

**Schema homes:** the machine-facing format spec is
`specs/ticket-schema.md` (beside `frontmatter-schema.md`, which links
to it); ticket files are NOT vault notes — no `title`-fence semantics
of `frontmatter-schema.md` apply beyond the shared YAML conventions
(quoted dates, LF).

## Consequences

- The tickets repo is portable: clone it, register it as a vault, the
  board appears. Moving it between hosts is a URL change; the fleet
  never notices (ADR-0075's git-only rule).
- Work repos stay untouched until a `t/<id>` branch exists — the
  fleet's only footprint in a work repo is its branches.
- Merge conflicts on ticket files are rare by construction: two people
  editing the same ticket's body conflict like any Markdown; two
  transitions race through the push CAS; `order.md` conflicts are
  text-level and resolved by hand (union semantics).
- An id minted on two sides collides only at merge; the later side
  re-mints file and branch together in one commit (spec §Id minting).
- The validator catches schema drift the moment a file is read, but
  nothing runs on push — a bad ticket pushed from outside Drey shows
  its issue badge at the next board render. Accepted: the readers are
  the only consumers that matter.
- Parked tickets (circuit breaker, ADR-0075) return to `inbox` with
  `parked-reason`/`parked-at` — the schema reserves those fields now.
- The `run:` frontmatter map (pid, started-at, stream) is reserved for
  milestone 84's run control; milestone 83 validates it but never
  writes it.

## Later change — numbered folders, moves as transitions, archive, auto-push (2026-10-19, T-0041)

Four owner rulings from the 2026-10-18 design rounds, implemented in
T-0041:

- **Numbered phase folders.** Phase directories are named `NN-<id>`
  (`NN` = 1-based pipeline position × 10: `10-inbox` … `80-done`).
  Readers strip a leading `\d+-` and match the rest against the
  pipeline ids — an unprefixed directory stays tolerated, so the
  migration of an existing repo is 8× `git mv` and ship order is free.
  Ticket files never change: `entered-*` keys, order.md sections and
  branch names keep the clean ids. One shared resolver derives every
  writer's target directory; it **reuses before it derives** (an
  existing `35-qa` or unprefixed `inbox` wins over the derived name),
  so inserting a column takes a gap number and nothing ever renames —
  no cascade.
- **A file move is a ticket move.** A ticket file moved between phase
  folders outside the board gets exactly the board-move treatment:
  stateless normalization on every board fetch derives the need from
  the files (an `entered-<B>` stamp missing or older than the newest
  event), then stamps, logs, cleans pins and commits once — actor
  `owner@<host>`. No watcher (they are opt-in, ADR-0018/0045), no
  "seen moves" state file; it survives restarts and never fights the
  runner (live-`run:` tickets are skipped; writes go through the same
  queue and patcher). Lane rules stay runner-only: human moves are
  logged, never blocked.
- **Archive instead of delete.** `tickets/archive/` is a reserved
  folder beside `_meta` — never a column, invisible on the board, no
  counter (owner ruling). Archiving (card menu, two-step armed, or a
  file move into the folder) appends the Log marker `— archived` and
  commits `tickets: <id> archived` with pin cleanup; there is
  deliberately **no** `entered-archive` key — the marker is what makes
  archival idempotent and a revive-then-re-archive detectable. Reviving
  is a move back into a phase folder (normalization stamps it as
  `archive -> <phase>`); final deletion stays the owner's manual act
  inside `archive/`.
- **Auto-push.** An optional `push:` key in pipeline.md names a git
  remote (a name from git config — URLs belong to git, and can carry
  credentials). When set, each transition commit — board move,
  normalization move, archive, runner success move — is pushed with
  `git push <remote> HEAD`. Default off; a failure is a warning (board)
  or log line (runner), never a failed transition.

## Later change — ticket dependencies, `blocked-by` (2026-10-29, T-0050)

Tickets could not express "do not start before X is done"; the order
lived in prose (T-0049: "Blocked by T-0048"), invisible to the board
and the fleet — a worker could claim a ticket whose input data did not
exist yet. T-0050 adds the first-class dependency field:

- **`blocked-by: [T-0048]`** — a list of ticket ids, canonical as a
  flow list with comma + space. The transition patcher round-trips that
  form byte-stably (no patcher change was needed: the vendored `yaml`
  preserves flow collections under the serializer options in use); any
  YAML list shape parses, a hand-written no-space list normalizes
  cosmetically on the next machine rewrite.
- **Blocked is derived, never stored** — the same discipline as
  columns, order and claims: every board assembly runs a dependency
  pass over the final card list (after the duplicate-id pass) and
  stamps each card with its open blockers (`blocked`, unknown ids
  included) and the open-edge inverse (`blocks`). A reference is
  satisfied exactly when the referenced ticket sits in the terminal
  (last) phase — one global rule; per-reference override syntax
  (`T-0048@commit`) was rejected as grammar and UI cost with no user.
- **Never a silent unblock.** A blocker id that resolves to no board
  ticket (deleted, renamed, or moved into the archive, which the board
  never reads) is a warning and keeps the dependent blocked.
  Self-reference and cycles are one error per member naming the cycle;
  cyclic members count as blocked — a cycle can never be satisfied,
  phases aside.
- **Enforcement at the machine gates only**: the dispatcher's pick
  (`dispatchable`), the manual run start and the ci sweep refuse a
  blocked ticket and say why (the chain log names the blocked id and
  its blockers). A redundant third gate in the request composer was
  rejected — no path is uncovered and a duplicate gate drifts. The
  owner stays the final authority: a manual drag into an agent column
  asks for confirmation naming the open blockers (Cancel / Move
  anyway); moves into non-agent columns never ask. The board shows
  `blocked by` / `blocks` chips and an optional "hide blocked" view
  filter (localStorage, never the repo); ordering is never touched,
  and the drift pass never enforces blocked-ness — a file move is an
  owner move.

## Later change — ticket dependencies: the blocked-by field (2026-10-29, T-0050)

Tickets could not express "do not start before X is done"; the order
lived in prose (T-0049: "blocked by T-0048"), invisible to the board
and the fleet. T-0050 adds a first-class `blocked-by:` id list to the
frontmatter (`specs/ticket-schema.md` § Dependencies holds the full
rules):

- **Derived, never stored** — the same discipline as columns, order
  and claims: every board assembly runs a pure dependency pass
  (`plugins/tickets/main/blocked.ts`) that computes each card's open
  blockers and the inverse dependents. A reference is satisfied exactly
  when the referenced ticket sits in the pipeline's terminal phase —
  one global rule (per-reference overrides were considered and left
  out: grammar and UI cost with no user; ids stay plain ids, so
  parsing, round-trip and validation stay trivial).
- **Never a silent unblock.** A blocker id that resolves to no board
  ticket (deleted, renamed, archived — the board never reads
  `tickets/archive/`) is a warning and keeps the dependent blocked.
  Self-reference and cycles are one error per member naming the cycle;
  cyclic members count as blocked.
- **Enforcement at exactly the machine gates**: `dispatchable` (the
  dispatcher's pick), the manual run start and the ci sweep all refuse
  a blocked ticket; the chain log names the blocked id and its
  blockers. The owner stays the final authority — manual moves are
  free, only a drag into an agent column asks for confirmation. The
  drift pass deliberately never enforces blocked-ness (a file move is
  an owner move, consistent with lane rules staying runner-only).
- **Round-trip safety**: the canonical flow list
  (`blocked-by: [T-0048, T-0049]`, comma + space) survives a transition
  patch byte-identically — verified against the vendored `yaml`, so no
  patcher change was needed; the parser accepts every list shape and a
  hand-written no-space list normalizes cosmetically on the next
  machine rewrite.
- The board shows `blocked by <ids>` / `blocks <ids>` chips (both hide
  when satisfied) and an optional "hide blocked" filter — pure view
  state (`drey.tickets.hideBlocked`, the column-collapse pattern);
  ordering is never touched. Cross-repo dependencies, soft links and
  scheduling views are out of scope by the owner's list.
