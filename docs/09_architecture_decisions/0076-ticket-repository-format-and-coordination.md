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
