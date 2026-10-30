# Ticket Schema — the tickets repository format

The complete, machine-facing specification of the tickets repository
(ADR-0076; the fleet that works it is ADR-0075). Written so that a
human, a Drey component, or an agent CLI can operate the format from
this file alone. Ticket files are **not** vault notes — only the YAML
conventions shared with [`frontmatter-schema.md`](frontmatter-schema.md)
apply (quoted dates, plain text).

Top-level rules, once, up front:

- **One file per ticket. The phase is the directory. The filename is
  the identity.** A ticket file moves between directories; its name
  never changes.
- **Phase directories are numbered** (T-0041): `NN-<id>` with `NN` the
  phase's 1-based pipeline position × 10 — `10-inbox`, `20-prioritized`,
  … `80-done`. The number lives ONLY in the directory name: `entered-*`
  keys, `order.md` sections and branch names keep the clean id.
- **Every phase transition is one git commit** (`git mv` semantics +
  the frontmatter stamp), message format
  `tickets: <id> <from> -> <to>` (ASCII arrow).
- **A file move between phase folders is a ticket move.** Moving a
  ticket file outside the board (Explorer, Files panel) has exactly the
  effect of a board transition: on the next board refresh, stateless
  normalization detects the ticket sitting in phase B with an
  inconsistent `entered-<B>` stamp and completes the treatment — stamp,
  Log line, pin cleanup, one commit `tickets: <id> <from> -> <to>`,
  actor `owner@<host>`. Works after restarts (derived from the files,
  no extra state); lane rules are never enforced on human moves —
  logged, not blocked.
- **Machine writers write strictly** (the exact shapes below);
  **humans edit freely**; **readers normalize visibly** — anything a
  reader cannot parse unambiguously is reported as an issue on the
  board, never guessed. Tolerate noise, never ambiguity.
- All timestamps are **UTC, seconds precision, quoted**:
  `'2026-10-17T14:32:00Z'`.
- Line endings LF. Encoding UTF-8.

## Layout

```
<tickets repo root>/
  _worktrees/       # reserved (T-0044): the fleet's worktree home —
                    #   <ticket-id>/ per ticket, gitignored, invisible to
                    #   the vault's tree/index/watcher
  tickets/
    _meta/
      pipeline.md     # the phases + handover config (config, never data)
      order.md        # sparse per-column order pins (data, never config)
      repos.md        # work-repo name -> clone URL/path mapping
      prompts/        # the handover prompts (`agent <prompt-ref>` names one file)
    10-inbox/
      T-0042.md       # one ticket per file, in its current phase's folder
    20-prioritized/
    30-plan/
    40-plan-review/
    50-build/
    60-review/
    70-commit/
    80-done/
    archive/          # reserved (T-0041): archived tickets, never a column
```

The phase folders are exactly the phases configured in `pipeline.md`
(the set above is the default, not fixed). `_meta` and `archive` are
reserved; nothing else lives beside the phase folders. A vault whose
root contains `tickets/_meta/pipeline.md` **is** a tickets vault — that
file's presence is the detection marker.

**Reserved `_`-prefixed folders at the repo root (T-0044, ADR-0080).**
`_`-prefixed names directly beside `tickets/` are machine state, never
ticket data: the board, the vault's markdown index and the file watcher
skip them entirely, and the repo's `.gitignore` covers them (ensured by
the boot sweep, one commit when appended). The fleet's worktrees live in
`_worktrees/<ticket-id>/` by default; a repo can override its base with
a `worktrees:` key in repos.md. The skip is root-depth only —
`tickets/_meta` stays indexed and watched.

### Numbered folders (T-0041)

`NN` is derived from the phase's position in pipeline.md (1-based × 10,
two digits). Readers strip a leading `\d+-` from the directory name and
match the rest against the pipeline ids; **an unprefixed directory
stays tolerated** (`tickets/inbox/…` reads exactly like
`tickets/10-inbox/…` — the migration of an existing repo is 8×
`git mv`, and ship order is free). Writers resolve their target
directory per move: the derived `NN-<id>` name when it exists, else any
existing directory whose stripped id matches, else the derived name
(created on first use). Inserting a column by hand takes a **gap
number** (`35-qa`) — no move ever renumbers existing directories, so
there is no rename cascade. Directory names are never written into
ticket files, order.md or branches.

