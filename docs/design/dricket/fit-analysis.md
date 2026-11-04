# Tickets on dricket — fit analysis

Status: analysis, proposed (owner request 2026-11-04). Documentation only.
Companion files: [`engine-impact.md`](engine-impact.md),
[`migration-plan.md`](migration-plan.md),
[`dricket-requirements.md`](dricket-requirements.md),
[ADR-0090](../../09_architecture_decisions/0090-tickets-on-dricket.md).

## 0. Scope, sources, and what was not verified

The owner decided to move Drey's whole ticket handling, the fleet included,
onto **dricket** (`dk`, Go, GPL-3.0-or-later, v0.5.0, commit `d28181b`).
Drey calls `dk ... --json` as a separate process; it does not re-implement
dricket. Gaps in dricket are requirements for dricket
([`dricket-requirements.md`](dricket-requirements.md)), not Drey workarounds.

**Read for this analysis**

- dricket: `README.md`, `docs/CONCEPT.md`, `docs/protocol.md`,
  `docs/architecture.md`, `docs/integrations/drey.md`, `docs/SPIKE.md`,
  `CLAUDE.md`, `CHANGELOG.md`, `specs/*`, ADR-0005/0009/0010 in full, the
  others by their protocol/concept summary, `skills/dricket/SKILL.md`, and the
  Go sources that define the JSON contracts and write paths
  (`cmd/dk/main.go`, `commands.go`, `internal/ticket/ticket.go`,
  `internal/service/{commands,queries,commit,next,leases}.go`,
  `internal/store/store.go` read paths, `internal/validate/validate.go` path
  rules, `internal/frontmatter`).
- Drey: `specs/ticket-schema.md` (layout, fields, body sections, ledger,
  status log, pipeline, validation, normalization), ADR-0075/0076/0077 (decision
  parts), the `packages/tickets-engine/src` module map, the remote protocol
  port (`contracts/remote-protocol.ts`), the transition machine, the roadmap
  and changelog headers, `libs/mission-ui` DTO parsing of `## Verlauf`.
- The real tickets repo `E:\projects\drey-tickets`, read-only (file listing,
  `git log`, reading five ticket files). Nothing was written there.

**Not done / inferred — say it plainly**

- `dk` was **not built or run**. Go 1.27 is installed, but the one build
  attempt was denied by the session's permission classifier, and it was not
  retried by another route. Every statement about `dk` behaviour is from
  reading the source and docs; JSON shapes come from the Go structs, not from
  captured output. The first slice (E14-1 in the migration plan) therefore
  starts with a contract test that captures real output.
- dricket CI runs on Linux and macOS; Windows binaries ship "without a
  behaviour guarantee" (`docs/architecture.md` §2). The spike ran on
  Windows 11, one machine. Windows behaviour of the local-ref CAS (ADR-0010)
  is unproven beyond that.
- I did not read all of the 32 k lines of `packages/tickets-engine`. The module
  map and the write paths (`transition.ts`, `tickets-git.ts`,
  `ticket-files.ts`, `board-service.ts` entry points, `remote-protocol.ts`)
  were read; fleet internals (`runs.ts`, `orchestrator.ts`) were read through
  their ADRs, exports and the claim/takeover call sites. Where a statement
  about them is inferred it says so.
- Reading ticket files directly from the checkout: dricket's protocol never
  forbids it (the checkout is the documented place where people edit tickets,
  ADR-0009), but it also never promises it. `dk show` reads `git show
  <head>:<path>`, **not** the working tree. Treat the checkout as a cache that
  can be dirty or stale; see `engine-impact.md` §4.

## 1. The two models in one page

