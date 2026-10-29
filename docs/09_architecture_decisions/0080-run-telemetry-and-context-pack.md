# 0080. Run token telemetry, output capping and the plan context pack

## Status

Accepted (T-0048)

## Context

The fleet's cost was invisible: a run reported two cumulative token
numbers and nothing else, so the questions that decide the next steps —
how big is a worker's context really, what does a phase cost, how much
of a run is exploration before the first write — had no data. At the
same time instructions carried whatever the previous run had produced
(a gate failure cut to its first line, no diff context), and their text
varied per ticket from the first byte, so nothing of a previous run's
prompt could be reused warm. Cache semantics also differ per provider:
the pinned plan provider may report no cache counters at all, and the
adapters' aggregate usage (`result.usage` on Claude Code, the session
`tokens` on OpenCode) is cumulative — none of it is a context size.

## Decision

- **Telemetry lives on `RunInfo`** (`run.json`) — no second store. The
  adapters emit exactly one `turnUsage` event per assistant model call
  and the tool name on every tool-call note; the supervisor folds them
  into `usage` (summed per counter), `lastTurnContext` (the LAST turn's
  input+cacheRead+cacheCreation — never an aggregate), `turns`,
  `readCalls` and `tokensBeforeFirstWrite`. `GET /report` on the runner
  groups the numbers by ticket, phase and model.
- **Absent, never zero**: a counter the provider never reported is
  `null` through every sum and renders as absent (0 is a measurement;
  absence is not). Pre-T-0048 records keep their cumulative
  `tokensIn`/`tokensOut` as the report's fallback.
- **Instructions are context packs with a stable prefix**: repo agent
  instructions (verbatim, `CLAUDE.md` preferred) → phase template → the
  ticket's `## Plan` verbatim → the variable parts (who/where,
  description, diff stat, gate failure on retry, gate commands,
  completion discipline). The prefix up to the plan is byte-identical
  for any two runs of the same repo and phase — the cache-stability
  anchor is the composed instruction, not the CLI's auto-load.
- **Capped injections, logged**: a gate failure is stored multi-line but
  sanity-bounded (400 lines / 64 KiB) on the record and injected as a
  configurable tail (default 40 lines / 4096 bytes); the diff stat rides
  as a configurable head (50 / 4096). Keys `fleet.cap.*`; every
  application is logged with `truncated: true, originalSize`. The ticket
  Log keeps its single-line discipline (`shortGateLine`).

## Consequences

- The per-turn truth is pinned by fixtures: a cumulative aggregate can
  no longer silently pose as a context size (multi-turn specs per
  adapter fail loudly on that regression).
- T-0049 (Resume/Compact, handover modes) decides on data: the report
  shows per-phase cost and the share of tokens before the first write;
  `handoverMode: 'fresh'` is already written on every record.
- The repo instructions are duplicated in the instruction (the CLI also
  auto-loads them); the duplication is now measurable and is T-0049's
  to revisit with data.
- Adopted runs (a runner restart mid-run) restore their fold from the
  persisted record — telemetry survives the restart; the
  before-first-write split is derived from it exactly.