**Renumbering is an explicit owner action** (req-50, Settings →
Tickets): reordering the columns there rewrites `pipeline.md` and
renames every phase folder whose number no longer matches its position,
in **one commit** (`tickets: reorder phases <ids…>`); "Number folders"
does the renaming alone (`tickets: number phase folders`) — the
migration of an unprefixed repo, or tidying gap numbers. Several
folders of one phase (an unprefixed `inbox` beside a machine-made
`10-inbox`) fold into the derived one; `_meta`, `archive` and folders
that name no phase are never touched. Both refuse while a ticket in a
renamed folder has a live `run:` (the runner holds its path), and
refuse before touching anything when two files of one name would land
in one folder.

### Archive (T-0041)

`tickets/archive/` is a reserved folder beside `_meta`: **not a board
column, invisible on the board, no counter display**. Archiving goes
through the card menu (two-step armed) or by moving the file into
`archive/` — both yield the Log line `archived` (a machine-shaped
`— archived` marker, NO `entered-archive` stamp; claim fields ride
along) and exactly one commit `tickets: <id> archived` with pin
cleanup. Reviving is a move back into a phase folder — normalization
treats it as `archive -> <phase>`. Body edits after archiving never
re-fire normalization. Final deletion is the owner's manual act inside
`archive/`.

### Id minting

`T-` + at least four digits, zero-padded to four (`T-0042`, `T-1327`,
`T-10000`). The next free id is **max of all existing ids across every
phase folder + 1** (never reuse a gap — a deleted ticket's id stays
burned; git history is the record). If two sides minted the same id
independently, the merge conflict is resolved by the **later** side:
re-mint the next free id and rename file, `branch:` field and the work
branch together in one commit.

### The branch rule

The work branch of a ticket is deterministic: `t/<id>` (`t/T-0042`).
The `branch:` frontmatter field is cross-validated against the rule —
**the rule wins**, a mismatch is an issue badge, not an error. Machine
writers always write the rule's value.

## Ticket file

```markdown
---
id: T-0042
title: 'Fix the palette race in CI'
repo: drey
priority: high
rank: 5000
branch: t/T-0042
entered-inbox: '2026-10-17T14:32:00Z'
entered-prioritized: '2026-10-17T15:01:12Z'
claimed-by: owner@desk
claimed-at: '2026-10-17T15:04:00Z'
references: ["t/T-0041", "https://github.com/HenrikPuls/Drey/pull/12"]
---

## Description

What and why, in plain Markdown. Links to notes, PRs, people.

## Plan

How. Filled in the plan phase; must end with the acceptance criteria.

### Acceptance criteria

- [ ] `npm run verify:unit` — exits 0
- [ ] `npm run verify:pack` — exits 0

## Log

- '2026-10-17T14:32:00Z' owner — created in inbox
- '2026-10-17T15:01:12Z' owner — inbox -> prioritized
- '2026-10-17T15:04:00Z' owner — claimed (build)
```

### Frontmatter fields