| | Drey today (ADR-0075/0076/0077) | dricket v0.5 |
|---|---|---|
| Unit | `tickets/<NN-phase>/T-0042.md` (+ `<id>.status.log`) | `tickets/<prefix>/<shard>/<id>/ticket.md` + `comments/*.md` |
| Workflow position | the **directory** (phase), configurable per vault in `_meta/pipeline.md` | front-matter `stage`, a **fixed enum** of seven values |
| Identity | `T-0042`, minted max+1, 4+ digits | `prefix-N`, lower case, max+1 inside the CAS |
| Front matter | YAML (`yaml` package): quoted dates, flow lists, nested `run:` map | **flat** `key: value`, one line, no nesting, no multi-line, raw values |
| Body | free chapters (`## Description`, `## Plan`, `## Handover`, `## Verification`, `## Verlauf`, `## Log`, ...) | three headings (`Description`, `Result`, `Log`); more text is allowed |
| Claim | `claimed-by`/`claimed-at` stamped on entering a claim phase; takeover = overwrite; push is the CAS | `owner`, `lease_until`, `epoch`, `rev`; claim by fast-forward CAS; lease by size, takeover after lease + 20 min grace |
| Writer | single writer: Drey's board/engine and the fleet runner; agents never write the repo | every claim holder edits the whole ticket through `dk`; other people comment |
| Commit rule | one commit per transition, message `tickets: <id> <from> -> <to>` | one commit per write, one ticket per commit (replay-validated) |
| Order | derived: priority, `rank`, `entered-<phase>`, id (+ retired pins) | `next`: priority (config order), then lowest number; no rank |
| Validation | one deterministic validator, runs at render and before every fleet action | `lint` before each write, `validate` replays the **entire** history |
| History | git history is the timeline; `entered-*` stamps and `## Log` | git history; `rev` +1 per write; `## Log` lines written by the tool |
| Remote | optional `push:` after each transition; failure is a warning | remote or local store; write publishes by fast-forward push or local ref CAS; exit 15 on failure |
| Config | `_meta/pipeline.md`, `repos.md`, personas, prompts, chat, ledger inside the vault | `dricket.toml` + `prefixes.toml` on protected `main`; admins edit by PR; never through `dk` |

Two structural facts drive almost everything below:

1. **dricket owns the whole `tickets/` tree of the `tickets` branch.**
   `dk validate` reports any file under `tickets/` that is not `ticket.md` or a
   comment as `unexpected-path`, and the history replay reports commits that
   touch other paths. Drey's `tickets/_meta/` (pipeline, personas, prompts,
   chat sessions, repos, ledger), `attachments/`, `videos/` and
   `<id>.status.log` cannot live there.
2. **dricket's write surface is narrow.** After creation, a ticket changes by
   `claim`, `release --stage`, `extend`, `note`, `set` (eight named free fields,
   rejected if someone else holds the claim), `comment`, and whole-ticket
   `commit` (claim holder only, needs a checkout). There is no command that
   changes the **stage of an unclaimed ticket**, writes a **body section**, or
   sets a **non-listed field** without holding the claim. Drey's owner does all
   three constantly.

## 2. Concept-by-concept mapping

Legend: **SAME** equivalent; **DK** dricket covers it, Drey drops its own;
**KEEP** Drey keeps it, dricket has no opinion; **CONFLICT** the models
disagree and a decision is needed; **GAP** dricket lacks something Drey needs
(a requirement, id in brackets refers to `dricket-requirements.md`).

### 2.1 Identity, paths, format

