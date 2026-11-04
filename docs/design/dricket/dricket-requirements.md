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
| R-11 | Per-ticket attachments | Nice |
| R-14 | Batch mode (one process, many operations) and multi-ticket commits | Nice |
| R-16 | Hook / pre-receive template to refuse non-`dk` commits | Nice |
| R-17 | Byte-limit truncation cuts UTF-8 | Nice (bug) |
| R-18 | `add` options for a complete first write | Nice (covered by R-02) |
| R-22 | `ls --json` answers `null` for an empty list | Nice (found in E14-1) |
| R-23 | `dk version --json` (machine-readable version) | Nice (found in E14-1) |
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

## Questions (not defects)

| Id | Question | Why it matters | My suggestion |
|---|---|---|---|
| Q-01 | **Service account or own accounts?** (`integrations/drey.md` open hurdle) | Only one human uses Drey today. | One Git identity for the desk; the acting user/device goes into the owner id (`owner@ipad`) and the log, never into the pusher identity. Revisit when a second person joins; then own accounts for people, one profile per runner. |
| Q-02 | **Owner id grammar.** `identity()` lowercases `DK_OWNER`; comment filenames replace other characters with `-`; which characters does `lint` accept in `owner`? | Drey would use `owner@legion`, `ben.run-42`, `owner@ipad`. | Document and test the allowed set (`[a-z0-9._@-]`); reject the rest at the CLI. |
| Q-03 | **Waiting for a human inside a claim.** A run may wait days for an answer. Max lease L = 24 h, 3 extensions. | Drey's wait does not count as busy time today. | Release to `needs-input` and re-claim on answer (new epoch, 2 commits). Acceptable? Alternative: an `extend --until-answered` that parks the lease. |
| Q-04 | **Secret scan on whole-ticket writes** (exit 19 names pattern and line). Tickets carry pasted logs, diffs, tokens-as-examples. | A blocked `put` stops a run's hand-over. | Allow an allowlist in `dricket.toml` (patterns/paths) and let `put` return the finding without losing the text. Drey will surface exit 19 to the owner. |
| Q-05 | **Editing `dricket.toml` from a frontend.** It lives on protected `main` and is changed by PR only. Drey's Settings edits stages/priorities today. | The Settings column editor cannot "just save". | Read-only in Settings plus "open the file"; or `dk config set` for admins that makes a signed-off commit/PR (the owner is the admin). |
| Q-06 | **One ticket per commit** versus the plan release that mints N tickets and updates the parent. | Atomicity of "Approve plan". | Keep the invariant; Drey's release is resumable (children first, parent last). R-14 only if you want atomic. |
| Q-07 | **Cost of one `dk` call.** Each call starts a process that reads config from `main`, refreshes the head and runs several `git` subprocesses. Unmeasured. | A board refresh with N tickets and the fleet's writes. | Measure `ls`, `show`, `claim`, `put` on Windows with 100 and 1 000 tickets; decide on R-14 batch mode from the numbers. |
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