| Field | Shape | Rules |
|---|---|---|
| `id` | `T-\d{4,}` | Required. Must equal the filename stem. Immutable. |
| `title` | string | Required. One line, quoted when it contains `:`. |
| `repo` | string | Name from `_meta/repos.md`. May be empty until the ticket leaves inbox for a work phase; entering one without a known repo is an issue. |
| `worker` | string | Optional pin for the fleet worker (M84): `opencode`, `claude-code`, or `<provider>/<model>`. Wins over the column's `worker:` key, the phase handover's `@worker` pin, the repo's `worker:` and the configured default (M85's assignment ring). An unknown value badges the card; a run start with it refuses. |
| `priority` | `urgent \| high \| normal \| low` | Required. Default `normal`; machine writers always write it. |
| `rank` | integer 0–999999 | Default `5000`. Fine ordering inside derived order. |
| `branch` | `t/<id>` | Written by machine writers; validated against the rule; rule wins. |
| `entered-<phase>` | UTC timestamp | One per phase ever entered; holds the **most recent** entry time into that phase (first entry lives in git history). `entered-inbox` exists from creation. |
| `claimed-by` | `<who>@<host>` (agents append `:<session>`) | Set when the ticket enters a claim-flagged phase (default: build); `owner@<host>` for the human. Takeover overwrites and logs the old value. |
| `claimed-at` | UTC timestamp | Set with `claimed-by`. |
| `run` | map `{pid, started-at, stream}` | The live run (ADR-0075 run control): stamped by the fleet runner at start, cleared at end — at most one live run per ticket. `stream` names the **run id**; the stream file itself lives machine-local under `<userData>/fleet/runs/<id>/stream.jsonl`, so the ticket stays portable across the machines the repo syncs to. Readers validate the shape. |
| `references` | list of strings | Optional. Ticket ids (`t/T-0041`), URLs, vault paths. |
| `blocked-by` | list of ticket ids | Optional (T-0050). `blocked-by: [T-0048]` — the ticket waits until every referenced ticket reaches the pipeline's terminal phase. Blocked is **derived** on every board assembly, never stored. See [Dependencies](#dependencies-blocked-by). |
| `parked-reason` | string | With `parked-at`; the ticket sits in inbox while parked (circuit breaker, budgets — ADR-0075). Any transition out of inbox clears both. The circuit breaker writes them when it parks a column's next candidate (M85); re-prioritizing revives the ticket. |
| `parked-at` | UTC timestamp | See `parked-reason`. |
| `interactive` | boolean | The dialog reservation (req-65): `interactive: true` — the owner works this ticket in an interactive dialog with a fleet worker, so the dispatcher keeps its hands off while the field stands. An interactive run's start stamps it; any transition (a board move) drops it — at the new column the machine may take the ticket again. Only a bare `true` reads as set. |

Unknown keys are preserved on rewrite and reported as noise (not an
error). Human edits never break the file: what parses as YAML reads;
what does not is a badge.

### Dependencies (`blocked-by`)

A first-class dependency field (T-0050): "do not start before X is
done". The order it replaces used to live in prose, invisible to the
board and the fleet.

- **Canonical syntax**: flow list with comma + space —
  `blocked-by: [T-0048]`, `blocked-by: [T-0048, T-0049]`. The parser
  accepts every YAML list shape (block style, any spacing); a
  hand-written no-space list (`[T-0048,T-0049]`) is normalized
  cosmetically on the next machine rewrite, while the canonical form
  round-trips **byte-stable** through a transition's frontmatter
  rewrite. An empty list reads as an absent field.
- **Satisfied phase**: one global rule — a reference is satisfied
  exactly when the referenced ticket sits in the pipeline's terminal
  (last) phase. No per-reference override.
- **Derived, never stored**: every board assembly recomputes each
  card's `blocked` (the open blockers, unknown ids included) and the
  inverse `blocks` (the currently-blocked dependents). Both hide when
  empty — a done blocker shows nothing. A blocker in an unknown
  directory resolves by its stripped phase id, never terminal, so it
  blocks. `tickets/archive/` is not read: a blocker deleted, renamed
  or archived resolves to no board ticket — warning, and the dependent
  stays blocked (never a silent unblock).
- **Validation**: an id that resolves to no board ticket is a warning
  on the dependent (`blocked-by names T-0048, which is not on the
  board`) and stays blocking. Self-reference and cycles are one error
  per member naming the cycle (`blocked-by cycle: T-0001 -> T-0002 ->
  T-0001`; self = `T-0001 -> T-0001`) — cyclic members also count as
  blocked. Duplicate blocker ids (themselves already an error) resolve
  to the first occurrence in column order.
- **Enforcement**: exactly the machine gates — the dispatcher never
  picks a blocked ticket, the manual "Run agent…" start refuses with
  the open blockers named, and the ci sweep skips it (a blocked ticket
  does not move through a `ci` column either). Human moves stay free;
  a drag into an agent column asks for confirmation naming the open
  blockers (the owner is the final authority). The board shows
  `blocked by <ids>` / `blocks <ids>` chips plus an optional
  "hide blocked" view filter; ordering is never touched. The drift
  pass (normalization) never enforces blocked-ness — a file move is an
  owner move.

