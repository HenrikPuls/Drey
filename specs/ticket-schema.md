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
| `parked-reason` | string | With `parked-at`; the ticket sits in inbox while parked (circuit breaker, budgets — ADR-0075). Any transition out of inbox clears both. The circuit breaker writes them when it parks a column's next candidate (M85); re-prioritizing revives the ticket. |
| `parked-at` | UTC timestamp | See `parked-reason`. |

Unknown keys are preserved on rewrite and reported as noise (not an
error). Human edits never break the file: what parses as YAML reads;
what does not is a badge.

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
  dispatcher — the pool size is the parallelism, M85).
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
- `workers:` — the pool size (integer ≥ 1, default 1): up to N
  concurrent runs drain the column.
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
`entered-<phase>`, then id.

## `_meta/repos.md` — work repositories

```markdown
---
repos:
  drey:
    url: https://github.com/HenrikPuls/Drey.git
    branch: main
    path: E:/projects/Drey-m83
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
`.\dev.ps1`, the repo's build, whatever it uses). `worker` (M84) is
the repo's default fleet worker for tickets on this repo. Names are
unique; a ticket's `repo:` must name one of them once it is in a work
phase.

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
