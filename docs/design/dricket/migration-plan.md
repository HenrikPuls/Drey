# Tickets on dricket — migration plan

Status: analysis, proposed. Companion of [`fit-analysis.md`](fit-analysis.md),
[`engine-impact.md`](engine-impact.md) and
[`dricket-requirements.md`](dricket-requirements.md). Decisions the owner still
has to take are `OD-n` (list in §10); dricket prerequisites are `R-nn`.

## 1. Inventory of the real repo (read-only snapshot, 2026-11-04)

`E:\projects\drey-tickets` (branch `main`, the engine is running on it: the
snapshot moved while I looked — `T-0091` arrived in `prioritized`, `T-0030`
carries a live `run:` with a worktree `_worktrees/T-0030`, and several
`archive/*.md` files showed as modified in `git status`).

| Item | Count / fact |
|---|---|
| Phase folders present | `10-inbox` **25**, `20-prioritized` **2** (`T-0079`, `T-0091`), `50-build` 0, `60-commit` 0, `80-done` 0 |
| `archive/` | **64** tickets (`T-0001` ... `T-0086`, gaps) |
| Ticket files in total | **91** (my key-count script parsed 90 front matters; one file did not match its simple pattern — to be found by the dry-run, not guessed) |
| Largest files | `T-0048` 47.7 kB, `T-0084` 41.9 kB, `T-0049` 37.4 kB |
| `.status.log` files | **0** |
| Ledger | `_meta/ledger.jsonl`: 1 line |
| Chat sessions | 1 file in `_meta/chat/` |
| Personas | `build-default`, `commit-default` (each `persona.md` + `prompt.md`) |
| Prompts | 6 files in `_meta/prompts/` |
| `pipeline.md` | phases `inbox, prioritized, build (wip 3, claim, agent, persona), commit (agent, persona), done`; no `priorities:` list (default vocabulary) |
| Git history | **1 684 commits**, 3.3 MB `.git`; first commit 2026-10-17; **1 057** subjects are `T-N fleet run bookkeeping`, 83 `+ inbox`, 77 `archived`, 42 `refined`, the rest transitions |
| Front-matter keys in use (90 files) | `id`, `title`, `repo`, `rank`, `priority`, `branch` (all 90); `entered-*` (inbox 80, build 45, prioritized 43, done 39, commit 38, plan 27, plan-review 26, review 23); `blocked-by` 17; `worker` 7; `claimed-by`/`claimed-at` 4; `interactive` 3; `run` 2; `references` 1; `parked-*` 1 |
| Keys **not** used yet | `persona`, `awaiting`, `track`, `form`, `chain`, `proof`, `parent`, `repos` — the new Mission Control keys exist in the schema but not in the data, so the migration is easy today and gets harder with every week of E10/E13 use |
| Body sections in archived tickets | only 7 of 64 carry `## Verification` / `## Handover` / `## Changes`; none carries `## Verlauf` |
| Attachments | `10-inbox/attachments/` holds 2 images (a misplaced folder; the schema says `tickets/attachments/`); 2 tickets reference `attachments/` |
| Live blockers | `T-0017` has `blocked-by: [T-0049]` and `T-0049` is archived -> **dangling under dricket** |
| Local work branches in the Drey code repo | **18** `t/T-*` branches; in-flight worktrees under `_worktrees/` |
| Title length | at least one archived title (`T-0085`) exceeds dricket's 200-char title limit |
| Language of content | English and German (user data, stays as is) |

The numbers say: **the live data set is 27 tickets**, plus 64 finished ones.
Everything below is cheap to do now and expensive later.

## 2. Target layout

```
E:\projects\drey-board\            NEW dricket store (git repo; main + tickets branches)
  main:    dricket.toml, prefixes.toml (t), README.md, AGENTS.md, CLAUDE.md
  tickets: tickets/t/0000/t-63/ticket.md  ... comments/<ts>-<author>.md
  _worktrees/                       gitignored, beside the checkout (fleet worktrees)

E:\projects\drey-tickets\          EXISTING repo, role changes to META (tag pre-dricket first)
  tickets/_meta/{pipeline.md, repos.md, prompts/, personas/, chat/, ledger.jsonl}
  tickets/attachments/, tickets/videos/
  tickets/archive/                  legacy archive, read-only history (OD-7)
```