### Body sections

Free Markdown; the section headings below are convention that Drey and
the runner rely on:

- `## Description` — what and why. The capture text lands here.
- `## Plan` — how; authored in plan phase. Leaving plan-review without
  acceptance criteria is an issue (the machine gate needs them).
- `### Acceptance criteria` — under Plan. Checkbox lines whose text
  starts with a backticked command; the machine gate runs exactly
  these, locally, in the worker's checkout (ADR-0076: validator, not
  CI).
- `## Log` — append-only. Machine-appended entries use the exact line
  shape `- '<UTC timestamp>' <who> — <text>`; humans may append in any
  readable shape. Every transition, claim, takeover, injection, stop
  and budget event lands here (ADR-0075).

## `_meta/pipeline.md` — the phases and their handovers

```markdown
---
push: origin
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: plan, title: Plan, wip: 1, handover: manual }
  - { id: plan-review, title: Plan review, handover: manual }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }
  - { id: review, title: Review, handover: manual }
  - { id: commit, title: Commit, handover: manual }
  - { id: done, title: Done, handover: none }
---
Prose for humans. The board follows this file on refresh.
```

- `id`: `[a-z][a-z0-9-]*`, unique, = the phase (the stripped directory
  name). The first phase is the capture target; the last is terminal —
  nothing moves out of it. Humans always may move tickets into it, and
  so may the machine from an agent-driven column whose next phase it is
  (owner ruling 2026-10-19: the commit column's agent pushes the work
  onto the integration branch, then the ticket goes `commit -> done`).
- `title`: board column header.
- `wip`: optional integer. Over-limit shows red on the board
  (`4/3`); it warns, it does not block a human (and it never gates the
  dispatcher — the provider pools are the parallelism, req-63).
- `claim`: optional `true` — entering this phase stamps the claim
  fields.
- `handover`: what must happen for a ticket to LEAVE this phase:
  `manual` (a human moves it), `agent <prompt-ref>[@<worker>]` (the
  fleet runs prompt `<prompt-ref>` — `tickets/_meta/prompts/<ref>.md`
  in the tickets repo — and the runner moves it on success; the
  optional `@worker` pins which agent CLI, otherwise the assignment
  ladder decides), `ci` (an executable check passes — the phase's
  `ci:` command, run runner-side in the ticket's work repo since M85),
  `none` (terminal). A column is **automatic** exactly when its
  handover mode is `agent` (M85's dispatcher drives it); `manual`
  columns are the human's.
- `push`: optional (T-0041) — the **name of a git remote** (from git
  config; never a URL). When set, every transition commit (a board
  move, a normalization move, an archive, the runner's success move)
  is pushed: `git push <remote> HEAD` from the tickets repo root.
  Default off; a push failure is a warning (board) / log line
  (runner), never a failed transition. Anything but a remote-name
  string is ignored with a noise badge.
- `interactive`: optional prompt ref (req-65) — the brief an
  **interactive dialog run** in this column gets
  (`interactive: plan-interview` → `tickets/_meta/prompts/plan-interview.md`).
  Absent, the shipped defaults apply: `plan-interactive-default` on the
  pipeline's plan column, `refine-interactive-default` at the owner's
  checkpoints and the last agent column. An interactive run is started
  from the board ("Plan with agent" / "Refine with agent"), not by the
  dispatcher: the worker is the owner's from turn one (held), the run
  never gates and never moves — the dialog's end moves (in the takeover
  tab) are owner moves. While the run is live the ticket carries
  `interactive: true`, which keeps the dispatcher off it; the move
  drops the field.
- Editing this file is the owner's; the board re-reads it on every
  refresh. Unknown keys in a phase entry are ignored.

**Pool keys** (M85, ADR-0077 — the settings dialog writes them with one
commit per change; hand edits win on refresh):

- `worker:` — the column's worker pin (`opencode`,
  `claude-code`, `<provider>/<model>`), the assignment ladder's column
  level (ticket pin > column > handover `@worker` > repo default >
  configured default). Unset on a manual column.
- `model:` — the model pin for the column's runs (OpenCode:
  `providerID/modelID`).
