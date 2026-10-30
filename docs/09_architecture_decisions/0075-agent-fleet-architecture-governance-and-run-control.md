# 0075 — Agent fleet: architecture, governance, run control

## Status

Accepted (2026-10-17, owner plan review). The tickets foundation it
sits on ships with milestone 83 (ADR-0076); the fleet runner and run
control are milestone 84; continuous orchestration is milestone 85 and
is built only if the trial data justifies it.

## Context

The owner wants external agent CLI sessions (Claude Code headless, and
peers) doing real development work — one ticket per run — with Drey as
the place to watch, steer and stop them. Constraints from the plan
review (2026-10-17):

- **Blast radius first.** An agent works on one ticket's branch in one
  work repo; it must not be able to touch anything else, and the owner
  must be able to audit every step after the fact.
- **The owner steers.** "I need to be able to monitor and stop a run or
  at least steer it" — including live mid-run, not only between runs.
- **Drey stays a local app.** No server process as a dependency of the
  workflow; whatever runs must survive Drey being closed (a run takes
  tens of minutes; Drey may restart meanwhile).
- **Hosts are interchangeable.** GitHub is the first remote in
  practice, but **Azure DevOps is first-class** — the fleet speaks
  plain git only, never a host REST API.

Three architectures were weighed with the owner:

- **A — in-app workers:** the assistant plugin's tool loop executes
  ticket work itself. Rejected: the tool loop is a chat turn, not a
  session — no `--resume`, no worker-side session identity, no way to
  steer mid-run, and one crashed ask takes the "worker" with it.
- **B — hybrid:** external agent CLI worker sessions in their own
  git worktrees of the work repos; Drey (and a small companion
  process) coordinate; the repos and remotes enforce the blast radius.
- **C — full daemon:** a standing orchestrator daemon owning dispatch,
  workers, retries. Rejected for now: nothing justifies a standing
  dispatcher before there is data — the owner triggers runs on demand
  first (M84); automation is a later decision made from evidence (M85).

Owner's ruling: **Hybrid B**, dispatcher deferred.

## Decision

**Workers are external agent CLI sessions in their own worktrees.**
One run = one ticket = one worktree of the ticket's work repo, on the
deterministic branch `t/<id>` (ADR-0076), driven by the installed agent
CLI (the provider list of ADR-0047; capability-gated). Workers never
see Drey's process, the vault config, or API keys beyond what the
governed MCP path grants. The fleet writes **only ticket branches**;
`main` and every other ref are protected by the remote's policy —
GitHub branch protection, Azure DevOps branch policies, or a receive
hook on a self-hosted remote — recorded per repo in the tickets repo's
`_meta/repos.md`. A pre-push hook in each worker clone is the fast
first line (the runner installs it); the remote's policy is the
boundary that actually holds. Vault access for a worker goes through
Drey's governed MCP server (ADR-0021/0071) — scope rules apply, no
keys in the worktree.

**The fleet runner is a standalone headless companion process.** Drey
spawns it detached (single-instance lock under `<userData>/fleet/`);
it survives Drey closing and restarting, and shuts itself down after
an idle timeout. It owns what Drey cannot: the workers' stdio pipes —
stdout file-backed under `<userData>/fleet/runs/` (a stream file per
run, tail-able by anyone), stdin held for live injection — plus the
worker process table (PID, `started-at`, session ref). Its control
surface is a local HTTP endpoint bound to loopback with a token,
rooted under `<userData>/fleet/` — `start/stop/send/status/stream`.
Drey talks to it; so can a terminal (curl) — the owner asked for
command-line reachability explicitly. Ticket-file writes it makes are
the same transition semantics as Drey's (ADR-0076's single-writer
rule): move + stamp + log + one commit, never a free-form edit.

**Run control: Watch, Steer, Stop.**

- *Watch* = the run's stream (file-backed stdout) surfaced in Drey's
  session viewer, plus worker states and heartbeats in the fleet panel.