Rationale: dricket validates everything under `tickets/` on its branch;
meta cannot live there, and a repo cannot check out two branches in one working
tree (`engine-impact.md` §6). Two repos is the smallest model that works and it
keeps the legacy history reachable without importing it.

## 3. Conversion rules

Mechanical, idempotent, keyed by the legacy id. Body text is copied **byte for
byte** (including the legacy `## Log` lines); only the header is rewritten.

| Legacy | dricket | Rule |
|---|---|---|
| file `tickets/<NN-phase>/T-0063.md` | `tickets/t/0000/t-63/ticket.md` | id `T-0063` -> `t-63` (OD-1); number preserved |
| `id` | `id` | as above; `x-legacy-id: T-0063` kept for audit |
| `title` | `title` | unquoted; control characters stripped; > 200 chars: shortened and the full text prepended to `## Description` (report line) |
| (creation) | `created_at`, `created_by` | `entered-inbox` (else the first `## Log` stamp, else first commit date); first Log actor, else `owner`. Needs [R-10] to be written as such. |
| (none) | `schema_version: 1`, `rev`, `epoch`, `extensions`, `kind` | importer sets `rev: 1`, `epoch: 0`, `extensions: 0`; `kind: human` for tickets created by `owner@*`, `agent` otherwise |
| folder = phase | `stage` (+ `x-phase`) | variant **A** (preferred, [R-03] shipped): the stage is the phase id. Variant **B** (stopgap): `inbox`,`prioritized` -> `open`, `build` -> `in-progress`/`open`, `commit` -> `review`, `done` -> `done`, plus `x-phase: <id>` carrying the truth; the importer refuses variant B for `build` tickets with a live claim |
| `archive/` | `stage: done` or `cancelled` + label `archived` — or not migrated (OD-7) | recommendation: **not migrated** (old repo is the archive); 64 closed tickets would make every `dk ls` 3.4x larger for no daily value |
| `priority` | `priority` | `urgent, high, normal, low` configured in `dricket.toml`; unknown values -> default + report |
| `rank` | `x-rank` | |
| `branch` | `branch` | **unchanged `t/T-0063`**: Drey keeps display ids for branches and worktree folders, so the 18 existing local `t/T-*` branches and `_worktrees/T-0030` keep working with no rename |
| `repo`, `repos` | `repos` (primary first) | `repo` dropped when `repos` is written |
| `blocked-by: [T-0048]` | `depends: t-48` | ids converted; ids that do not exist in the migrated set are **removed** and recorded in a migration comment and `x-legacy-blocked-by` (the dangling rule, [R-12]) — e.g. `T-0017` |
| `entered-<phase>` | `x-entered-<phase>` | kept for migrated tickets only (history is cut); later `dk log` replaces them |
| `claimed-by`, `claimed-at`, `run`, `interactive`, `parked-*` | not migrated | the cut-over requires no live runs (§7); `parked-*` -> `stage: blocked` + a comment, if present |
| `worker`, `persona`, `track`, `form`, `chain`, `proof`, `awaiting`, `references` | `x-worker`, `x-persona`, ... | raw values; `chain` and `references` as one-line strings (`;` and `,` separated) |
| `<id>.status.log` | comments from the runner identity | none exist today |
| `_meta/*`, attachments, videos | stay in the old repo | unchanged; link rewrite `../attachments/x.png` -> `attachments/x.png` in migrated bodies (2 files) |
| commit history | cut | `x-legacy-commit: <sha>` = last commit that touched the file in the old repo |

Config produced on `main`: `dricket.toml` (lease defaults, `max_extensions`,
`[priorities]` as above, `[security] admins = ["owner@legion"]`, quota **0**
for the import then 50 afterwards, `secret_scan = true`), `prefixes.toml`
with `t`. With [R-03]: `[stages]` with the phase ids.

## 4. History: cut, deliberately

`dk validate` replays the complete branch history (rev +1 per ticket write, one
ticket per commit, epochs, add-only comments, no foreign paths). Drey's
1 684 commits would fail every rule. Importing them as dricket history is not an
option; so:

