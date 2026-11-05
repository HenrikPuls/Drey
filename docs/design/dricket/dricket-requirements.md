# Requirements Drey has on dricket

Status: proposed, for the owner as the author of dricket. Source: the fit
analysis ([`fit-analysis.md`](fit-analysis.md)) and a reading of dricket
v0.5.0 (`d28181b`). These are **requirements for dricket, not Drey
workarounds** (owner decision 2026-11-04). Severity:

- **Blocks** — Drey cannot move onto dricket in the recommended shape without it.
- **Needed** — the move works without it only through a stopgap that Drey
  should not ship (slow, lossy, or several commits per user action).
- **Nice** — improves the result; no stopgap needed.
- **Question** — not a defect: a behaviour I could not determine, or a decision
  that is the owner's.

"Evidence" names the dricket file I read; JSON field lists come from the Go
structs, `dk` itself was not run (see `fit-analysis.md` §0).

## Summary

| Id | Title | Severity |
|---|---|---|
| R-01 | Settable extension fields | **Blocks** |
| R-02 | Whole-ticket write without a checkout and without being the claimant | **Blocks** |
| R-03 | Configurable stage vocabulary | **Blocks** (owner decision) |
| R-04 | `dk move`: change the stage of an unclaimed ticket | **Blocks** |
| R-10 | Import that preserves id, creation data and stage | **Blocks** (migration with preserved numbers) |
| R-13 | Windows is a supported platform (CI, locking, line endings) | **Blocks** (verification) |
| R-05 | Full records in `ls --json`, filters, single-pass reads | Needed |
| R-06 | `show --json` with parsed fields and comments | Needed |
| R-07 | Stage history (`dk log`) | Needed |
| R-08 | Stateless comment list | Needed |
| R-09 | Change feed without polling every ticket | Needed |
| R-12 | Missing-dependency semantics | Needed |
| R-19 | Machine contract: capabilities, schema, stable JSON, rich errors | Needed |
| R-21 | `release -m` can delete other body chapters | Needed (data-loss hazard) |
| R-15 | `validate` cost grows with history | Needed |
| R-24 | One-step change under a short claim (`dk commit --release`, optionally with the claim taken in the same call) | Needed (alternative to R-02 / R-04) |
| R-28 | Create a ticket with a chosen number and creation data (the small form of R-10) | **Blocks** a clean migration (E14-3 works around it) |
| R-11 | Per-ticket attachments | Nice |
| R-14 | Batch mode (one process, many operations) and multi-ticket commits | Nice |
| R-16 | Hook / pre-receive template to refuse non-`dk` commits | Nice |
| R-17 | Byte-limit truncation cuts UTF-8 | Nice (bug) |
| R-18 | `add` options for a complete first write | Nice (covered by R-02) |
| R-22 | `ls --json` answers `null` for an empty list | Nice (found in E14-1) |
| R-23 | `dk version --json` (machine-readable version) | Nice (found in E14-1) |
| R-26 | Parallel read-only `dk` calls on one store must not fail | Needed (found in E14-2) |
| R-27 | `dk init` writes a `dricket.toml` that stays valid with a custom `[stages]` | Nice (found in E14-2) |
| R-29 | `dk --trace` / `DK_TRACE`: per-step timing of what one call does | Nice (found in the E14-4 comparison) |
| R-30 | Fewer git processes per command: a read needs about three, `ls` one batch read | Needed for dricket's own speed; moot for Drey's board (E14-4 reads files) |
| R-31 | An agent may release a ticket into the stage it is in (`build -> build`) | Nice (found in E14-5) |
| Q-01 | Account model: service account or own accounts | Question |
| Q-02 | Owner id grammar | Question |
| Q-03 | Waiting for a human inside a claim | Question |
| Q-04 | Secret-scan false positives and exit 19 handling | Question |
| Q-05 | Who edits `dricket.toml` from a frontend | Question |
| Q-06 | One ticket per commit vs atomic plan release | Question |
| Q-07 | Cost of a `dk` call (process count) and a long-lived mode | Question |
| Q-08 | Local store as the default mode for a desk | Question |

## Blocks

### R-01 Settable extension fields

**Drey needs.** Header keys dricket does not know: `persona`, `chain`, `form`,
`track`, `proof`, `worker`, `awaiting`, `rank`, `references`, plus
`entered-*` for migrated tickets. They change often and are set by the owner
(Work panel, chat commands `setChain`, `setBlockedBy`, ...) while nobody holds
a claim.

