# 0090 — Tickets on dricket: the ticket store becomes `dk`, the fleet claims through it

## Status

Proposed (2026-11-04, owner request; analysis in
[`docs/design/dricket/`](../design/dricket/fit-analysis.md)). Nothing is built.
If accepted it supersedes, in part, [ADR-0076](0076-ticket-repository-format-and-coordination.md)
(file layout, phase folders, claims as phase transitions, the move machinery,
the validator's structural half, normalization) and amends
[ADR-0075](0075-agent-fleet-architecture-governance-and-run-control.md) and
[ADR-0077](0077-continuous-orchestration.md) (claims and takeover only; run
control, workers, governance and the dispatcher stand),
[ADR-0086](0086-tickets-remote-access.md), [ADR-0087](0087-work-panel-replaces-the-kanban-board.md),
[ADR-0088](0088-tickets-engine-package-cut.md) and
[ADR-0089](0089-views-saved-layouts-with-their-own-tabs.md) (storage seam only).

## Context

Drey keeps its tickets as Markdown files in a dedicated git repository: one
file per ticket, the phase is the directory, every move is one commit, claims
are `claimed-by` stamps with a push as the compare-and-swap, and the engine
(`packages/tickets-engine`) owns every read, write, parse and validation of
that format. The format is rich (nested YAML, a dozen body chapters, a ledger,
status logs, a pipeline with per-phase handovers). It has grown a long list of
machinery whose only job is to keep the files coherent: the transition machine,
phase-folder numbering, the stateless drift pass, the Log-line writer, the
`run:` stamps and their retirement rules, `.status.log` and ledger sweeps, and
over a thousand `fleet run bookkeeping` commits (1 057 of 1 684 in the real
repo).

The owner has since written **dricket** (v0.5.0): a Git-native ticketing tool,
one static `dk` binary, GPL-3.0-or-later, designed for these needs. Claims are
a fast-forward compare-and-swap with leases by size and an `epoch` fencing
token; writes are validated against structural and transition invariants;
`--json` and documented exit codes are the frontend contract; the repository
history is replay-validated.

Decision of the owner (2026-11-04): **Drey's whole ticket handling, including
the fleet, runs on dricket.** Gaps in dricket are requirements for dricket, not
Drey workarounds.

## Decision

1. **Drey calls `dk` as a separate process** (`dk ... --json`, exit codes,
   `--if-version`). It does not re-implement dricket in TypeScript, does not
   link it, and writes nothing under the ticket checkout by any other route.
   Reading the checkout is allowed as a cache under the freshness rule in
   `engine-impact.md` §4; `dk` is the contract.
2. **The fleet stops moving and claiming tickets itself.** The runner claims
   (`dk claim`, owner id per run, lease by size), extends, releases with the
   target stage and a message, writes body chapters inside its claim
   (`sync`/`commit`, or `put` once it exists), comments, and stops its worker on
   exit 13 (fencing). Worker processes never receive `dk` or credentials:
   ADR-0076's single-writer rule stands, with the runner as the only caller.
   Drey's dispatcher (selection, pools, personas, budgets, breaker) stays; it
   does not use `dk next`.
3. **One seam: a `TicketStore` port** in `packages/tickets-engine`, implemented
   by `FileTicketStore` (today, wrapped) and `DricketTicketStore`; chosen by
   `tickets.backend`. Mission Control, the remote protocol, the DTOs and the SSE
   events do not change; ids cross the seam in display form (`T-0063`).
4. **Ids:** prefix `t`, numbers preserved: `T-0063` <-> `t-63` as a pure
   function; branches and worktree folders keep `t/T-0063`.
5. **Layout:** two repositories. A new dricket store holds the tickets
   (`main` + `tickets` branches). The existing repository becomes the **meta**
   repository: `_meta` (pipeline, personas, prompts, repos, chat, ledger),
   attachments and videos. dricket owns the whole `tickets/` tree of its
   branch and flags any other file as `unexpected-path`.
6. **History is cut.** The legacy repo gets the tag `pre-dricket` and stays
   readable; the new branch starts from the migrated snapshot. A reverse
   converter provides the rollback.
7. **What stays Drey's:** Mission Control UI and chat, personas, flows and
   chains, plans and parts, proof/verification/video, costs and estimates,
   `## Verlauf` and the other body chapters, the desktop integration (views,
   tabs, Assistant targets), the dispatcher, worktrees of work repos, the remote
   gateway and pairing. Domain validation (acceptance criteria present, repo
   resolves, chain grammar, persona exists) stays Drey's second validator
   beside `dk lint`/`dk validate`.
8. **dricket prerequisites** (the blocking ones; full list with severity in
   `dricket-requirements.md`): extension fields settable (R-01), a whole-ticket
   write without checkout and without being the claimant (R-02), a configurable
   stage vocabulary (R-03), a `move` for unclaimed tickets (R-04), an import
   that preserves ids (R-10), Windows CI (R-13). Work on Drey's write path
   (E14-4) waits for them; the read path, the fleet claim path and the migration
   dry run do not.
9. **Staging:** `shadow` reads for comparison, one source of truth at any time,
   no dual writes; cut-over behind a freeze, a final idempotent import and a
   smoke list; legacy code deleted only 30 days later.

## Consequences

**Gains.** Claims across machines with real fencing; takeover by lease instead
of overwrite; stable paths; `rev` for optimistic edits; comments that never
conflict with the owner of a claim; secret scan, quota, profiles; the
bookkeeping commits and the folder-move machinery disappear; a store other
tools and people can use without Drey.

**Costs and risks.**
- Every write is fetch + commit + publish (local store: a local ref update).
  Spike numbers: claim p50 about 0.65 s and p95 about 4 s under 10-way
  contention; per-call cost on Windows unmeasured (Q-07). Per-line bookkeeping
  must not become per-line commits (`working:` stays ephemeral).
- dricket's write surface is narrower than Drey's UX (no stage change of an
  unclaimed ticket, no body write without a claim, no extension fields) until
  R-01..R-04 land. A stopgap exists (claim, sync, write, commit, release) but
  costs four commits per save.
- Reads: `ls` spawns a `git show` per ticket; fine for 27–100 tickets, not for
  thousands (R-05).
- Data model differences are absorbed in the adapter: flat front matter
  (titles containing `:` are valid dricket and invalid YAML), `## Log` and
  `## Result` written by both tools, dangling dependencies blocking (R-12), the
  `release -m` chapter-replacement hazard (R-21), no archive concept.
- dricket is young (v0.5.0, "early release") and its Windows behaviour is not
  CI-proven; Drey pins a `dk` version and checks `min_version`.
- Bundling the `dk` binary in the Drey installer is distribution of GPL code
  (source offer required); the owner holds both copyrights.
- The legacy history is not carried over; it stays reachable in the old repo.

**Obsolete after the cut-over** (marked in the roadmap): phase-folder
numbering and renumbering, "a file move is a ticket move" and the drift pass,
the archive folder and `— archived` marker, `entered-*` stamping (kept only
for migrated tickets), the `run:` map, `claimed-by`/`claimed-at`, `.status.log`
files and the ledger-in-ticket-repo sweep, the Log-line writer, the pipeline
`push:` key, the transition machine's file IO.

## Alternatives rejected

1. **Re-implement dricket's protocol in TypeScript.** Defeats the purpose
   (one tool that humans, agents and other frontends share), duplicates the CAS
   and fencing logic that took a spike to validate, and forks the format. The
   owner ruled it out.
2. **Keep both formats** (Drey files for the board, dricket for claims, or a
   permanent two-way sync). Two sources of truth for one ticket; every
   transition becomes a distributed transaction between two stores; the
   bookkeeping problem doubles. Only a *temporary* `shadow` read mode is kept,
   for verification.
3. **Adopt dricket unchanged and bend Drey to it.** The fixed stage enum, the
   missing human write paths and the claimant-only body writes would turn
   Drey's editor-centred workflow into claim round trips. The gaps are
   dricket's to close (the owner is its author).
4. **Fork dricket into Drey.** Loses the standalone product and its tests; the
   process boundary is also what keeps the GPL boundary clean.
5. **Import the 1 684-commit history.** Impossible under `dk validate`'s
   history replay (rev, epoch, one ticket per commit, foreign paths); it would
   also move 1 057 bookkeeping commits into a branch meant to be a clean audit.
6. **Put `_meta` on the `tickets` branch or beside the tickets.** Fails on
   `unexpected-path` and on one working tree holding one branch.

## Open questions

Owner decisions OD-1..OD-9 are listed in
[`migration-plan.md`](../design/dricket/migration-plan.md) §10 (prefix and
numbering, history cut, account model, stage vocabulary, repo split, the dricket
release that gates E14-4, archive, local-store-first, bundling). dricket
questions Q-01..Q-08 (owner id grammar, waiting for a human inside a claim,
secret-scan false positives, who edits `dricket.toml`, atomic plan release, the
cost of one `dk` call, local store as default) are in
[`dricket-requirements.md`](../design/dricket/dricket-requirements.md).
Not yet answered by any measurement: `dk` call latency on Windows, `ls` at 1 000
tickets, `validate` at 10 000 commits, behaviour with CRLF checkouts.

## Later change — reads from the files, writes through `dk put` (E14-4, 2026-11-05)

**Decision (owner, 2026-11-05).** Drey no longer asks `dk` for what it can
read: the board is built from the files of the store's checkout
(`tickets/<prefix>/<shard>/<id>/ticket.md`, `comments/`, the format in
dricket's `docs/protocol.md`) by a **read-only parser**
(`store/file-store-reader.ts`) behind the `TicketStore` read port, reusing the
flat front-matter reader and `detailFromContent`. Writes stay in `dk`:
`dk put <id> -F <file> --claim --if-version <rev>` (one commit, `rev` + 1),
claim, release and extend; the engine is the single writer, one queue per store
(`DkProcess`). Exit 12 is re-read and handed back to the caller to ask.

**Why.** Measured on the 91-ticket migrated store (`performance.md`): a board
build through `dk` is one `ls` plus one `show` per ticket, 29 s on v0.6.0 and
7.7 s on v0.6.1; the file read is 4 - 18 ms. Nearly all of a `dk` call is
git process starts. No amount of caching makes a 30 s board refresh usable, and
v0.6.1 only shrinks it.

**Deviation from "no TypeScript re-implementation of dricket".** The reader
knows dricket's *file format* (parse only). It re-implements no decision:
claims, transitions, leases, epochs, validation and every write stay in `dk`.
One rule is applied on read — the lease-expiry rule of protocol.md (a claim past
`lease_until` plus the 20 minute grace reports as unclaimed, `epoch` stays, the
raw `text` is untouched) — because a board that shows a dead claim as live is
wrong, and `ls` would not tell either. If the format changes the reader breaks
loudly in its equality spec against `dk` (`DREY_E144_STORE`), not silently.

**Consequences.** `MIN_DK_VERSION` is 0.6.0 (`put --claim`); v0.6.1 is
recommended (parallel reads, fewer git processes). The checkout must be a
working tree of the store's ticket branch and **must not live in OneDrive**; a
local store is its own checkout, a remote store needs `tickets.dk.checkout`.
Change detection is three-part: own writes announce directly, a file watcher
(200 ms debounce) catches foreign writers, a remote store adds a periodic
`dk sync` (`tickets.dk.syncSeconds`, default 30) and on-demand syncs. Without a
checkout the engine falls back to the E14-2 reader (one `dk show` per ticket).

## Later change — the board writes through one bridge (E14-4b, 2026-11-05)

**Decision.** The board's mutations keep their pure text patchers (refine, header
edits, parts, flow, the transition machine). On `tickets.backend = dricket` they run
on the record folded into the legacy shape and the result is turned back into a
dricket document by `store/legacy-bridge.ts` — the inverse of `recordToBoardFile` —
and written with `dk put --claim --if-version <rev>`. There is no second writer and no
TypeScript copy of a dricket decision: the bridge only maps header fields and carries
the body; claims, leases, epochs, stage rules and validation stay in `dk`.

**Moves and the archive.** A move is a `put` with the target stage (variant A: stage =
phase id). The archive has no stage of its own in dricket: it is the terminal stage plus
the label `archived`, and the board hides labelled records (migration plan §3 / OD-7).
Capture is `dk add --unclaimed` (dk allocates the number, R-28) plus one `put`; the parts
release is children first (`add` with parent and depends, then `put`), parent last, and
resumes by matching the existing children by title and filling stubs left empty.

**Consequences.** Exit 12 never overwrites: the caller is told the ticket changed.
The fleet's own ticket writes (claim takeover / release, run stamps) are refused on
dricket until E14-5 re-bases them on `dk claim`. The editor save hook and ticket documents
opened from the checkout are E14-4c (they sit in `note-manager`, not in the board).

## Later change — the run lease (E14-5, 2026-11-05)

**Decision.** A fleet run on `tickets.backend = dricket` claims, extends and releases its ticket
through `dk` and writes no ticket file. One `RunLease` per run (`fleet/run-lease.ts`) sequences
the calls over the `TicketStore` port; every decision stays in `dk` — lease length by size, epoch,
takeover after `lease_until` + grace, stage rules. The run request carries the store (`RunRequest.dk`),
so the runner process needs no backend setting of its own and an old request without it runs the
files paths unchanged.

**Rules this fixes.**
- The claim is the first act of `start`: refused (exit 11) means no worktree and no worker.
- The owner id is per run (`agent-<run id>@<host>`, dk's `[a-z0-9._@-]`): fencing tells two runs
  of one ticket apart, and an adopted run re-claims idempotently.
- Exit 13 on any call fences the run: the worker is stopped, nothing more is written.
- **A note is a comment, never `release -m`** (dricket R-21 would replace the chapters between
  `## Result` and `## Log`). The release names a target stage only.
- A move is `release --stage <next phase>`. A run that moves nothing releases to the stage the
  ticket sat in before the claim (dk moves a claimed ticket into the first claim stage), else to the
  stage before the working one — an agent may not release into the stage it is in.
- Park = comment + release to `blocked` **when the pipeline has such a stage**; the migrated store
  has none (`inbox prioritized build commit done`), so a parked ticket keeps its stage with the
  comment — OD-4 decides whether `blocked` joins the vocabulary.
- `Dricket-*` trailers and `dk validate --trailers` in the gate are opt-in (`tickets.dk.trailers`).

**Not decided here, left open (roadmap E14-5b).** The chain orchestrator still reads ticket files and
is refused while the board runs on dricket; chapters written inside the claim; needs-input re-claim.