- the new `tickets` branch starts with the migrated snapshot;
- the old repo gets the tag `pre-dricket` and stays the readable record
  ("how did this ticket get here" before the cut-over: `git log --follow` in
  the old repo; the migrated ticket carries `x-legacy-commit`);
- `entered-*` stamps and the legacy `## Log` lines survive inside the ticket,
  so the story card ("How it got here") still reads a full story;
- the estimate history (E11-4, reads every `## Verlauf`) loses nothing because
  none exists yet.

## 5. Dry run, verification, rollback

**Dry run** (`migrate --dry-run`, E14-3): reads the legacy repo (read-only,
no lock, works on a `git clone` of it), writes into a **scratch** dricket store
in the scratchpad (`dk init`, local mode, quota 0), and prints a report: per
ticket the mapped fields, dropped fields, warnings (title shortened, dangling
dependency removed, unknown key kept as `x-`), counts per phase, and the
files it could not parse (the 91-vs-90 file above). Then:

1. `dk validate` on the scratch store must exit 0;
2. the Drey validator (domain checks) over the converted tickets: same issue
   set as over the legacy tickets, minus the declared differences;
3. **shadow diff**: assemble the board from the legacy repo and from the
   scratch store with the same engine code (two `TicketStore` implementations)
   and compare: tickets per phase, titles, priorities, blocked/blocks sets,
   derived order of each column. Must be identical except the declared diffs
   (dangling blockers, archive).
4. **round trip**: legacy -> dricket -> reverse converter -> legacy' must equal
   the legacy board (the reverse converter doubles as the rollback tool,
   §7).

**Rollback** has three levels, in increasing cost:

1. *Before the cut-over*: delete the scratch store. Nothing else was touched.
2. *At the cut-over, within the freeze*: flip `tickets.backend` back to
   `files`. The legacy repo was not modified except for the `pre-dricket` tag.
3. *After the cut-over (tickets created or changed in dricket)*: run the
   reverse converter on the dricket store into the legacy layout of a
   **fresh clone** of the old repo, review the diff, adopt. Tickets created
   after the cut-over come back with ids above the legacy maximum (the number
   space is shared, `t-NN` <-> `T-00NN`). Anything the legacy format cannot
   express (comments) is appended to the ticket's `## Log` as one line each.

The importer never deletes in the legacy repo, never force-pushes, and refuses
to run while the engine has a live run or the ticket checkout is dirty.

## 6. Keeping Mission Control usable during the cut-over

Principle: **one source of truth at any time**; no dual writes (that is the
failure mode that defeats the purpose). The seam is the `TicketStore` port
(`engine-impact.md` §1) with a per-engine config `tickets.backend`:

| Mode | Reads | Writes | Used for |
|---|---|---|---|
| `files` (today) | legacy files | legacy files | production until E14-7 |
| `shadow` | legacy files, **plus** a dricket scratch store read in the background | legacy | E14-2/3: diff reports, no user impact |
| `dricket` | dricket | dricket | scratch store in a second instance from E14-4 on; production from E14-7 |

Practical rig for testing without touching the live system: a **second engine
instance** (`dev.ps1 -Built -Multi`, its own `USERPROFILE`/userData — see the
memory note that e2e adopts the live engine if not isolated) pointed at a
**scratch dricket store built from a copy of the board**. Mission Control
pairs with either engine; the phone talks to the live one until the cut-over.
Because the DTOs, the SSE events and the display id `T-0063` do not change,
the app needs no feature flag of its own.

## 7. Cut-over day (E14-7), as a checklist

1. Chain master "halted"; wait for all live runs to settle (today `T-0030` is
   running — the cut-over waits). Quit the engine and Drey.
2. Tag `pre-dricket` in the old repo; `git status` clean there.
3. Final import (idempotent): `migrate --apply` into the real store
   `E:\projects\drey-board` with quota 0, then set the production
   `dricket.toml` through a PR on `main`.
4. `dk validate`, shadow diff, round trip — all green or stop.
5. Set `tickets.backend=dricket` and the store/meta paths; start the engine.
6. Smoke on the real rig: board loads; open a ticket; edit and save a body;
   capture a ticket; move it; start a run on a throw-away ticket in a scratch
   work repo; stop it; check the claim/epoch/lease, the ledger and the
   Verlauf; pair the phone.