**Today.** Unknown keys are preserved on tool writes and warned about in lint
(`ticket.FromDoc`, `Extra`), but `dk set` accepts only the eight free fields
(`title, labels, depends, parent, touches, branch, repos, priority`) and
answers `unknown field` for anything else (`service.Set`, via
`ticket.ClassOf`). `set` also refuses a ticket claimed by someone else
(`KindClaimed`). So an extension key can only change through whole-ticket
`commit` — which needs the claim and a checkout.

**Proposal.**
- Reserve the key namespace `x-<name>` (`^x-[a-z0-9][a-z0-9-]*$`) as a fourth
  field class "extension": single-line, size-capped (e.g. 1 000 bytes), secret
  scanned, never interpreted by dricket, preserved on every write, validated
  only for shape.
- `dk set <id> x-persona=ben x-rank=5000 [--if-version N]`: several pairs in
  **one** commit and one `rev` bump; `x-foo=` removes the key; works on an
  unclaimed ticket without a claim.
- Same on `dk add` (`--set k=v`, repeatable).
- Decision on `set` against a ticket claimed by another owner: see R-02.

### R-02 Whole-ticket write without a checkout and without being the claimant

**Drey needs.** The owner edits a ticket as a Markdown file in the editor at
any time (E13-6); the phone refines a section; Mission Control's Paul edits the
plan; the shape dialog and chat write sections; the runner writes `## Handover`,
`## Changes`, `## Verification`, `## Verlauf`. Today these are one write each.

**Today.** The only body-writing path is `claim` -> `sync` -> edit the file in a
checkout -> `commit` (`service.Commit`: the caller must own the claim; the exact
base must equal the fresh remote ticket; exit 12 otherwise). A frontend without
a checkout, or a human who is not the claimant, cannot write the body at all.
`set` cannot touch the body. `note` only appends a log line.

**Proposal.** `dk put <id> [--if-version N] (-F <file> | -)` — publishes the
complete `ticket.md` text as the candidate:
- same structural validation as `commit` (identity and claim fields must be
  unchanged; `rev` becomes fresh + 1; secret scan; size limit);