| # | Concept | Drey | dricket | Verdict | Notes |
|---|---|---|---|---|---|
| 1 | Ticket id | `T-0063` | `prefix-N` | **CONFLICT -> decided by a pure function** | Prefix `t`, number preserved: `T-0063` <-> `t-63`. Zero-padding is a Drey display rule only (dricket allocates `%s-%d`, unpadded). No id map table needed. Owner decision Q1. |
| 2 | Id minting | max over all phase folders + 1; gaps never reused | max in the prefix + 1 inside the CAS; gaps allowed | **DK** | Better: allocation races resolved by CAS. Drey's "re-mint on merge conflict" rule disappears. Migration needs an explicit-number import ([R-10]). |
| 3 | Path | `tickets/NN-phase/T-0042.md`, moves on transitions | `tickets/<prefix>/<shard N/1000>/<id>/ticket.md`, **never moves** | **CONFLICT** | Every Drey reader that globs phase folders, the Files panel move semantics, `normalize.ts`, `phase-dirs.ts`, `archive/`, and the `../attachments/...` relative links die. Stable paths are a gain (links, history `--follow`). |
| 4 | Phase as folder | the directory *is* the phase; a file move is a ticket move (T-0041) | the stage is a front-matter value; "Move ticket files between stage folders" is in dricket's *decisions against* list (2026-11-02) | **CONFLICT, dricket wins** | Drey drops "a file move is a ticket move" and the stateless drift pass. |
| 5 | Front-matter syntax | YAML via `yaml`: quoted timestamps, `[a, b]` flow lists, `run:` map | flat `key: value`, raw text, lists = comma-separated, no nesting | **CONFLICT** | Drey readers must switch to a small flat parser. A title like `Fix: the race` is valid dricket (split at first colon) but invalid YAML; the two parsers disagree. Nested `run:` has no home -> it disappears (the claim replaces it). |
| 6 | Unknown keys | preserved on rewrite, reported as noise | preserved by tool writes, warning in lint | **SAME** | But dricket only lets `dk set` touch eight named keys; all others are writable only via whole-ticket `commit` while holding the claim [R-01]. |
| 7 | Timestamps | UTC, seconds, quoted `'...Z'` | RFC 3339 UTC, raw | **SAME** (drop the quotes) | Drey's "quote dates" rule exists for YAML; flat files do not need it. |
| 8 | Line endings | LF, UTF-8 | `.gitattributes` normalises; CRLF checkouts are a Windows concern | **SAME** | Memory note: fresh worktrees check out CRLF; dricket scaffolds a `.gitattributes`. |
| 9 | Size limits | none (tickets up to 47 kB in the real repo) | title 200, body/comment/note 100 000 chars | **SAME** | No real ticket exceeds the limit; keep as a lint. |

### 2.2 Frontmatter keys (Drey key -> dricket field)

| Drey key | Meaning | dricket mapping | Verdict |
|---|---|---|---|
| `id` | identity | `id` (= path) | **DK** |
| `title` | one line | `title` (200 chars) | **DK** (`set title=` works) |
| `repo`, `repos` | primary / all work repos | dricket has `repos` (free, comma list) and `touches`; no primary | **DK partially**: `repos` first entry = primary; `repo` is dropped. Matches Drey's own "list is the truth" rule. |
| `priority` | one word of the vault vocabulary | `priority` from `[priorities].values` (config order = weight) | **DK**: configure `urgent, high, normal, low`; default `normal` (Drey's middle entry rule becomes dricket's explicit `default`). Jump class split (`floor(len/2)`) stays in Drey. |
| `rank` | fine order, default 5000 | none; `next` orders by priority then number | **GAP** [R-01]: store as extension field `x-rank` (Drey order logic stays in Drey). |
| `branch` | `t/<id>` rule, cross-validated | `branch` (free; validated as a git ref) | **SAME**; Drey rule `t/<id>` becomes `t/t-63`. Existing 18 local `t/T-*` branches in the Drey repo keep their name via the field (see migration). |
| `entered-<phase>` | one stamp per phase ever entered | none | **GAP** [R-07]: needs a stage-history read (`dk log`) or extension keys written at each move. Used by order, ages, the story ("How it got here"), normalization, estimate. |
| `claimed-by` / `claimed-at` | owner of a claim | `owner`, `claimed_at` (+ `lease_until`, `epoch`, `size`) | **DK** (richer). Owner id grammar: lower case; `owner@ipad`, `ben.run-42` are acceptable [Q-02 to confirm]. |
| `run` (`pid`, `started-at`, `stream`) | live run | no equivalent | **KEEP, machine-local**: the run table belongs to the runner process, not the repo (the stream file is already machine-local). The claim (`owner`, `epoch`, `lease_until`) replaces `run:` as the cross-machine "somebody is working on it". |
| `worker`, `persona`, `track`, `form`, `proof`, `awaiting`, `interactive`, `chain` | Drey routing/flow pins | unknown keys | **KEEP** as extension fields; **GAP** [R-01] for `dk set`. `chain:` holds entries containing commas and `;`: store the raw string with `;` separation (a single flat value; Drey already splits on `;`). `interactive`/`awaiting` are transient: `awaiting` becomes stage `needs-input` + comment; `interactive` becomes the claim itself (the dialog run holds a claim as kind `human`). |
| `parent` | part-of | `parent` (hierarchy only, never blocks) | **SAME** |
| `blocked-by` | dependency, derived blocked | `depends` (scheduling; `next` requires every dependency `done`/`cancelled`) | **DK**, with a **semantic conflict**: Drey says a dependency that no longer exists on the board (archived, deleted, typo) does *not* block (owner decision 2026-10-31); dricket treats a dangling reference as a `validate` error and `next` treats an unknown dependency as not satisfied. See [R-12] and the migration step that drops dangling ids. |
| `references` | ids, URLs, paths | none | **KEEP** extension field (comma list). |
| `parked-reason` / `parked-at` | circuit-breaker park | `blocked`/`needs-input` stage + comment/log | **DK partially**: park = stage `blocked` plus a machine comment; the "revived by re-prioritising" rule stays in Drey. |
| `kind` | (n/a) | `agent` \| `human` | new; Drey sets `human` for owner/phone actions, `agent` for runs. |
| `size`, `lease_until`, `epoch`, `rev`, `extensions` | (n/a) | claim/lease state | new; `rev` is the version token for optimistic edits (`--if-version`) and replaces Drey's `baseRevision` file hash on `ticketSave`. |
| `labels`, `touches` | (n/a) | free | unused at first; labels could carry `scout`/`ship` form. |