7. Keep the legacy checkout read-only on disk for 30 days; delete the
   `files` backend code only in E14-9.

## 8. Staged work (proposed roadmap items)

Ids: E14-n ("Tickets on dricket"). Each step is shippable on its own behind
`tickets.backend` (default stays `files` until E14-7). "dk vX" is the dricket
release that carries the prerequisite; dricket work is the owner's own and is
listed in `dricket-requirements.md`, not here.

| Id | Scope | Needs | Parallel with | Session | Tests | Real-run check |
|---|---|---|---|---|---|---|
| **E14-0** | dricket releases: **v0.6 read contract** (R-05, R-06, R-08, R-19: full `ls`/`show` JSON, comments list, capabilities/schema), **v0.7 write contract** (R-01, R-02, R-03, R-04), **v0.8** (R-10 import, R-09 changes, R-07 log, R-13 Windows CI, R-12) | owner (dricket repo) | everything in Drey | dricket sessions | dricket's own gate + Windows CI job | `dk` binary on the owner's Windows machine |
| **E14-1** | `TicketStore` port; `FileTicketStore` wrapper (no behaviour change); `DricketTicketStore` for `list/read/claim/release`; `dk-process` (queue, exit-code table, version gate); `ids.ts`; flat parser; setting `tickets.backend` + paths; **contract test suite against a scratch store**; the **first slice** (§9) | dk v0.5 as is | E14-0 | 1 session (engine) | contract tests snapshot real `dk --json` output; unit tests for exit-code mapping, id mapping, flat parser incl. `title: a: b`; existing suites unchanged | scratch store: list/show/claim/release from a CLI probe and from the Work panel (read-only) |
| **E14-2** | Board assembly from the store: `ticket-board` takes `TicketRecord[]`; stage/phase mapping (variant A or B); derived order with `x-rank`/`x-entered-*`; derived blocked from `depends`; `shadow` mode with diff report | E14-1; dk v0.6 for full `ls` | E14-3, E14-5 | 1 session (core) | board snapshots equal between backends on the migrated fixture; perf test at 500 tickets | live board next to the shadow report on a copy |
| **E14-3** | `migrate` tool: dry-run, apply, report, shadow diff, **reverse converter**; fixtures from the real repo (copied, scrubbed) | E14-1 (store), dk v0.8 R-10 for apply | E14-2, E14-5 | 1 session (tools) | converter table tests; validate/round-trip tests; "no live run" guard | dry run on a clone of `drey-tickets`; the report reviewed by the owner |
| **E14-4** | Write path through `TicketStore`: capture/create, refine, header edits (priority, blocked-by, chain, track, ...), moves, accept/send back/archive (label), `ticketSave` with `rev`, parts edit/release (children first, parent last, resumable), flow save; editor save hook ([R-02]) | E14-2; dk v0.7 | E14-6 | 1 session | board-service specs run against both stores; conflict (exit 12) paths; release is resumable after a mid-way failure | second instance on the scratch store: edit a ticket in the editor, phone refine, drag a card |
| **E14-5** | Fleet on `dk`: claim before worker spawn, extend, release with stage/message, exit 13 = stop the worker, takeover, `needs-input` release/re-claim, breaker park = `blocked` + comment, optional `Dricket-*` trailers and `dk validate --trailers` in the commit step; runner writes `## Verlauf`/`## Handover`/`## Verification` inside its claim via `sync`/`commit` | E14-1; v0.5 suffices for claim/release/commit | E14-2, E14-3 | 1 session (fleet) | runs.spec/orchestrator.spec with a fake store; fencing test (two runs, one ticket); lease-expiry takeover | a real run on a throw-away ticket in a scratch work repo, killed with SIGKILL, taken over after lease (shortened `dricket.toml` for the test) |
| **E14-6** | Comments and signals: send-back note and Needs-you answers as comments; keyed status verbs as comments; `needs.ts` reads them; `working:` ephemeral; ledger relocated to meta; story builder reads both Log shapes | E14-4; dk v0.6 R-08 | E14-8 | 1 session | status/needs parity spec (same Needs-you list from either source) | answer a `needs-decision` from the phone |
| **E14-8** | Change detection: `dk changes` poll in the engine (or the `ls-remote` recipe), announce own writes, watcher exclusion/plugin-managed registration, Source-control guard | E14-1; dk v0.8 R-09 for the efficient form | E14-4, E14-6 | 1 session | poll spec with fake clock; announce spec | change a ticket from a second clone; board refreshes within the interval |
| **E14-7** | Cut-over (§7): freeze, final import, flip, smoke; owner round | E14-3, 4, 5, 6, 8; dk v0.8 | — | the owner + 1 session | the full release gate (`npm run test:all`) + e2e on the scratch rig | §7 smoke on the real rig |
| **E14-9** | Decommission: delete `FileTicketStore` write paths, normalize, phase-dirs, status-log files, `run:` stamping, folder settings; supersede `ticket-schema.md` parts; manual; remove the legacy phone remote | E14-7 + 30 days | — | 1 session | gate | — |