- allowed when the caller **owns the claim**, **or** the ticket is unclaimed
  and the caller is `kind human` / listed in `security.admins` (a "coordinator
  write"), **or** the caller is an admin and passes `--force` for a claimed
  ticket (logged, `rev` + 1, claimant's next write sees exit 12);
- `--if-version` is mandatory for non-claimants; result JSON
  `{id, rev, commit, changed_fields[]}`;
- companion `dk add -F <ticket.md>` creates a ticket from a complete document
  (stage, extension fields, body) in one commit (covers R-18).

This removes the need for an engine-side checkout dance and the four-commit
stopgap (`engine-impact.md` §5).

### R-03 Configurable stage vocabulary

**Drey needs.** The owner's workflow vocabulary is his own: phases
`inbox, prioritized, build, commit, done` today (earlier `plan`, `plan-review`,
`review`), edited in Settings; each phase has a handover mode, a persona, pools
and a terminal flag.

**Today.** `stage` is a fixed enum (`open, in-progress, review, done, blocked,
needs-input, cancelled`; `ticket.stages`). `dricket.toml` configures
transitions per role but not the stage set; unknown stages are a lint error.
`Lint` also couples `in-progress` to "owned".

**Proposal.**
```toml
[stages]
values   = ["inbox", "prioritized", "build", "commit", "done"]   # ordered
initial  = "inbox"
terminal = ["done"]                      # satisfies `depends`; `next` skips
claim    = ["build", "commit"]           # a claim is only valid in these stages
cancelled = "cancelled"                  # optional reserved stage, always allowed
```
`claim` sets the stage to the first `claim` stage when the ticket is not in
one; `release --stage` accepts any configured value. The default (no
`[stages]`) stays today's seven values. `validate` replays history with the
stage set **as of that commit** (config versions are on `main`), so a later
edit of the list does not make old history invalid.

If the owner prefers not to touch the enum: Drey stores the phase in `x-phase`
(R-01) and uses stages for coordination only. That works but doubles state and
makes every human move two writes; it is the fallback, not the recommendation.

### R-04 `dk move`: change the stage of an unclaimed ticket

**Drey needs.** A drag from Inbox to Prioritized, the owner's Accept, a
send-back, "park", un-archive: stage changes by a human on a ticket nobody is
working on.

**Today.** No command does it. `set` rejects `stage` (State class);
`release --stage` needs the claim; `commit` needs the claim. A claim + release
round trip is two commits and raises `epoch` twice.

**Proposal.** `dk move <id> --stage <s> [-m <note>] [--if-version N]`:
- allowed on an unclaimed ticket for `kind human` or admins, and for a claim
  holder; refused (exit 11) when someone else holds a live claim unless
  `--force` by an admin (then equal to `force-release` + move);
- one commit, `rev` + 1, `epoch` unchanged, a log line;
- JSON `{id, stage, rev}`.

### R-10 Import that preserves id, creation data and stage

**Status 2026-11-04: not in dricket v0.6.0** (`dk help` has no `import`; `add` has no `--id`). E14-3 works around it with placeholders and `x-created-*`; the small form is R-28.

**Drey needs.** Migrating 27 live tickets (and optionally 64 archived) with
`T-0063` -> `t-63` (numbers preserved), original `created_at`/`created_by`, the
right stage, and the body byte for byte.

**Today.** `dk add` allocates `max + 1` of the prefix and stamps `created_at`
with now and `created_by` with the caller; identity fields are immutable
afterwards. There is no way to choose the number or the creation time; a quota
caps adds per day.

**Proposal.** `dk import --from <dir-or-jsonl> [--dry-run]`, admin only, runs
on a fresh or empty prefix:
- takes complete ticket documents, validates them with the full `lint`, accepts
  explicit `id`, `created_at`, `created_by`, `stage`, extension fields, `rev: 1`,
  `epoch: 0`, bypasses the quota and the "id must be max + 1" rule, but still
  refuses duplicates and non-monotonic collisions;
- writes **one commit per ticket** (keeps the replay invariants) or one
  commit per N tickets under an explicit `import` marker the replay understands;
- bumps the prefix counter so the next `add` is `max + 1`;
- `--dry-run` prints the report without writing.

Without this the migration must renumber (breaks the id continuity the owner
asked for) or create 90 placeholder tickets.

### R-28 Create a ticket with a chosen number and creation data

**Found 2026-11-04 by E14-3 (migration tool) against dk v0.6.0.** R-10 (import) did not ship in
v0.6.0, and the smallest form of it is enough for Drey: creating one ticket whose number and
creation data the caller chooses.

**Drey needs.** `T-0063` -> `t-63` with the legacy `created_at` / `created_by`, the stage the
ticket was in and `rev` 1, without a pile of filler tickets.

**Today (v0.6.0).** `dk add` allocates `max + 1` and stamps now and the caller (no `--id`,
`--created-at`, `--created-by`); `dk put t-63 -F f` on a number that does not exist answers
exit 10 (`precondition failed: ... not found`). The migration therefore fills every gap below
the highest migrated number with a cancelled placeholder ticket (label `placeholder`, two
commits each): the real 22-ticket list needs 69 of them for `t-91`. The legacy creation data
travels as `x-created-at` / `x-created-by`.

**Proposal.** `dk put <id> -F <file> --create` (admin only, like `--force`): the document names
the id (any unused number of a registered prefix), `created_at`, `created_by`, `stage` and `x-`
fields; dk validates it with the full lint, writes ONE commit, `rev` 1, `epoch` 0, and the
next `add` is still `max + 1`. Same secret scan and size limits as `put`; the quota does not
apply to an admin import. `--dry-run` prints what would be written. (`dk import` per R-10 is
the batch form of the same thing; either closes this.)

**Effect on Drey.** `apply.ts` creates tickets directly with `put --create` and drops the
placeholder pass; the creation data is real instead of `x-created-*`.

### R-13 Windows is a supported platform

**Drey needs.** The owner's desk and every current Drey session run Windows;
`dk` is spawned by the engine there.

**Today.** `docs/architecture.md` §1/§2: "Windows is a later goal"; CI covers
ubuntu and macOS; Windows binaries ship without a behaviour guarantee. A
Windows file lock exists (`filelock_windows.go`) and the spike ran on Windows 11
(git 2.55.0, one machine), but the local-ref CAS and checked-out fast-forward
(ADR-0010) are described and tested on the CI matrix only.

**Proposal.** Add a `windows-latest` job running the full gate including the
multi-process concurrency tests; document the supported git range (>= 2.32;
`GIT_CONFIG_GLOBAL` behaviour), CRLF handling (`core.autocrlf=true` checkouts
must not turn `ticket.md` into CRLF or break the byte-for-byte exact-base
compare in `commit`), long paths and antivirus latency. Acceptance: green
Windows CI plus one soak run of the spike harness on Windows.

## Needed

### R-05 Full records in `ls --json`, filters, single-pass reads

**Today.** `ls --json` returns `{tickets:[{id, stage, owner, title, priority,
kind, epoch, rev, labels}]}` with `labels` as a comma string; it lacks
`depends`, `parent`, `size`, `claimed_at`, `lease_until`, `created_at`,
`created_by`, `branch`, `repos`, `touches` and unknown keys. Filters: stage,
owner (`@me`), prefix. `--stale` exists in the service. Implementation:
`ls-tree` then **one `git show` process per ticket**; 91 tickets are fine,
several hundred are not (process spawn per ticket, worse on Windows).

**Proposal.** `dk ls --json --fields all|a,b,c [--label x] [--not-label y]
[--stage a,b] [--since-rev N]`; records carry every known field plus
`ext: {"x-persona": "ben"}` and `labels` as an array; optionally
`--with-body` (for estimate and history scans). Read with a single
`git cat-file --batch` (or `git archive`) over the tree. Target: 1 000 tickets
under one second locally, measured and recorded.

**Status at v0.6.0 (measured in E14-2, 2026-11-04): still open, and it now
decides the board's cost.** `ls --json` still returns the header subset and
`show --json` the raw file, so Drey builds a board with `ls` plus one `show`
per ticket (the `x-` fields, `depends` and `parent` exist only in the file).
Measured on the owner's Windows desk with a local store: **about 0.2-0.4 s per
`dk` call**, i.e. a cold board of 22 tickets takes roughly 8 s and 500 tickets
would take minutes. Drey caches each ticket by `(rev, epoch, stage, owner,
title, priority)` from the `ls` row, so only changed tickets are re-read, and
reads are forced serial (R-26). The fix is this requirement: every field in
`ls --json`, in one `git cat-file --batch` pass.

### R-06 `show --json` with parsed fields and comments

**Today.** `show --json` = `{id, content}` — the raw file. No comments, no
parsed header, no claim summary.

**Proposal.** `{id, fields:{...as ls...}, ext:{...}, body, content, rev,
claim:{owner, kind, size, claimed_at, lease_until, epoch, extensions,
status:"ok|expiring|expired"}, comments:[...see R-08], head:"<sha>"}`. The
`head` lets the caller prove which snapshot it read (and detect staleness
against its own checkout).

### R-07 Stage history (`dk log`)

**Drey needs.** `entered-<phase>` replacement: derived order, ages and the
story card, the estimate history, "how did this ticket get here".

**Today.** None; git history exists but the shape (one commit per write,
messages `dricket: <verb> <id>`) is not exposed.

**Proposal.** `dk log <id> --json` -> `[{rev, at, by, commit, verb, from_stage,
to_stage, owner, message}]`, newest last; `dk log --since <sha>` for all
tickets (feeds R-09). Derived by walking the ticket's path history.

### R-08 Stateless comment list

**Today.** `inbox <id>` reports "new since this owner last looked" using a local
per-owner marker file; unsuitable for a multi-client UI (two clients with the
same owner steal each other's marker; the marker is not part of any contract).
Search can find comment lines but not list them.

**Proposal.** `dk comments <id> [--since <iso|sha>] --json` ->
`[{file, author, created_at, body, commit}]` oldest first; no side effects. Keep
`inbox` for agents.

### R-09 Change feed

**Drey needs.** The engine must notice changes by other writers (another
machine, a terminal) without reading everything.

**Today.** Deliberately none (decision 2026-11-02: no watcher or poller; users
loop `dk inbox`). The concept names the recipe: `git ls-remote` tip, then an
incremental fetch and `git diff --name-only old..new`.

**Proposal.** Still no daemon: `dk changes --since <cursor> --json` ->
`{cursor, ids:[...], comments:[{id,file}], head}` where the cursor is the
ticket-branch commit sha; with no cursor it returns the current head only.
Cost: one `ls-remote` when nothing changed. Drey polls every 30–60 s and after
its own writes.

### R-12 Missing-dependency semantics

**Today.** A `depends` id with no ticket is a `validate` error, and `next`
(`eligible`) treats an unknown dependency as unsatisfied. Drey decided
(2026-10-31) the opposite: an archived, deleted or mistyped blocker no longer
blocks, because archiving a finished blocker stalled a chain.

**Proposal.** In `dricket.toml`: `[depends] missing = "block" | "ignore"`
(default `block`, Drey sets `ignore`); under `ignore`, `validate` reports a
warning and `next` treats it as satisfied. (Tickets are never deleted in
dricket, so this only matters for migrated or mistyped ids; an archive concept
would remove the case.)

### R-19 Machine contract

`dk capabilities --json` -> `{tool_version, json_schema_version,
ticket_schema_version, commands:[...], features:{stages:true, put:true, ...}}`
so Drey can gate on features instead of version strings. Per-command JSON
shapes documented in `docs/protocol.md` (today only the envelope is). Errors
carry detail beyond `kind`: exit 12 is three situations (lost race, version
conflict, local checkout conflict) -> sub-kinds `race-lost`,
`version-conflict` with `{current_rev, current_owner}`, `checkout-conflict`
with `{paths:[...]}`; exit 15 `outcome-unknown` carries `{commit}` so the caller
can reconcile; exit 11 carries `{owner, lease_until}`; exit 13 carries `{epoch,
current_epoch, current_owner}`. Drey maps these to readable messages (as
`docs/integrations/drey.md` already requires).

### R-21 `release -m` can delete other body chapters

**Evidence.** `service.setResult` replaces everything from the first
substring `## Result` up to the next `\n## Log`. Drey tickets keep many chapters
between those (`## Handover`, `## Changes`, `## Verification`, `## Verlauf`);
a ticket whose `## Result` precedes them would lose them on the next
`release -m`. The match is also a substring (`### Results` matches), and
`appendLog` appends to the **end of the body**, not inside `## Log`, so a
chapter after `## Log` receives log lines.

**Proposal.** Replace only up to the next heading of level <= 2 (`^## `), match
the heading exactly (`^## Result\s*$`), and append log lines inside the `## Log`
section (before the next `## ` heading, else at the end). Until then Drey keeps
`## Log` as the last chapter and never passes `-m` to `release` (it writes its
own `## Result` through `put`/`commit`).

### R-31 An agent may release into the stage it is in

**Evidence (dk v0.6.1, E14-5).** `dk claim t-10` on a ticket in `inbox` moves it into the first
claim stage (`build`); `dk release t-10 --stage inbox` works, but on a ticket that already sat in
`build` the release is refused: `agent may not release t-10 from build to build` (exit 14).

**Why Drey cares.** A failed, stopped or blocked run should give its ticket back where it was.
For a ticket that was already in the working stage there is no such release; Drey's runner
retreats it to the stage before (`prioritized`), which moves the card a column left on every
failed retry.

**Proposal.** Allow a release into the current stage for the claim's kind (the lease ends, the
stage stays), or a `release --keep-stage`.

### R-15 `validate` cost grows with history

**Today.** `dk validate` fetches the head and replays the **complete history**
(`validate.go`); the architecture doc itself says full-history validation time
and memory are unmeasured. With Drey's volume (a run writes several times) a
year is tens of thousands of commits.

**Proposal.** Incremental validation from a trusted checkpoint
(`validate --since <sha>` with the checkpoint stored in the private state), a
measured budget in CI (10 k commits under N seconds), and `lint`-level fast
path for the write path (already so).

### R-24 One-step change under a short claim

**Status 2026-11-04: shipped in dricket v0.6.0** (dricket ADR-0013, commit 16e812e).
`dk set` and `dk move` were removed again: every field or stage edit is a whole-ticket
`dk put <id> -F <file> --claim` (claim, write and release in ONE commit; `--claim` is required on
an unclaimed ticket, exit 17 otherwise; `--force` stays the admin emergency path) or
`dk commit <id> --release [--stage S] [-m note]` for a claimed ticket. R-01 (`x-` fields) and R-03
(`[stages]`) shipped as specified. R-02 / R-04 are therefore met by `put --claim` and
`commit --release`; there is no claim-free write left for humans or admins. Drey's contract suite
(48 tests, none skipped) ran green against v0.6.0.

**Drey needs.** The owner's single edits (persona, chain, stage, a header
field) without a second write path. Owner question 2026-11-04: why not hold
the ticket directly -- claim, set, release? That keeps dricket's promise (no
write without a claim) intact, but today it is three commits and three round
trips to a remote for one change.