- `workers:` — **retired (req-63).** The parallel slots belong to the
  worker providers (`fleet.pool.<provider>.size` in the plugin config,
  Settings → Tickets → Workers, req-71), shared by every column. A leftover key is
  ignored with a noise badge; clearing a column's worker removes it.
- `prompt:` — the prompt ref override; the default is the handover's
  ref (and setting a worker in the dialog writes the matching
  `agent <phase>-default` handover, clearing it writes `manual`).
- `max-red:` — the circuit breaker's tolerance: consecutive red gates
  the column takes before it trips (holds + parks its next candidate
  in inbox). Default 3.
- `token-budget:` — the column's daily token budget (the pool's settled
  runs are summed per day); over budget trips the breaker. Off by
  default.
- `ci:` — the `ci` handover's executable check (a shell command, run in
  the ticket's work repo checkout); a green check moves the ticket one
  column right, a red one backs the ticket off for ten minutes.
- `audit:` — a fraction 0–1: a green step is sampled and a fresh second
  worker reviews it before the move. Default off.
- `semantic: true` — every green step in the column gets a second
  worker's review before it moves. Default off.

**Agent lane rules** (enforced by the runner, not the board — the
board serves the human): an agent works the tickets the dispatcher
gives it — the column's own queue first, then the previous column's
top — and a dispatched run's completion moves the ticket from where it
sits to the **working column's next phase** (a pulled ticket goes
`prioritized` → `plan-review` in one step). A manual column between
automatic columns is the owner's **checkpoint**: the machine never
pulls across it, and only the owner's moves cross it (refine /
implement / park). Backward moves are human moves — the one exception
is the circuit breaker's park into inbox, always logged.

**Dispatch order** (req-63): one candidate list over every playing
automatic column, ordered by priority class (`urgent` / `high` before
`normal` / `low`), then column rank — the rightmost column first, so
finishing beats starting — then the column's own order (pins, then
derived). Each candidate takes a slot of the provider pool its
assignment resolves to; a full pool makes it wait, a running run is
never preempted.

## `_meta/order.md` — sparse order pins

```markdown
# Column order pins — listed ids form the top of their column

## prioritized

- T-0042
- T-0019

## build

- T-0007
```

A section per phase (only phases that have pins; only pinned ids —
that is the sparseness). Column order = pinned ids in listed order
first, then unpinned ids in derived order. A drag within a column pins
everything above and including the drop position. Unknown ids in a
section are ignored with a noise badge. Two branches adding different
pins union on merge; a text conflict is resolved by hand, union
semantics. Rank collisions in derived order fall back to
`entered-<phase>`, then id. The card context menu's "Move to top" /
"Move to bottom" is the same reorder operation with drop index 0 / the
column's end — a menu move and the equivalent drag write identical
pins.

## `_meta/repos.md` — work repositories

```markdown
---
repos:
  drey:
    url: https://github.com/HenrikPuls/Drey.git
    branch: main
    path: E:/projects/Drey-m83
    link: [.tools, node_modules]
  lariscus:
    url: https://dev.azure.com/org/project/_git/lariscus
    branch: main
    policy: Azure DevOps branch policies protect main
---
Prose for humans.
```