### 2.3 Body sections

dricket's body is `## Description`, `## Result`, `## Log`, written by the tool
at `add`; the rest is free text and survives `commit`. Drey's chapters map as:

| Drey chapter | Written by | In dricket | Verdict |
|---|---|---|---|
| `## Description`, `## Plan`, `### Acceptance criteria`, `### Parts` | owner, Paul, shape dialog | free body text | **KEEP**; writes need a body-capable command [R-02]. |
| `## Handover`, `## Changes`, `## Report` | worker at end of step | free body text, written by the runner **while it holds the claim** (this is dricket's native flow: claim -> sync -> edit -> commit) | **KEEP**, fits. |
| `## Verification` | engine verify step | same | **KEEP**, fits (runner holds the claim during verify). |
| `## Verlauf` (yaml box per run: phase, persona, model, tokens, cost, dauer, ausgang) | engine at run settle | same; the section name and keys `dauer`/`ausgang` are file-format identifiers and stay | **KEEP**; cost is Drey data, not a dricket field. |
| `## Result` | commit step, free text | dricket's `release -m` **replaces the `## Result` section** (`setResult`) | **CONFLICT (soft)**: two writers for one chapter. Rule: only `dk release -m` writes `## Result`; Drey's commit step passes its report as the release message. |
| `## Log` | machine lines `- 'ts' who — text` | tool lines `- <ts> <actor> <event>` | **CONFLICT (soft)**: two line shapes in one chapter. Drey's readers (story builder, drift pass) must read both; Drey stops writing `## Log` lines itself (dricket logs every claim/release/set/note). |

### 2.4 Workflow: phases, stages, transitions

| # | Concept | Drey | dricket | Verdict |
|---|---|---|---|---|
| 10 | Workflow vocabulary | configurable phases: default `inbox, prioritized, build, commit, done` (+ legacy `plan, plan-review, review`), per-phase `handover`, `wip`, `claim`, `persona`, `ci`, ... | fixed enum `open, in-progress, review, done, blocked, needs-input, cancelled` | **CONFLICT, blocks** [R-03]. Options: (a) dricket gains a configurable ordered stage list in `dricket.toml`; (b) Drey keeps the phase as an extension field `x-phase` and uses dricket stages only for coordination. Recommendation: (a). (b) works but doubles state: stage and phase can disagree, and every human move is two writes. |
| 11 | Human move between phases | drag, menu, file move; free, logged | **no command** changes the stage of an unclaimed ticket; `set` rejects `stage` (State class); only a claim holder moves via `release --stage` or `commit` | **GAP, blocks** [R-04] `dk move`. A claim + release round trip is two commits and burns an epoch per drag. |
| 12 | Machine move on success | runner moves the ticket one phase right | `dk release <id> --stage <target> -m ...` | **DK** |
| 13 | One commit per transition | `tickets: <id> <from> -> <to>` | one commit per write, message `dricket: <verb> <id>` | **SAME rule, different messages**. Everything that greps Drey's commit messages (agent history views, estimate) moves to `rev`/`dk log` [R-07]. |
| 14 | Lane rules (agents don't pull across manual columns; backward moves are human) | runner policy | `[transitions.agent]` table (legacy command policy, *not* an integrity rule) | **KEEP** in Drey's dispatcher; dricket's table is not enforced by `commit`. |
| 15 | Archive | reserved folder, `— archived` marker, no `entered-archive` | none; "tickets are never deleted; discarding is `cancelled`" | **CONFLICT**: no archive concept. `done` stays forever in `ls`. Drey needs a list filter/label. Proposal: label `archived` plus `ls --label`/`--not-label` [R-05]; or the archive stays in the old repo (migration). |
| 16 | Drift/normalization | stateless pass completes a hand move | irrelevant: stages cannot be moved by moving files; `dk validate` flags direct edits | **DK** (deleted from Drey). |
| 17 | WIP limits, `claim: true` phases, circuit breaker | pipeline config | none | **KEEP** (dispatcher). |
| 18 | `order.md` pins | retired (req-75 W1) | none | n/a |

### 2.5 Claims, leases, epochs, fleet

| # | Concept | Drey runner | dricket | Verdict |
|---|---|---|---|---|
| 19 | Claim | stamp on entering `build`; push = CAS (rare: single local runner) | `dk claim <id> --size S\|M\|L`, idempotent for the same owner, exit 11 if taken | **DK** |
| 20 | Takeover | overwrite `claimed-by`, log old value (`setClaim`); lease reaper in the runner stops runs over `max-work`/`max-turns` | takeover after `lease_until` + 20 min grace by a new claim; `epoch`+1 | **DK**: fencing replaces the reaper's bookkeeping. The reaper itself (stopping the *process*) stays in Drey. |
| 21 | Lease length | none on the ticket; run ceilings 250 turns / 90 min | S 2 h, M 8 h, L 24 h; max 3 `extend` with a mandatory reason | **SAME in effect**: runner claims `S`/`M`; `extend` per hour is unnecessary below 2 h. A wait for the owner (days) must **release to `needs-input`**, not hold a lease [Q-03]. |
| 22 | Fencing | none | `epoch`; stale writer gets exit 13 and must stop | **DK**, new safety; the runner stops its worker on exit 13. |
| 23 | Epoch on code commits | none | trailers `Dricket-Ticket/-Epoch/-Op/-Actor`; `dk validate --trailers <range>` as merge gate | **DK, optional**: the runner's `t/<id>` commits can carry trailers; advisory without a host gate (dricket's own caveat). |
| 24 | Run identity | persona + provider session | `DK_OWNER` unique per process, e.g. `ben.run-42` | **DK**; the persona is Drey data (`x-persona`). |
| 25 | Who may write tickets | Drey/runner only; agents physically cannot | any claim holder, trusted collaborators | **CONFLICT of philosophy, resolved by wrapper**: the runner is the only caller of `dk`; worker processes never get `dk` or credentials. Drey keeps ADR-0076's single-writer rule. |
| 26 | Selection of the next ticket | dispatcher: priority class, column rank, derived order, pools, personas, pause, budgets, blocked | `dk next [--claim]`: priority then number; free+open or expired; deps done | **KEEP** (Drey's dispatcher selects; it only *claims* through `dk claim`). `dk next` is not used by the fleet. |
| 27 | Runner wrapper / worktrees | engine creates `_worktrees/<id>/<repo>` on `t/<id>` per work repo, pre-push hooks, branch protection | wrapper concept in CONCEPT.md: claim -> worktree `../wt/<id>` on `dk/<id>` -> work -> `dk commit` -> `dk release`; core knows no code repos | **SAME shape**; Drey's runner **is** the wrapper. Branch name `t/<id>` stays Drey's. dricket never touches work repos; `dk`'s own linked worktree lives in the data dir and does not interact with them. |
| 28 | Crash/abort | trap -> stop ladder; stamp-less daemon retirement | wrapper traps and releases; SIGKILL = lease runs out | **SAME**; Drey adds `dk release` in its stop ladder. |
| 29 | Multi-machine | one engine per desk; remote devices are clients of that engine | many runners on different machines are first-class | **dricket gain**; not needed yet. |

### 2.6 Comments and conversation

| Drey | dricket | Verdict |
|---|---|---|
| Run thread (stream) | none | **KEEP**, machine-local |
| Send-back note + review line comments (`### Review feedback` in `## Handover`) | `dk comment` (add-only file, anyone, no claim, `rev` unchanged) | **DK for the note** (a comment from `owner`), **KEEP** the `### Review feedback` block (the build prompt reads it from `## Handover`). |
| Needs-you answers (`resolved: <key>` in `.status.log`) | comment | **DK** with a keyed first line, see 2.7 |
| Mission Control chat sessions `_meta/chat/*.md` | none | **KEEP**, not ticket data; they move to the meta location. |
| Persona thread / memory | none | **KEEP**, `_meta/personas` -> meta location. |
| Handover between steps (`## Handover`) | none | **KEEP** |
| `inbox` per owner | stateful marker per store and owner in the tool's data dir | not usable for a UI that serves several clients; need a stateless comment list [R-08]. |

### 2.7 Status log, ledger, costs, proof

| Drey artefact | Home today | In dricket | Verdict |
|---|---|---|---|
| `<id>.status.log` (verbs `working`, `needs-decision [key]`, `blocked [key]`, `paused`, `resolved`, `done`, `failed`) | beside the ticket, append-only, committed with run bookkeeping | not allowed beside the ticket (`unexpected-path`) | **CONFLICT**. Mapping: `working:` becomes ephemeral (SSE/engine memory, **not persisted** — it is the bulk of the "fleet run bookkeeping" commits); `needs-decision`/`blocked`/`resolved`/`failed`/`paused`/`done` become comments by the runner identity whose first line is the verb line; stage `needs-input` or `blocked` is set at the same time. The "open key stays until `resolved`" rule is unchanged: the reader derives it from the comment list. |
| `_meta/ledger.jsonl` (`dispatched`, `phase`, `proof_ready`, `merged`, `archived`, `run_settled`) | inside the vault, swept into git by the next commit | not allowed under `tickets/` | **KEEP, relocated** to the meta location (`engine-impact.md` §6); `phase` is derivable from `dk log` and is dropped; `run_settled` (cost, tokens) stays the source of day budgets. |
| `## Verlauf` | ticket body | ticket body | **KEEP** |
| Proof: `## Verification`, `tickets/attachments/`, `tickets/videos/` | ticket body + vault folders | body stays; binaries cannot sit under `tickets/` | **KEEP, relocated** binaries; links `../attachments/<name>` become `attachments/<name>` resolved by Drey against the meta location (a rewrite step in migration, no live links in the 27 live tickets except T-0085 era shots in `archive`). |
| Costs, tokens | ledger + Verlauf | not dricket's concern | **KEEP** (dricket's "no time tracking, no reporting" non-goal). |

### 2.8 Dependencies, priorities, order

| Concept | Verdict |
|---|---|
| `depends` vs `blocked-by` | **DK**, with the dangling-id difference [R-12]. Derived `blocked`/`blocks` is computed by Drey from `depends` as today. |
| Priorities | **DK** for storage and validation (`[priorities]`); order and jump class stay in Drey. |
| Derived order within a column | **KEEP**; needs `x-rank` [R-01] and stage history [R-07] for `entered-<phase>`. |
| Sparse pins | already retired. |

### 2.9 Validation

| | Drey validator | dricket |
|---|---|---|
| Where | board render + before every fleet action; never blocks a human | `lint` before each write; `validate` on demand, CI, hooks; exit 14 |
| Checks | id grammar, required fields, enums, `branch` rule, phase membership, `entered-*`, claims, `repo` in `repos.md`, acceptance criteria present, `blocked-by` cycles, `form`, `chain` grammar | schema, identity, enums, owner/lease consistency, refs exist, no dependency cycles, lease <= `lease_max`, secret scan, **history replay** (rev +1, epoch rules, add-only comments, one ticket per commit) |
| Verdict | **Split**: dricket covers structure and coordination; **Drey keeps** the domain checks (acceptance criteria present, repo resolves, branch rule, chain grammar, persona exists, form/proof values) as a second validator over the parsed ticket. Both run: dricket's is the gate for writes, Drey's for "can the fleet act". Severity model differs: Drey warns and badges (tolerant readers), dricket refuses (exit 14). The board must still render a ticket that fails `dk lint`. |

Consequence of the history replay: **a dricket `tickets` branch cannot carry
Drey's existing 1 684-commit history** (rev rules, one ticket per commit,
other paths). History is cut at migration; the old repo stays as the archive.