**Today.** `claim` (commit 1), `sync` + edit + `commit` (commit 2), `release`
(commit 3). `release` takes `--stage` and `-m`, but cannot carry a content
change.

**Proposal.** `dk commit --release [--stage S] [-m note]`: write the edited
ticket and release the claim in ONE commit, same exact-base and epoch checks
as `commit`. Optionally `dk edit <id> -F <file> | set k=v... --claim`: take the
claim, apply the change, release, as one commit (claim fields keep the epoch
bump of a claim). Open points for dricket to decide: whether the epoch rises
by one for such a claim-free-in-practice change; how the lease clock reads in
the log line; behaviour when the ticket is claimed by someone else (exit 11,
unchanged).

**Effect on R-02 / R-04.** If R-24 lands, `put` and `move` are no longer
needed for the owner's handgrips and the claim promise holds without an
exception for humans and admins. R-01 stays (the fields must exist).
Decision pending: keep `put` / `move` as shipped on the branch until the
owner decides.

## Nice

- **R-11 Per-ticket attachments.** A sanctioned sidecar for small binaries:
  `tickets/<p>/<s>/<id>/files/<name>` allowed by `validate` (size cap, no
  history replay on content), with `dk attach <id> <file>`. Lets screenshots
  travel with their ticket and makes `../attachments/` links obsolete. Videos
  stay out of git (Drey's rule).
- **R-14 Batch mode and multi-ticket commits.** `dk batch --stdin` reads JSON
  lines (`{"cmd":"set","id":...}`), runs them in **one process** (one config
  read, one refresh) and prints one result per line; and an `--atomic` mode that
  applies N ticket writes in **one commit** (relaxes "v1 writes touched one
  ticket per commit" for explicitly batched writes; replay accepts it when the
  commit carries a `Dricket-Batch: <n>` trailer). Use: plan release (N child
  tickets + parent note), bulk re-prioritise. Drey can live without atomicity
  (children first, parent last, resumable by title match) — see Q-06.
- **R-16 Hook template.** Ship a ready `pre-receive`/`update` hook and a GitHub
  ruleset recipe that rejects commits on the ticket branch not made by `dk`
  (path and message pattern) — the "host-side gate" dricket already recommends.
- **R-17 UTF-8 truncation.** `sanitize` cuts strings at a **byte** limit
  (`out[:limit]`); a German title near 200 bytes can end in half an `ä`, which
  yields invalid UTF-8 in a file that Drey and git then handle. Cut at a rune
  boundary (or count runes).
- **R-18 `add` completeness.** Folded into R-02 (`add -F`, `--stage`,
  `--set`).

- **R-22 Empty lists are `[]`.** `dk ls --json` answers `"tickets": null` when
  nothing matches (Go nil slice); a stable JSON contract wants `[]` for every
  list field (found in E14-1, see [`v0.5-observations.md`](v0.5-observations.md)).
  Drey tolerates `null` today.
- **R-23 `dk version --json`.** The version is three text lines
  (`version: v0.5.0` / `commit:` / `date:`); a machine form
  (`{"tool_version","commit","date"}`) — or the `capabilities` of R-19 — would
  let Drey gate on features instead of parsing text. Drey parses
  `version: vX.Y.Z` today (E14-1).

- **R-26 Parallel reads.** Two or more `dk` read calls (`dk show`) at the same
  time against one store fail with `reset to local head: exit status 128`
  (git on the private working copy under `DK_DATA_DIR`; the calls refresh and
  reset the same copy). Found in E14-2 when the board read six tickets in
  parallel; serial reads are clean. A read-only command must be safe to run
  concurrently (a lock around the refresh that waits instead of failing, or
  reads that do not touch the working copy). Drey queues its reads one at a
  time until this is fixed (`createDricketStore`, `readConcurrency: 1`).
- **R-27 `dk init` and `[stages]`.** The `dricket.toml` that `dk init` writes
  carries `[transitions.agent]` with the built-in stage names; adding a
  `[stages]` table makes it invalid (`transitions.agent.in-progress: unknown
  stage`, every call then fails with `config-invalid`) until that table is
  deleted by hand. `dk init --stages a,b,c` (or an init that omits the legacy
  table) would give a valid store in one step. Drey's scratch stores strip the
  table in test setup.
- **Status 2026-11-05 (R-29, R-30, and R-26 below):** implemented in dricket and
  **released as v0.6.1** (2026-11-05, PR 24, CI green on Linux and Windows; the
  Windows build is installed here, the old one kept as `dk-0.6.0.exe`). dricket numbers its own requirements
  separately: there the trace is dricket R-26 and the reads are dricket R-27 (ADR-0014
  maps them), so ids in dricket's changelog differ from this file. Verified
  here on the 91-ticket store: `show` 16 -> 4 git processes, 0.39 -> 0.18 s;
  `ls --json` 107 -> 5, 2.4 -> 0.2 s; stdout of `show` and `ls` identical to
  v0.6.0; 8 parallel `show` calls 8 of 8 succeed (v0.6.0: 4 of 8 fail with exit
  128, which also closes R-26 in this file); dricket's `go test ./...` passes.
- **R-29 Trace.** `dk --trace` (or `DK_TRACE=1`) prints one line per step the
  call performs on stderr (or as JSON with `--json`): the step's name (config
  read, repo discovery, private-copy refresh, CAS attempt N, backoff wait,
  push, fast-forward of the checkout), its duration, and every git process it
  started with the arguments and run time, ending in a summary such as
  `git: 16 processes, 340 ms of 380 ms`. Git's own `GIT_TRACE2_EVENT` shows the
  git side only; it cannot say which dk step a process belongs to, nor how
  long dk itself works. Found in the E14-4 comparison
  (`docs/design/dricket/performance.md`).
