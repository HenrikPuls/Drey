# 0093 — Persona sessions: the 1:1 is a session of the persona's own harness

## Status

Proposed (design session 2026-11-07/08, owner rulings R1–R4 in
`docs/design/work-panel/crew-internals-concept.md`). Amends ADR-0088's E3
(the coaching thread) and concept v2 §4.5/§4.7 (the persona chat as a direct
call). Resolves D-52 when built (req-165, req-166).

## Context

The Crew tab's 1:1 appends the owner's line to `thread.md`; the persona reads
it at its next run; nothing answers. The owner expects a conversation with
the persona that reads its memory and may write it. The Mission Control chat
and Shape with Paul run over the engine's chat bridge, a direct HTTP call
with the Drey assistant's model; a persona on a CLI worker (Claude Code,
Kimi) has no endpoint that bridge can speak, so over the bridge the
assistant's model would answer, not the persona. The owner also wants the
persona to reach the board and the vault *without* being handed everything:
*"dem Modell nicht alles geben, ihm aber den Zugriff geben"* — a tool call.

## Decision

**A 1:1 is a session of the persona's own harness and model** (worker and
model from its pool), started quiet (req-75's hold) with no ticket and no
worktree, **requested from the pool like any task** (ADR-0095), held while
the conversation continues and released after the idle span (req-157).
A persona with `worker: api` talks over the chat bridge instead — the worker
key decides the way, as today.

**A lean toolset.** The 1:1 session gets read access only: the board and the
tickets (the `fleet_*` and ticket tools), the vault read tools over the
service's MCP (ADR-0094, R5's default), the persona's own memory and journal.
Never the build set, never a shell in a worktree.

**Its context.** `persona.md`, `prompt.md`, the skills, `memory.md`, the
conversation so far, and a short list of the persona's latest runs (ticket,
outcome, cost, gate failure). The board is not embedded; it is asked for.

**Where it lives.** A chat session file under `tickets/_meta/chat/` with a
`persona:` key, in the Mission Control session format: one commit per round,
proposal cards the owner accepts or dismisses. `thread.md` is retired; its
lines migrate once into the persona's first 1:1 session. The context pack's
"Coaching" section goes with it: what the owner wants a run to know lands in
memory or in an accepted proposal, nothing else rides along.

**Memory.** The persona writes `memory.md` directly, so does the owner; every
line carries its author and evidence (date, ticket, persona/model or `you`)
and is removable one by one on the Memory tab; a run writes only when
something was out of the ordinary. Prompt, skill and model changes stay
proposal cards (nothing adopted before a 1:1). A run's *finding* is kept
apart from its *lesson* (R14): the finding goes to `reviews.md` in the
persona folder (one entry per run — model, ticket, gate, cost, `friction:`;
`friction.md` goes up in it and the prompt-proposal aggregation reads the
journal), the lesson to `memory.md`. Both are written in **one closing
round** of the session after the gate verdict, and only **on a signal** (red
gate, retry, an owner steer, cost far above the typical run, self-reported
friction; configurable) — a smooth run costs no round. The report groups
the journal by model, which is what answers "would another model do
better".

## Consequences

- The Crew tab's 1:1 tab becomes a conversation with a live session: the
  composer sends to the session, the answer streams, cards appear for what
  the persona proposes. Mission Control's "Talk to <name> 1:1" (E13-19)
  opens the same session file.
- A 1:1 costs a slot while held and nothing while idle; the pool shows it as
  a session like a run; the service's Sessions area shows it raw.
- Concept §4.7's table row "persona chat → direct" is superseded; the
  reasoning (cheap single shot) loses to identity and tools.
- The context pack loses `personaCoachingSection`; `thread.md` reading goes
  with the migration.
- Open: the exact 1:1 tool list, the line formats of memory and journal,
  and whether Shape with Paul follows into a session once the numbers of
  req-109 are in. A `memory_write` tool during the run is a later item.
