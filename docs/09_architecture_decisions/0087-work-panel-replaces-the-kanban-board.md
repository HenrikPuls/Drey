# 0087 — The Work panel replaces the kanban board

- Status: proposed (2026-10-31, req-74; owner direction given, the
  stages W1–W9 are confirmed one by one as they start)
- Amends: [ADR-0076](0076-ticket-repository-format-and-coordination.md)
  (the board is no longer the tickets UI; the repository format stays),
  [ADR-0077](0077-continuous-orchestration.md) (the phases become
  internal; the owner sees tracks and states, not columns),
  [ADR-0086](0086-tickets-remote-access.md) (the phone client becomes a
  chat client)
- Relates: [ADR-0075](0075-agent-fleet-architecture-governance-and-run-control.md)
  (the runner stays the engine), [ADR-0084](0084-interactive-runs-at-plan-and-checkpoints.md)
  (the interactive dialog becomes the Shape track)

## Context

The owner does not use the board in its kanban form (2026-10-31). A
usability review of the built app (2026-10-31, eight-phase demo board
with injected runs) found:

- eight ~260 px columns need ~2000 px; in a side dock one clipped
  column is visible, at 1000 px four;
- worker state shows in four places (lane, card chip, panel header,
  takeover tab), tokens in three; every automatic column carries its
  own run controls;
- a waiting question is visible in four places but answerable only
  through the card's context menu ("Open run — running"), and the
  takeover tab shows neither the ticket title nor any context;
- a card does not say whose turn it is; the card menu is mostly
  maintenance (branch, worktree, pins, claim).

The owner's actual flow: capture an idea now, shape it later with a
model until it holds, let small things run on their own, get pinged
only for decisions (with enough context to answer cold after a context
switch), try the result with one button, accept. The same from the
phone. Watch any worker and step in when needed.

## Decision

1. **No kanban.** The tickets panel becomes the **Work** panel: one
   list with collapsible groups — **Needs you** (questions, plans to
   approve, results to try; only shown when not empty), **Ideas** (the
   backlog), **In progress** (shaping and running). An accepted ticket
   goes to the **archive** (ADR-0076's `archive/`); there is no Done
   view. The pipeline's phase folders stay the storage format and the
   runner's working state, but they are not drawn.
2. **Two tracks, chosen at triage.** The model *suggests* a track when
   an idea is captured, the owner confirms: **Auto** (a bug or a small
   change — planned, built, tested and reviewed without asking) or
   **Shape** (a plan-mode dialog with the owner, the project context
   loaded automatically and shown; it ends in a plan, optionally split
   into phase tickets).
3. **One page per ticket.** The ticket tab is the only detail view:
   description, plan, the live worker (current action, recent actions,
   pause / tell / take over / stop), the changes and — once ready — the
   change summary with **Launch this version** (a second Drey from the
   ticket's worktree), **Accept and merge** and **Send back**. The
   separate takeover tab goes away.
4. **A question carries its context.** The worker asks in a fixed shape
   (what the ticket is, where the worker stands, why it asks, options
   with consequences, a recommendation); the Needs-you card and the
   phone render it and answer with one tap.
5. **The orchestrator routes.** A shaped plan becomes phase tickets;
   each is routed to a worker/model by a rules file in the tickets
   repository (first match wins), declares the paths it touches, and
   waits while a running ticket touches the same paths. Before a ticket
   reaches Ready it is rebased on the integration branch and re-tested.
6. **Workers view.** One card per live worker (now, last actions,
   context, time, the same controls); a worker without progress is
   flagged as stuck with "nudge / hand to another worker / stop".
7. **The phone is a chat client.** Every ticket is a conversation; one
   composer captures, answers and shapes; options are compact chips.

## Consequences

- Removes most of the board renderer (columns, lanes, column controls,
  drag between columns, collapsed columns, card order pins in the UI);
  `order.md` and the WIP display lose their reader. The runner, the
  repository format, normalization and the validator stay.
- New contracts: the question shape (worker prompts +
  `specs/classifier-spec.md`), the `## Changes` section and the
  `touches:` key (`specs/ticket-schema.md`), the routing rules file,
  the track field.
- The remote client (req-66) is rebuilt as a chat UI on the same
  gateway and command layer.
- Built and shipped in stages W1–W9 (`specs/roadmap.md`, req-74); this
  ADR moves to accepted with W1.
- Design reference: the owner's canvas "Drey Tickets — Workflow
  redesign" (2026-10-31).