- **R-30 Fewer git processes per command.** Measured on dk v0.6.0, Windows,
  local store (`GIT_TRACE2_EVENT`; a bare git call costs about 47 ms here, the
  same as an empty process, so the count is the cost):
  `dk show` starts 16 git processes, `dk ls --json` 107 (91 of them one
  `git show HEAD:<path>` per ticket). Of the 16 for `show`: five `rev-parse`
  that one call can answer (`--is-inside-work-tree`, `--show-toplevel` twice,
  `--is-bare-repository`, `--git-common-dir`); `check-ref-format --branch
  tickets` (a pure string check, no process needed); `status --porcelain`
  of the user checkout; and for the private working copy `rev-parse`,
  `worktree list`, `rev-parse`, `reset --hard`, `checkout --detach`, `clean
  -fdq` — every read refreshes the copy although it only needs one `git show
  <ref>:<path>`. Wanted: a read command costs the repo discovery (one
  `rev-parse` with several options), the config read, one `git show
  refs/heads/<branch>:<path>` and nothing else, no private working copy;
  `ls --json` reads all tickets in one batch (`git cat-file --batch` or
  `git archive`); `check-ref-format` in process. The private working copy is
  then needed by writes only, and a read that does not touch it also removes
  the cause of R-26. Writes may later move to plumbing (`hash-object`,
  `mktree`, `commit-tree`, `update-ref <ref> <new> <old>`), which is a larger
  change to be decided on its own. A go-git or libgit2 embedding was
  considered and not recommended: go-git does not read `~/.ssh/config`
  (aliases, `IdentityFile`, `ProxyJump`), so remote authentication would have
  to be rebuilt (not verified in this session, from knowledge of the library).
  Estimated effect (not measured): `show` from about 0.4 s to about 0.1 s,
  `ls` from about 2 s to well under 0.3 s.

