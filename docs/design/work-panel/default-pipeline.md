# The default pipeline (E12-9c)

Owner decision 2026-11-05 (answering E12-9b Q1): a new board has six columns,

| # | Stage id | Title | Worked by | Handover in `pipeline.md` | dk claim stage |
|---|---|---|---|---|---|
| 1 | `inbox` | **Inbox** | owner (manual — triage) | `manual`, `persona: you` | no |
| 2 | `plan` | **Plan** | agent (first agent column: writes `## Plan` + the acceptance criteria) | `agent plan-default`, `claim: true` | **yes** |
| 3 | `build` | **Build** | agent (works the plan, then the machine gate) | `agent build-default`, `claim: true`, `wip: 3` | **yes** |
| 4 | `review` | **Review** | owner (manual — reads the diff and the proof) | `manual`, `persona: you` | no |
| 5 | `sign-off` | **Sign Off** | owner (manual — the work is committed here) | `manual`, `persona: you` | no |
| 6 | `done` | **Done** | — (terminal) | `none` | no |

`inbox` and `done` stay the ids they always were (first = capture target, last =
terminal; the circuit breaker's park target stays `inbox`). **The first column is
titled "Inbox" again** — this reverses E12-9's "Ideas" (milestone 164): the canvas says
Ideas, the owner decides Inbox. The Work panel's *group* named "Ideas" is unaffected
(it is a derived group, not a column title).

Existing boards and stores are never touched: a default is only written by
"Initialize board" on an empty tickets repository, and `dk` stages only by
`dk init` / the migration into a fresh scratch store.

## 1. The engine: `pipeline.md`, phase config and flow defaults

```yaml
phases:
  - { id: inbox, title: Inbox, handover: manual, persona: you }
  - { id: plan, title: Plan, claim: true, handover: agent plan-default }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }
  - { id: review, title: Review, handover: manual, persona: you }
  - { id: sign-off, title: Sign Off, handover: manual, persona: you }
  - { id: done, title: Done, handover: none }
```

- **Plan returns as an agent column** (req-93 had removed `plan` / `plan-review` because
  an up-front plan aged in the queue). The difference now: a ticket only sits in Plan
  once the owner moved it there out of Inbox (the machine never pulls from a manual
  column, `planDispatch`), so the plan is written *just before* the build, and Plan →
  Build is one hop. `plan-default` and the structural gate for "the pipeline's first
  worker column" (the run checks that executable acceptance criteria came into
  existence) already exist; no new engine path. `build-default` v3 keeps deriving
  file-level detail itself and treats the plan as hints to verify.
- **No checkpoint between Plan and Build** (both agent): a finished plan flows straight
  into Build. An owner who wants to read the plan first inserts a manual gate per ticket
  (`chain: insert manual(you, notify) after plan`, E10-6) or makes the shape dialog the
  plan step. Not added to the default — least risky, see question 3.
- **Machine verification stays inside Build.** The runner's machine gate (the ticket's
  backticked acceptance commands, re-run after the agent's turn; green moves the ticket
  right, red parks it and counts toward the circuit breaker) and the proof the verify
  service attaches are Build's. There is no `verify` column; a board that wants one adds
  it (concept §5.1).
- **Manual columns are the ones the human persona works (owner ruling 2026-11-05).**
  Inbox, Review and Sign Off carry `persona: you` — the pin of the E10-6 human persona
  (`personas/you`, `kind: human`) — next to `handover: manual`, which stays the engine's
  notion of "the human's column": the dispatcher never touches them (it only reads
  agent columns; the pin is the declared owner, not a dispatch input). The persona is
  written by "Initialize board" together with `pipeline.md`; an existing board gets it on
  first sight (Team, flow editor) and keeps whatever pins it has. **Review is a
  checkpoint** (manual with an automatic predecessor): it raises a *checkpoint* card in
  Needs you, **Accept** is the ordinary forward move (Review → Sign Off), **Send back**
  the ordinary send-back (nearest earlier agent column = Build, mandatory note,
  structured feedback of E11-3). That is the E10-6 behaviour (ticket stays put, owner
  notified, Accept / Send back) obtained from the existing rule, **without** a
  extra mechanism: the `awaiting:` park exists for a *gate in the chain* (an inserted
  `manual` step, or a human persona on an **agent**-handover column); a column with
  `handover: manual` is parked by definition. The pin is deliberately **not** combined
  with an agent handover — that would make Review/Sign Off "automatic" for the dispatcher,
  the capacity figures and `checkpointPhaseIds`.