### 2.10 Monitoring, secrets, quotas, profiles

| Concept | Drey | dricket | Verdict |
|---|---|---|---|
| Monitoring | fleet panel from the engine (SSE), lease reaper | `dk leases [--expiring\|--stale\|--check]`, `quiet` hint, `inbox` | **DK** for cross-machine claim status; **KEEP** the engine's live run view. |
| Change notification | vault watcher round / SSE `board` event / engine announces its writes (E2b-4) | none: "built-in watcher or background poller" is in dricket's decisions against; users loop `dk inbox`; hint: `git ls-remote` tip then incremental fetch | **GAP** [R-09]. Drey's engine owns the poll (it is the process that writes anyway) and needs a cheap `dk changes --since <sha>`. |
| Secret scan | none (the owner's prompts contain no scan) | scans title/description/comment/note/release result and whole-ticket `commit`; exit 19 | **DK, new**; Drey must handle exit 19 (hold the step, tell the owner) and may hit false positives on pasted logs [Q-04]. |
| Quota | none | `quota_tickets_per_day` (default config value in the scaffold: 50) per commit author identity | **DK, new**; set `0` during import; plan release mints at most a handful per day. |
| Profiles / accounts | one git identity of the desk; actors named `owner@<device>` in the Log | `--profile`, `DK_OWNER`, per-profile ssh key and data dir | **DK**. The owner is the only human and the only Git account today, so the "service account vs own accounts" hurdle from `integrations/drey.md` is **moot until a second human exists**; recommendation in Q3. |
| `min_version` / exit 16 | n/a | forces tool updates | **DK**: Drey bundles a fixed `dk`. |
| Backup | tickets repo with `push:` | repo is its own backup | **SAME** |

## 3. Conflicts that need a decision (summary)

| # | Conflict | Recommendation |
|---|---|---|
| C1 | Fixed seven stages vs Drey's configurable phases | dricket gains `[stages]` config (owner is the author). Interim `x-phase`. |
| C2 | `tickets/` tree is dricket's; Drey's `_meta`, attachments, videos, status logs, ledger do not fit | Split repositories: new dricket store for tickets; the current repo becomes the **meta** repo. |
| C3 | Humans cannot move/edit without a claim | `dk move`, `dk put` / extension-field `set` for admins and kind `human` (R-01, R-02, R-04). |
| C4 | Single-writer (ADR-0076) vs claim-holder editing | Runner is the only `dk` caller; keep the rule. |
| C5 | Dangling dependency semantics | dricket option to treat missing dependencies as satisfied, or migration drops dangling ids. |
| C6 | `## Log` / `## Result` double writers | Drey stops writing `## Log`; only `dk release -m` writes `## Result`. |
| C7 | History | Cut; old repo is the archive. |
| C8 | Latency: every write is fetch + commit + push | Remove per-line bookkeeping commits (1 057 of 1 684 commits in the real repo are `fleet run bookkeeping`); local store mode while no remote. |

## 4. What stays Drey's, unchanged in concept

Mission Control UI and chat (Pia), personas (Paul, Ben, Ralf, Tessa, owner
persona "You"), flows and chains (standard flow + per-ticket delta), plans and
parts, proof/verification/video, costs and estimates, the desktop integration
(views, tabs, Assistant targets), the dispatcher, the worker providers and
pools, the stop ladder, worktrees of work repos, the remote gateway and pairing.
All of these read and write **ticket documents and a few fields**; what changes
is the layer underneath them (`engine-impact.md`).
