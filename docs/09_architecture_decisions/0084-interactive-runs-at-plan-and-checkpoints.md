# 0084 — Interactive runs at the plan phase and every checkpoint

## Status

Accepted (req-65)

## Context

The fleet's runs are machine-shaped: the dispatcher pulls a ticket, the
worker gets one composed brief, and its finished turn means done — the
machine gate runs, a green gate moves the ticket one column right. The
owner's checkpoints (plan-review, review, commit) exist exactly because
that automation is not wanted everywhere: only the owner's moves cross
them. But when the owner *wants* a worker — refining a ticket's plan in
a conversation instead of by hand or with an outside LLM, or walking a
checkpoint with one — the board offers no way in. Run takeover (ADR-0079)
presupposes a machine-driven run that is already going, and taking over
mid-run is the wrong shape: the brief was written for a lone worker, not
for an interview.

Two gaps in the base compound it. The plugin SDK cannot open a tab in a
split pane (`documents.open`/`addDoc` always land in the focused pane),
so ticket and dialog cannot sit side by side — the shape a conversation
over a ticket needs. And the reservation of a ticket for a dialog has no
representation: a ticket in `plan` (an automatic column) would be pulled
by the dispatcher the moment no run is live on it.

## Decision

**A run can be interactive** — `RunRequest.interactive: 'plan' | 'refine'`.
It differs from a dispatched run in exactly three ways:

- **The owner's from turn one.** The worker is held at spawn (the
  ADR-0079 hold, applied before the first turn finishes): it works its
  first, interviewing turn and then stands. The takeover tab is the
  dialog surface from the start.
- **No gate, no move.** However the worker exits, the run finishes
  `done` without the machine gate and without a move. The brief's
  completion discipline is replaced by a dialog discipline: end turns
  with a question, never claim a move. The asking protocol (`QUESTION:`,
  req-64) is the interview loop; it rides every brief already.
- **The owner moves the ticket.** The takeover tab shows the dialog's
  end moves, computed from the column the ticket sits in: a plan dialog
  finishes into the checkpoint or, when the owner settled the open
  points in the dialog itself, approves straight past it; a refine
  dialog goes on to the next column or back to the nearest agent column
  for rework. Picking one stops the run (if it lives) and performs the
  ordinary transition — an owner move, never gate-checked. Closing
  without a move keeps everything as it is; reopening the session
  ("Resume session") continues the dialog later.

**The reservation is frontmatter.** An interactive start lays
`interactive: true` on the ticket (the runner, per ADR-0076's
single-writer rule); the dispatcher holds off while the field stands and
a board move drops it. A live run's `run:` stamp protects only while the
run lives — the field covers the time between two dialogs. Only a bare
`true` reads as set.

**The prompts are shipped seeds.** `plan-interactive-default`
(interview-first plan-default: same output discipline — `## Plan`,
fields, `### Acceptance criteria`, Log — but questions before writing)
and `refine-interactive-default` (one phase-aware checkpoint companion:
verify with the owner, approved fixes as small commits on the branch,
the verdict in the ticket Log; at commit also the push). A column can
override them with the pipeline's `interactive:` key; absent, the plan
column gets the plan default and every other offered column the refine
default. They are offered — one click, no form — on the pipeline's first
automatic column ("Plan with agent"), the owner's checkpoints and the
last automatic column ("Refine with agent"), in the card menu and the
ticket header.

> **Later change (req-72).** The offer rule moved: refine is offered in
> **every manual column** — the queues before the first automatic column
> included, and a board without any automatic column offers it everywhere
> but the terminal — while the automatic columns (`agent`, and `ci`
> counted as automatic) offer none: the runner works them, the takeover
> tab is the machine's. The last automatic column therefore no longer
> offers a dialog. End moves are unchanged. Rationale: the owner's
> columns are theirs to dialog in, wherever they sit.

> **Later change (req-75).** The dialog starts quiet: an interactive run
> spawns held with **no first prompt** delivered — the worker stands,
> the session live — and the composed brief rides the owner's first
> message (the first send wraps it around the text once; the record
> carries `quietStart` until then, and the thread's composer comes
> pre-filled with the step and its meaning). Held handover resumes go
> silent the same way: the internal continuation prompt that caused
> the observed no-op turns is deleted. Claude Code has no hold at
> spawn; its dialogs keep today's first posted turn.

**The base gains the split seam.** SDK 1.35: `documents.open` and
`documents.addDoc` take `split: 'right' | 'down'`; the tab lands in a
fresh pane beside or below the focused one. It is a landing request — an
already-open tab still just reveals, a dock band falls back to a plain
open, and the focused pane's clean tab is never replaced (the call asked
to open alongside). The board uses it to open ticket and dialog side by
side.

## Consequences

- The fleet's run record, HTTP surface, stream format and MCP tools are
  unchanged: an interactive run is a normal run record with two extra
  fields (`interactive`, plus the pre-existing `held`), so terminals and
  the runner's own bookkeeping need no branch.
- The dialog costs a held worker slot per conversation, outside every
  pool's accounting (owner runs never took pool slots); a forgotten
  dialog holds the ticket (by stamp and reservation) until the owner
  ends it — acceptable for an explicitly owner-owned surface, the reaper
  never touches a live worker.
- A manual checkpoint column has no prompt of its own; the interactive
  prompt resolution is the one place a brief is composed for it. The
  acceptance-criteria refusal lifts for interactive runs (a plan dialog
  is how criteria come into existence).
- The reservation is advisory to everything but the dispatcher: human
  moves, claims and the owner's own starts are never refused because of
  it.
