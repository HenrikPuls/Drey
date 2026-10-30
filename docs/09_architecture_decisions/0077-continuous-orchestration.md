# 0077 — Continuous orchestration: column runners, the dispatcher, and the chain's control model

- Status: accepted (2026-10-18, milestone 85; ticket T-0007)
- Amends: [ADR-0075](0075-ticket-pipeline-and-agent-fleet.md) (the fleet's run model; the "dispatcher/reaper only if
  trial data justifies" reservation is superseded) and M84's "a green gate moves the ticket on its own" rule
- Companion: [ADR-0076](0076-tickets-repository-as-system-of-record.md) (the format; unchanged — the chain's control
  state still never lives in the tickets repo)

## Context

M84 made a run controllable but the board stayed hand-driven: a human picked a ticket, picked a worker, pressed
start. Running the pipeline meant standing at the board. The owner's design rounds of 2026-10-17/18 (ticket T-0007)
specified the missing half: the board becomes a running pipeline — columns with workers drain themselves, the human
keeps checkpoints, and the machine keeps safety nets.

## Decision

**The worker-per-column is the auto/manual switch.** A pipeline phase may carry pool keys in `_meta/pipeline.md`:
`worker:` (the agent CLI; unset column = a manual step — the dispatcher ignores it), `model:` (the model pin),
`workers:` (parallel runs, default 1), `prompt:` (the `_meta/prompts/` ref; the handover's ref is the default, and
setting a worker writes the matching `agent <phase>-default` handover while clearing it writes `manual`). The
handover stays the authority: a column is automatic exactly when its handover mode is `agent`. The settings dialog
(Tickets) edits these keys with one commit per change; the file stays hand-editable and wins on refresh.

**The dispatcher lives in the fleet runner.** It already owns the process table and survives Drey restarting; Drey
only points it at a tickets vault (`chain` config over the loopback API, idempotent, re-sent with every board
snapshot). Per playing automatic column with free slots it serves **the column's own queue** (refinement rounds the
owner moved back) — and nothing else: the machine never pulls from a manual column. `prioritized` is the owner's
queue; he moves a ticket into the worker column himself, the pool runs it where it lies, and a green gate moves it
straight to the working column's next phase. WIP limits warn on the board but never gate dispatch — the pool size is
the parallelism. (Amended 2026-10-18, owner ruling: the original "drain the manual queue before the first automatic
column" pulled tickets out of `prioritized`, a folder the machine must not touch.)

**Checkpoints: a manual column between automatic ones is the owner's.** The dispatcher never pulls — the owner's
forward move is what feeds every pool (plan-review in the live default: refine / implement / park, all human moves).
Backward moves are always human moves — never blocked, always logged; the lane rule binds agents only.

**Step completion is the agent's call; the gate is the safety net.** Every run brief ends with the completion
discipline: work the step, run the acceptance commands yourself, declare the step done only when they pass and the
work is ready — the agent's finished turn is the declaration. The runner still re-runs the machine gate: agent-done
AND green gate moves the ticket one column right; a red gate parks it (failure logged, run slot freed, ticket stays).
This amends M84's "green gate moves on its own": the gate is not an independent mover.

**Master and column control, persisted runner-side.** The panel header carries An / Aus / Notaus: run, halt gently
(running work finishes, nothing new dispatches), and the red button — abort every live run through the stop ladder
and halt, one click. Per column: pause (no new dispatch, current runs finish), stop (abort this column's runs and
hold), play. Stopping one column never stops the rest. All of it persists in `<userData>/fleet/chain.json` — never
in the tickets repo (ADR-0076). The column states resume when the runner restarts; **the master does not**: every
boot starts halted, because "An" is a per-session decision — a chain must never start moving just because the app
started (owner ruling, 2026-10-18). A running chain keeps the runner alive (no idle self-shutdown): the board drains
while Drey is closed.

**Safety nets.** The lease reaper fails a run whose worker process is provably dead (a lost exit event, a spawn that
never came up) and frees its ticket — a silent-but-alive worker is never touched (ADR-0014: no timeouts on
generation). The circuit breaker counts consecutive red gates per column (`max-red:`, default 3; a green gate
resets): tripping holds the column and parks its next candidate in inbox with `parked-reason`/`parked-at` — the one
machine-sanctioned backward move. A red gate also cools the column down for a minute before it fires again. Daily
token budgets per column (`token-budget:`, off by default) trip the breaker the same way.

**Quality rungs, flagged off.** `audit:` (a fraction) samples green steps and `semantic: true` gates every green
step in a column — both run a second, fresh worker over the same branch before the move (a prefixed brief over the
run's own instruction; one round, its own gate decides). They exist for the owner's live trial to judge; both
default off.

**The ci handover works.** A column with `handover: ci` and a `ci:` command leaves its tickets to the machine: the
runner executes the check in the ticket's work repo; a green check moves the ticket one column right (one commit,
`… -> <phase> (ci)`), a red one backs the ticket off for ten minutes.

**The MCP seam is typed and generic.** SDK 1.29 adds `ctx.mcp.registerTools(provider)`: a plugin's tools appear on
Drey's own MCP server beside the vault tools (listed after them, routed by wire name, first registration wins a
collision). The tickets plugin registers `fleet_status`, `fleet_run`, `fleet_stop`, `fleet_steer`, `fleet_watch` —
the assistant and any connected program can drive runs conversationally.

## Later change — provider pools and column priority (2026-10-30, req-61)

The per-column `workers:` pool is retired. Slots bound to a column blocked
work while the provider had capacity (an idle plan slot could not serve
build), and the left-to-right fill started work before it finished it.
The parallel slots now belong to the **worker providers**
(`fleet.pool.<provider>.size`, plugin config); every live run of a
provider takes one. The dispatcher orders one candidate list across all
playing automatic columns by priority class (`urgent`/`high` before
`normal`/`low`), then the rightmost column first, then column order — and
never preempts a running run. The owner decided against keeping
`workers:` as a per-column cap or reservation.

The capacity cannot generally be read from the provider: only llama.cpp
reports it (`/props` → `total_slots`, an optional probe URL that caps the
pool); hosted APIs report rate limits, not concurrency. A run that fails
on a rate limit shrinks its pool by one slot for five minutes.

## Consequences

- The board runs itself wherever a column has a worker; the owner's leverage concentrates in triage (inbox), the
  checkpoints (plan-review, commit) and the switches. The live default gives workers to plan, build and review.
- The runner grows from "one run, supervised" to a loop with state (`chain.json`); its dispatch decisions are
  event-driven (config/control changes, run settle) with a 15-second safety-net rescan, so external board moves are
  picked up even with Drey closed.
- Two moves happen without a human: the forward move on a green gate (M84, unchanged) and the breaker's park into
  inbox. Both are logged in the ticket with the actor `agent@<host>`; everything else backward stays human.
- Model pins now reach both adapters: claude-code via `--model`, OpenCode via the v2 message body
  (`providerID/modelID`, split at the first slash).
- The second-opinion mechanism (audit/semantic) shares the run machinery end to end — no new runner concept; a
  failed opinion parks the ticket exactly like a red gate.
- The SDK gains its first program-facing tool seam; plugin tools are full MCP citizens and carry the same trust
  model as the vault tools (the tickets repo's commands were always owner-authored).
