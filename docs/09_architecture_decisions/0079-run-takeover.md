# 0079 — Run takeover: the owner holds a live run, interrupts it and drives it by prompt

- Status: accepted (2026-10-19, milestone 87; owner request, outside the list)
- Amends: [ADR-0077](0077-continuous-orchestration.md) (agent-decided completion: a finished turn ends the run — not
  while the owner holds it)
- Companion: [ADR-0078](0078-markdown-view-for-plugins.md) (the tab's transcript and prompt box)

## Context

The board showed a run and could steer it with one message or kill it. Neither lets the owner *work with* the worker:
stop what it is doing without losing its context, look at what it did, tell it something else, and either leave it to
the runner again or finish. Worse, a finished turn ends the run (ADR-0077) — the opencode adapter kills its server on
the session's `idle` marker — so a worker that was interrupted would simply end and be gated.

Reaching the worker's own UI through the in-app browser was considered and rejected: Claude Code has no web UI, the
opencode server needs a per-boot password, and the runner would not know a human drives the session.

## Decision

- **A hold on the run.** `POST /takeover` marks the run `held` (`RunInfo.held`) and tells the worker handle to hold
  (`WorkerHandle.setHold`). While held, the opencode adapter does not count an `idle` marker as the end of the run, and
  the supervisor's reaper does not reap a quiet held run by staleness (a dead process still is reaped).
- **Soft interrupt.** `POST /interrupt` (held runs only) calls `WorkerHandle.interrupt` — opencode's session interrupt,
  bounded by `INTERRUPT_WAIT_MS` — so the turn ends and the session, its context and the server stay (unlike `stop`).
- **The owner's prompts** go through the existing `send`; the supervisor writes each into the run's stream
  (`you › …`), and the adapter only counts an idle marker newer than the last prompt, so the turn that follows a
  prompt ends the run correctly after hand-back.
- **Hand back.** `POST /release` lifts the hold. A worker that is idle by then has finished its turn: the run ends and
  the machine gate decides, as after any finished turn; a busy worker carries on.
- **The tab** (`tickets-takeover`, key `takeover://<runId>`): banner with who drives, light, context and tokens and the
  controls; the transcript — the normalized stream rendered as Markdown (`transcript.ts`) — in the host's read-only
  Markdown view; the prompt in a compact view. Opened from a lane's "Take over", which holds the run first.
- **Providers.** Only a handle with `setHold` can be taken over; the runner answers a clear refusal for the others.
  Claude Code has none yet (no verified soft stop in its stream-json mode).

## Consequences

- The run record carries `held`; a runner restart still turns a live run `detached` (ADR-0075) — the hold dies with it.
- A held run is never ended by the runner on its own: the owner must hand it back or stop it. A forgotten hold keeps its
  pool slot busy, which is why the banner and the lane say who drives.
- The takeover surface is the same for every provider that gains `setHold` / `interrupt`; the transcript needs only the
  normalized stream.