- **One engine rule widened:** `checkpointPhaseIds` — "a manual column whose
  predecessor is automatic" — now also covers **a manual column right after a
  checkpoint**. Otherwise Sign Off (predecessor Review, manual) would not be a
  checkpoint: no Needs-you card, and the Work panel would list the ticket as a queued
  "Running" row. No shipped pipeline had two manual columns after an agent column, so
  nothing existing changes (test: the old default's checkpoints are unchanged).
- **Sign Off is where the work is committed**; it takes over the role of today's
  `commit` column. `commit` was an *agent* column (`commit-default` merges and pushes);
  Sign Off is manual, so the commit step is the owner's — by hand or by a session
  working the checkpoint (`plugins/tickets/BOARD.md`, skill `ticket-handling`): the
  ticket moves **sign-off → done** exactly when the three conditions hold (criteria met,
  work merged into the integration branch, pushed). The `commit-default` prompt stays
  shipped; a board that wants the old automatic merge sets `handover: agent
  commit-default` (+ `claim: true`) on its Sign Off column.
- Personas: no persona is seeded (E12-9b Q2/Q3 are still open); Plan and Build resolve
  through the ordinary ladder (column `persona:` → role defaults → fleet default worker).
  "Default personas" therefore means: planner role for Plan, builder for Build once a team
  exists; Review/Sign Off are the human persona *You* by definition (manual).

- **The human persona's name is configurable** (`personas.humanName`, default `You`):
  Settings → Tickets → Team → *Your name* writes the config key (new boards start with it)
  and retitles `personas/you/persona.md` (one `personaPatch`, one commit). Every surface
  shows the persona's *title* — column pins, Team, the flow editor, the Settings chips,
  the phone — so one rename applies everywhere; the former hard-coded "You" in the flow
  editor and the Settings chips now read it. A blank name returns to `You`.

## 2. dricket: `[stages]` for `dk init` and the migration

```toml
[stages]
values = ["inbox", "plan", "build", "review", "sign-off", "done"]
initial = "inbox"
terminal = ["done"]
claim = ["plan", "build"]
cancelled = "cancelled"
```

- `claim` = **the agent columns only**. dk offers claim-stage tickets to agents (`dk
  next`) and "a claim moves a ticket into the first claim stage when it is elsewhere";
  listing the manual Review/Sign Off would offer owner work to agents. Consequence
  (checked against `docs/protocol.md`, dk v0.6.2): the first claim stage is now `plan`
  (was `build`): an owner-started run that claims from Inbox lands in Plan, which is the
  right column; a *human* claim of a ticket sitting in Review/Sign Off is refused or
  moves it back to Plan — humans do not claim there, moves are `put --claim` stage
  rewrites (R-31 path), which are valid in any listed stage.
- `cancelled = "cancelled"` stays as today (reserved, terminal, always valid). **No
  `blocked` stage**: the code only uses one when the pipeline has it (`dkTargetFor`:
  `parkStage = pipeline has 'blocked'`); a park is a comment + the stage kept, as today.
- `retreatStage` (a failed run's release target) is the previous column: Plan → Inbox,
  Build → Plan.
- `resolvePhase` (store → board): the ids are pipeline phases (variant A). The dk
  built-in fallbacks keep working (`review` → now itself a phase; `open`/`blocked` →
  Inbox; `in-progress` → first claiming column = Plan).
- `DEFAULT_MIGRATION_CONFIG.stages` = the list above; it gains `claim` (the
  scratch config no longer hard-codes `build|commit`) and `legacyPhases`.

## 3. Migration: legacy phases → the new stages

A files vault with the old default (`inbox, prioritized, build, commit, done`) migrated
into a store with the new default lands:

| Legacy phase | New stage | Why |
|---|---|---|
| `inbox` | `inbox` | same id |
| `prioritized` | `inbox` | the owner's manual queue with no equivalent; Plan is an *agent* column, so landing there would start planning runs (cost) on migrated tickets. The legacy phase stays in `x-legacy-phase` and the ticket keeps its priority — the owner re-queues into Plan by hand. |
| `build` | `build` | same id (a ticket claimed in build still blocks, as today) |
| `commit` | `sign-off` | commit's role moved to Sign Off; both hold "done, waiting for the merge/push check" |
| `done` | `done` | same id |
| `plan`, `review` | same id | present in the new default |
| anything else (`plan-review`, `verify`, …) | skipped with the existing reason | unchanged behaviour |
| `archive` | skipped | unchanged (OD-7) |

The map is `MigrationConfig.legacyPhases` (config, not code in the loop). The reverse
converter numbers folders by the stage list it is given (default = the new list;
`--stages a,b,c` for a store with another vocabulary — so an *old* store reverses with
`--stages inbox,prioritized,build,commit,done`).

## Ambiguities resolved the least risky way (reported as questions)

1. ~~Review/Sign Off as plain manual columns~~ — answered 2026-11-05: manual = `persona: you`.
2. `prioritized` → `inbox` in a re-run migration (not `plan`) — **still open (owner has not answered)**.
3. No checkpoint between Plan and Build (the owner inserts one per ticket when wanted).
4. `claim` excludes Sign Off; a board that automates Sign Off adds it itself.