`url` is any git remote (or a local path for a repo that only lives
on this machine); `branch` is the integration branch the ticket branch
forks from and merges into; `policy` is a free-text note recording
which protection exists (ADR-0075: hosts are interchangeable, the
fleet never calls a host API). `path` is the **local checkout /
worktree** where the repo's work is tested — the board's card context
menu opens a terminal there ("Open work folder in terminal": run
`.\dev.ps1`, the repo's build, whatever it uses). `worker` (M84) is the repo's default fleet worker for tickets on this
repo. `worktrees` (T-0044, ADR-0080) overrides where the fleet's
worktrees for this repo live — an absolute folder, or one relative to
the tickets repo root; the worktree is `<base>/<ticket-id>`. Unset (the
default) is `<ticketsRepo>/_worktrees`. `link` (req-56) names
git-ignored folders of the checkout at `path` — one name or a list,
relative, never leaving the repo — that the runner links into every
fleet worktree (a junction on Windows, a directory symlink elsewhere)
instead of the worker rebuilding them: the toolchain (`.tools`,
`node_modules`). A folder is linked only when the checkout has it, the
worktree does not, and git ignores it there; the brief then tells the
worker not to install anything. Names are unique; a ticket's `repo:`
must name one of them once it is in a work phase.

## Validation (where it runs, what it checks)

There is **no CI on the tickets repository** (owner's ruling,
ADR-0076). The one deterministic validator runs where the data is
read: the board on every render (issues are badges on the card and the
column; the board still renders), the fleet runner before every action
(refuses an erroneous ticket). Checks, all deterministic:

1. id grammar; id = filename stem; no id in two phases.
2. Required fields present (`id`, `title`, `priority`); enums valid;
   timestamps parse; `run` map shape.
3. `branch` matches `t/<id>` (rule wins; mismatch = badge).
4. Phase directory ∈ `pipeline.md` phases, compared on the
   prefix-stripped id (`50-build` and `build` both match `build`;
   tickets in an unknown folder render in a trailing "unknown" column —
   visible, not lost). `tickets/archive/` is excluded from the board
   entirely (never a column, never a badge).
5. `entered-<phase>` keys reference known phases (unknown keys =
   noise badge).
6. `claimed-by` grammar; `claimed-at` present with `claimed-by`.
7. `repo` (when present) resolves in `repos.md`.
8. `order.md` sections reference known phases and live ids.
9. Leaving `plan-review` without acceptance criteria = issue on the
   ticket (the board shows it; the runner enforces it from M84).
10. `blocked-by` resolution (T-0050): ids resolve against the board's
    columns only — never `tickets/archive/` — and a satisfied reference
    is one sitting in the terminal phase. An unknown id (deleted,
    renamed, archived blocker) is a **warning** that keeps the dependent
    blocked (`blocked-by names T-0048, which is not on the board` —
    never a silent unblock). Self-reference and cycles are one
    **error** per member naming the cycle (`blocked-by cycle: T-0001 ->
    T-0002 -> T-0001`; self = `T-0001 -> T-0001`); the board still
    renders, and cyclic members count as blocked. A duplicate blocker
    id resolves to the first occurrence in column order (the duplicate
    itself is already an error per check 1).
10. `blocked-by` entries resolve against the board's columns (T-0050):
   an unknown id = warning and stays blocking (never a silent
   unblock); self-reference and cycles = errors naming the cycle; a
   reference is satisfied only in the terminal phase — a blocker in an
   unknown directory blocks. The archive is never consulted.

A validation issue never blocks rendering and never blocks a human
transition (a warning shows); it blocks an agent action.

## Normalization (a file move is a ticket move, T-0041)

On every board fetch the plugin runs a **stateless drift pass** over
the ticket files (derived from the files alone — it survives restarts
and re-runs safely because the treatment is idempotent):

- For a ticket with parseable frontmatter and no live `run:` map, in
  known phase B: treatment ⟺ `entered-<B>` is missing or older than
  the newest of (all `entered-*` stamps, the archived marker). The
  treatment stamps `entered-<B>`, appends the Log line
  `<from> -> <B>` (`from` = the holder of the newest event;
  `archive` when the archived marker dominates; `unknown` when no
  stamp exists at all), drops the id from every order.md pin section
  and commits exactly once, `tickets: <id> <from> -> <to>`, actor
  `owner@<host>`.
- In `tickets/archive/`: treatment ⟺ no `— archived` Log marker newer
  than every `entered-*` stamp; the treatment appends the marker and
  commits `tickets: <id> archived` (no `entered-` stamp).
- Skipped: files with parse errors or error-level findings, tickets
  with a live `run:` map (the runner owns the file mid-move), unknown
  directories, `_meta`. Backwards moves and skips are logged, never
  blocked — lane rules stay runner-only.