- *Steer* follows a capability-gated ladder, first rung that the
  provider supports: **live injection** (write to the held stdin of a
  `--input-format stream-json` run), then **stop + resume with
  instruction** (`--resume <sessionRef>` — the session ref comes from
  the provider's capabilities), then typing into the terminal as the
  manual fallback. Every injection and stop is appended to the
  ticket's Log.
- *Stop* = kill-tree by the recorded PID, guarded by the recorded
  `started-at` (a PID may have been reused; the guard prevents killing
  an innocent process). Precedent: `taskkill /T /F` in the git
  runner's cancellation, the CLI providers' kill-tree.

The owner's external session-manager's send API is adapted into the
same Steer affordance (its name and call shape land with milestone
84 — noted as an input, not a decision made here).

**Observability and budgets.** Worker states (idle/running/stopped/
failed), heartbeats, and the headline metric **cycle time — "human
minutes per merged ticket"** (the fleet's whole point is to spend the
owner's minutes only where a human is needed). Budgets per run: max
agent rounds, a cost cap, and a circuit breaker that parks a ticket
back in `inbox` with a `parked-reason` diagnosis instead of burning
the third retry. The owner samples merged tickets for audit (the
semantic gate of M85 — did the diff actually do what the ticket said —
is sampled, not exhaustive).

**No dispatch daemon until the data justifies it.** M84 runs are
on-demand: the owner (or a queue fed by them) starts a run. M85 adds
the dispatcher, reaper and budgets only if the M83/M84 trial shows the
volume. This mirrors the Job Queue decision in `specs/decisions.md`:
no standing infrastructure ahead of a second consumer.

**Git is the interface; hosts are interchangeable.** Nothing in the
fleet speaks to a host API — claims are `git mv` + push
compare-and-swap, branches are plain refs, PRs (if any) are URLs in a
ticket's `references`. Azure DevOps and GitHub differ only in how
their branch policy is configured; `_meta/repos.md` records per repo
which enforcement exists.

## Consequences

- Drey's role is cockpit: it renders board and runs (from the tickets
  repo and the runner's stream files) and forwards control intents.
  All state lives in files and git — Drey restarting loses nothing.
- The runner is one more local process to trust; it is signed by
  nothing, runs as the user, and its HTTP surface is loopback +
  token only. Its writes are limited by construction to the tickets
  repo's semantics and the worker worktrees it created.
- Live injection depends on the provider: a CLI without streaming
  stdin degrades to stop+resume; the ladder makes that a property of
  the provider, not a failure of the fleet.
- The fleet never requires CI anywhere (ADR-0076): the machine gate is
  the ticket's executable acceptance criteria run locally by the
  runner; a work repo's CI (Azure Pipelines, GitHub Actions) is an
  optional second opinion behind the same `ci:` handover spec.
- M84 input needed from the owner: the session-manager send API shape.
- M85 decision deferred with evidence: dispatcher, reaper cadence,
  budget defaults, semantic gate sampling rate.

### Later changes (T-0047 – T-0049)

The run pipeline the fleet actually grew, in three measured steps on
top of this decision:

- **T-0047 — deterministic worktree preparation.** The runner no longer
  assumes a worktree: `prepareWorktree` reuses, creates, recreates or
  moves aside the ticket's checkout per a state table (ADR-0080 records
  the home rule), serialized per repo. A `recreated`/`moved-aside`
  preparation sets `sessionInvalidated` — prior session context is
  stale, which T-0049's handover resolution refuses to resume.
- **T-0048 — run telemetry and the context pack (ADR-0081).** Every run
  records per-turn usage (`lastTurnContext` is the last turn's input
  side, never a cumulative aggregate), `tokensBeforeFirstWrite` as the
  exploration share, and composes instructions as cache-stable context
  packs. This is the measurement base T-0049's gate was decided on:
  across the measured runs, re-exploration before the first write plus
  gate-failure retries re-paying input-side tokens met the ticket's
  start condition via the retry arm.
- **T-0049 — session resume and native compact.** `RunRequest.handover`
  (`fresh` | `resume` | `resume-compact` | `auto`; absent = fresh) is
  resolved once, in the run supervisor after worktree preparation, by
  the pure rules of `main/fleet/handover.ts`: review always fresh; the
  candidate is the newest terminal run of the same ticket + provider +
  model; a warm pause (configurable TTL) or a small context resumes; a
  cold pause with a large context resumes with a native compact first
  (opencode's `/compact` endpoint — measured; claude-code gates on a
  verified effect). The start dialog offers the same three options with
  disabled reasons instead of silent switches. A resume the adapter
  cannot establish never fails the run: the supervisor respawns fresh
  under the same run id. `handoverMode` and `resumedFrom` are recorded
  per run.