## Questions (not defects)

| Id | Question | Why it matters | My suggestion |
|---|---|---|---|
| Q-01 | **Service account or own accounts?** (`integrations/drey.md` open hurdle) | Only one human uses Drey today. | One Git identity for the desk; the acting user/device goes into the owner id (`owner@ipad`) and the log, never into the pusher identity. Revisit when a second person joins; then own accounts for people, one profile per runner. |
| Q-02 | **Owner id grammar.** `identity()` lowercases `DK_OWNER`; comment filenames replace other characters with `-`; which characters does `lint` accept in `owner`? | Drey would use `owner@legion`, `ben.run-42`, `owner@ipad`. | Document and test the allowed set (`[a-z0-9._@-]`); reject the rest at the CLI. |
| Q-03 | **Waiting for a human inside a claim.** A run may wait days for an answer. Max lease L = 24 h, 3 extensions. | Drey's wait does not count as busy time today. | Release to `needs-input` and re-claim on answer (new epoch, 2 commits). Acceptable? Alternative: an `extend --until-answered` that parks the lease. |
| Q-04 | **Secret scan on whole-ticket writes** (exit 19 names pattern and line). Tickets carry pasted logs, diffs, tokens-as-examples. | A blocked `put` stops a run's hand-over. | Allow an allowlist in `dricket.toml` (patterns/paths) and let `put` return the finding without losing the text. Drey will surface exit 19 to the owner. |
| Q-05 | **Editing `dricket.toml` from a frontend.** It lives on protected `main` and is changed by PR only. Drey's Settings edits stages/priorities today. | The Settings column editor cannot "just save". | Read-only in Settings plus "open the file"; or `dk config set` for admins that makes a signed-off commit/PR (the owner is the admin). |
| Q-06 | **One ticket per commit** versus the plan release that mints N tickets and updates the parent. | Atomicity of "Approve plan". | Keep the invariant; Drey's release is resumable (children first, parent last). R-14 only if you want atomic. |
| Q-07 | **Cost of one `dk` call.** Each call starts a process that reads config from `main`, refreshes the head and runs several `git` subprocesses. Unmeasured. | A board refresh with N tickets and the fleet's writes. | Measured 2026-11-05 on Windows with 91 tickets: `show` 0.4 s (16 git processes), `ls` 2 s (107), `put --claim --if-version` 0.65 s, see `performance.md`; not measured at 1 000 tickets or with a remote. The cost is git process starts, which R-30 reduces; R-14 batch mode is not needed for Drey's reads (E14-4 reads files). |
| Q-08 | **Local store as the desk's default.** A local non-bare store needs no network and has no push failure mode. | Offline writing today works; a remote store needs the network for every write (non-goal in dricket: "no offline writing with later merge"). | Local store on the desk; add a remote only when a second machine joins; document the migration of an existing local store to a remote. |