Parallelism: after E14-1 three sessions run in disjoint files — **E14-2**
(`core/ticket-board`, `ticket-files`), **E14-3** (`migrate/`, new), **E14-5**
(`fleet/runs.ts`, `orchestrator.ts`). **E14-8** can run any time after E14-1.
E14-4 is the only item that touches `board-service.ts` heavily; it must not
run next to another change to that file.

## 9. The first thin vertical slice (E14-1)

Smallest end-to-end path that proves the seam, needs **only dk v0.5**:

1. `ports/ticket-store.ts` with `list`, `read`, `claim`, `release`.
2. `DricketTicketStore` spawning `dk ls --json`, `dk show <id> --json`,
   `dk claim <id> --size S --json` (env `DK_OWNER=ben.slice-1`,
   `DK_DATA_DIR` scratch), `dk release <id> --stage review -m ... --json`;
   envelope decode; exit-code -> error kind table (11 "already taken by X",
   12 "changed in the meantime", 13 "claim lost", 14 "not allowed",
   15 "store unreachable", 16 "dk too old"); id mapping `t-63` <-> `T-0063`.
3. A scratch store built by the test (`dk init <tmp> t`, `dk add -m ... --unclaimed`
   x3).
4. A CLI probe `scripts/dricket-slice.mjs` and a contract spec that run:
   list -> show one -> claim -> show (owner, epoch 1, lease) -> second claimant
   gets exit 11 -> release to `review` -> show (stage `review`, epoch 1, rev
   increased) -> comment -> list. Output is snapshotted: that **captures the
   real JSON** this analysis could not.
5. With `tickets.backend=dricket` and the scratch path, the Work panel lists
   the scratch tickets read-only (using the flat parser), with the display id.

Done when the contract suite is green on Windows, a second instance shows the
three scratch tickets, and the live board is untouched.

## 10. Decisions needed from the owner

| Id | Question | Recommendation |
|---|---|---|
| OD-1 | Prefix? | `t`, numbers preserved: `T-0063` <-> `t-63`; Drey shows `T-0063`; branches and worktree folders keep `t/T-0063`. |
| OD-2 | History? | Cut; tag `pre-dricket`; old repo is the archive. |
| OD-3 | Accounts? | One Git account for the owner's desk; actor in `DK_OWNER` (`owner@legion`, `ben.run-42`, `owner@ipad`). No service account until a second human exists. |
| OD-4 | Stage vocabulary? | `[stages]` in `dricket.toml` (R-03). Interim `x-phase` only for the first slices. |
| OD-5 | Repo split? | New `drey-board` store; existing repo becomes meta. |
| OD-6 | What must dricket ship before E14-4 starts? | v0.7 (R-01, R-02, R-03, R-04). Anything less means building four-commit stopgaps. |
| OD-7 | Archive? | Not migrated. |
| OD-8 | Store mode? | Local store first (no remote, fastest, no network failure mode), add a remote when a second machine joins. |
| OD-9 | Bundling `dk` in the Drey installer | You are the copyright holder of both; GPL obliges you to offer dk's source with the binary. Either bundle plus source offer, or require `dk` on `PATH` and pin `min_version`. Recommendation: bundle a pinned `dk`, ship the source link in About. |
