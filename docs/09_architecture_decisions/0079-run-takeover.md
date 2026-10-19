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

## Re-attach (later change, 2026-10-19)

A runner restart no longer has to orphan a worker (ADR-0075 v1: "does not re-attach"). OpenCode's worker is a server
with its own session; only the runner's grip on it is lost. So:

- When the server is up, the spawn records `attach.json` in the run's folder — address, the per-boot credential, the
  process and its creation time. It is a file of its own, never part of `run.json` (which the board reads), written
  owner-readable where the platform honours it and removed when the run ends.
- `adopt()` at boot tries `reattach` before detaching: a non-terminal run (also an already detached one) whose recorded
  process lives gets a handle bound to the running server (`ProviderAdapter.attach`): same steer / interrupt / stop /
  hold surface, polling resumes, messages already in the stream are not emitted twice, a `held` run stays held, the
  ticket's run stamp is restored for a run that had been detached. An attached worker has no process handle, so the
  adapter kills through a supplied function guarded by the recorded creation time (no pid reuse) and treats three failed
  polls in a row as the server being gone.
- A worker that finished its turn while nobody watched is idle by re-attach time: its idle marker ends the run and the
  gate decides, as for any finished turn.
- Claude Code workers cannot be re-attached (their stdio pipes belong to the dead runner); they still detach.
- Taking over a run in another phase later needs nothing more than this seam.

## Implicit takeover, resume, running or standing (later change, 2026-10-19)

- **One button, no hold on open.** A lane has one "Open" button; opening the tab only watches — the runner keeps
  driving. The hold is taken implicitly at the owner's first command: `send` and `interrupt` call `holdForOwner`
  (hold once, log "taken over by the owner (first prompt | interrupt)"), so the explicit "Take over" step and button
  are gone (`POST /takeover` stays for the API). Hand back stays an explicit button, shown while held. The earlier
  rule "opened from a lane's Take over, which holds the run first" no longer applies.
- **Resume a detached run.** A run the runner cannot re-attach (Claude Code, a gone process, no attach file) keeps its
  provider session. `POST /resume` ends the detached record as `stopped` and starts a fresh worker with
  `resumeRef` = that session, under a new run of the same request and a short "session resumed — continue" brief. The
  owner gets an attached run again; a run that never reported a session cannot be resumed.
- **Running or standing.** `RunInfo.turn` (`busy | idle`) is the worker's turn state: the opencode adapter reads it
  from the newest message of the session (an idle marker = standing, anything else = mid-turn) and emits it on change.
  The board shows it everywhere a run is shown: a breathing green light and "Running", a hollow gray one and "Standing"
  (with "— you drive" when held); a standing worker is never "stalled".

## Runs survive a Drey rebuild (later change, 2026-10-19, req-51)

The owner develops Drey with Drey's own fleet, running the checkout under `npm run dev`. Every rebuild retired the
runner, because its build stamp was the mtime of `runner.js` and tsc rewrites every file. `/shutdown` then stopped all
live workers. Three changes:

- **The stamp is a content hash** (`fleet/build-stamp.ts`): `<builtAt>#<hash>`, where the hash covers `runner.js` and
  its relative `require` closure (`fleet/`, the ticket-file helpers, `plugins/tickets/shared/`, the repo's `shared/`),
  and `builtAt` is the newest mtime among those files. The same hash is never stale. A different hash retires only an
  older daemon, as before, so two checkouts sharing a fleet root still don't retire each other in a loop. A stamp
  without a hash (a pre-req-51 daemon) compares by date. The client re-hashes only when the entry file's mtime moves.
- **Retirement is a handover, not a stop.** The client sends `POST /shutdown {handover: true}`. The runner refuses
  with 409 while a run is gating, starting or stopping, because the ticket move or the stop's Log line would be lost.
  The client then keeps using the old runner and asks again on its next poll, logging the reason once. Otherwise the
  runner starts nothing new and writes `handover` (`reattach | resume`, the worker's creation time) into each live
  record. It leaves a worker with an `attach.json` running and stops any other worker, because a worker whose pipes
  nobody reads is unsupervised (the T-0007 review). It exits only after that, so the successor's boot guard can't
  overtake it. The successor's `adopt()` tries `reattach` first. A handed-over run it cannot bind to is **resumed in
  place**: any worker still alive is killed (guarded by the recorded creation time), and a fresh worker resumes the
  provider session under the same run id, record, stream and ticket stamp. Its opening line depends on whether the run
  was held: an unheld run "continues the step", a held one finishes the owner's request or reports back and waits. It
  then ends like any run, through the gate. A handed-over run that never reported a session detaches as before. The
  owner's Stop, Notaus and a plain `POST /shutdown` keep stopping runs. A run that has been handed over refuses a stop
  until its successor has it.
- **Each supervisor adopts only its own provider's runs.** Both supervisors used to adopt every record, so the Claude
  Code one detached an OpenCode run the OpenCode one had just re-attached.

The takeover tab saves its title in the session, so a restore no longer depends on the first fleet snapshot having
arrived, and the tab reconnects to its run (the same id after a handover).

## Consequences

- The run record carries `held`; a runner restart turns a live run `detached` only when it cannot be re-attached
  (Claude Code, a gone process, no attach file) — the hold dies with it then.
- A held run is never ended by the runner on its own: the owner must hand it back or stop it. A forgotten hold keeps its
  pool slot busy, which is why the banner and the lane say who drives.
- The takeover surface is the same for every provider that gains `setHold` / `interrupt`; the transcript needs only the
  normalized stream.