## What I checked and found fine

- `claim`/`release`/`extend`/`comment`/`note` are idempotent where Drey's runner
  needs it (claim by the same owner: no commit; release of a free ticket:
  no-op) — a restart-safe runner is possible.
- Exit codes and the `{schema_version, data|error}` envelope are stable and
  documented; `--if-version` exists on `set`.
- Comments never touch `rev` or the exact edit base, so the owner can comment on
  a running ticket without disturbing the runner's pending edit — this is
  exactly the channel Drey wants for send-back notes and answers.
- Linear history and fast-forward-only CAS are compatible with Drey's
  "one commit per transition" culture; the spike (10 clones, 10 minutes, ~4.7 k
  commits/h, 0 invariant violations, claim p50 about 0.65 s, p95 about 4 s)
  says contention is not the risk — per-call latency and the narrow write
  surface are.

## Owner decisions of 2026-11-05 (answers to the open dricket questions)

Drey has one user, the owner; effort that only serves a second user is not spent.

- **R-28 / R-10 dropped as dricket work (done: E14-3b, Drey milestone 158).** The one-time migration writes the ticket files and
  their commits into the store directly with git (numbers and creation data preserved, no
  placeholders), then `dk validate` must pass. No `dk add --id`. Drey item: E14-3b is rewritten
  accordingly.
- **R-31 open.** Whether the same-stage release is a real problem is to be shown first: a failed
  run could write the ticket with `dk put --claim` without changing the stage instead of
  `dk release --stage`. Only if that is refused too does R-31 go to dricket.
- **Q-03 accepted:** a run that waits for an answer releases to `needs-input` and re-claims on
  the answer (new epoch).
- **Q-05 closed:** `dricket.toml` is edited by hand; Drey reads it and offers "open the file".
- **Q-04 not asked:** a secret-scan refusal (exit 19) is surfaced to the owner; no allowlist work
  until it actually happens.
- **Windows path length (found in E14-2/E14-4):** dricket sets `core.longpaths=true` on its git
  calls, or documents short store and data paths. Not a Drey fix.
- **R-27 wanted:** `dk init` writes a `dricket.toml` that stays valid with a custom `[stages]`, as
  the default configuration.
