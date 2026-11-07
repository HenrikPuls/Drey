# 0095 — The model table and the capacity pool: classes, cost factors, a cap, no downgrade

## Status

Proposed (design session 2026-11-08, owner rulings R9 and R10 in
`docs/design/work-panel/crew-internals-concept.md`). Settles req-112 (the
model budget) and absorbs req-63's `fleet.pool.<provider>.size` and
req-113's per-ticket allowance. Amends ADR-0077 (provider pools) and concept
v2 §4.6 (the router policies). Built as req-167.

## Context

The owner runs the agent sessions of this redesign by hand with a fixed pool
of slots per model and gives every task the model its importance and
complexity warrant. req-112 asked for that as an engine function; what a slot
is, who ranks a task and what a waiting session does were open. The ruling,
in his words: *"jedem Modell sollte man eine Kategorie zuordnen können und
eine Capability-Klasse und einen Kostenfaktor; in den Settings soll definiert
werden, wie hoch der gleichzeitige Verbrauch sein darf. Wenn gerade nicht
genügend Kapazität vorhanden ist, dann soll abgelehnt werden und nicht einfach
eine kleinere Stufe verwendet werden. Nur die aktiven Sessions werden gezählt,
dann wartet er auf den Slot."*

## Decision

**Settings → Models is a table.** One row per model: id, provider,
**category**, **capability class**, **cost factor**, and per provider the
number of concurrent sessions it serves. A persona's `models.pool` is chosen
from this table only (strongest first); the router policies of §4.6 are
replaced by the class request below.

**A capacity cap.** Settings define how much may run at once: the sum of the
cost factors of the **active sessions** may not exceed the cap (one per
provider, one global). Only active sessions count — a held 1:1 counts, a
queued task does not.

**A session requests a class.** Every unit of work (ADR-0093: a run, a 1:1,
later Shape) asks the pool for `{persona, class, context size}` before it
starts. The pool grants a model of **exactly that class** from the persona's
pool with capacity left — **never a smaller class** — or the session
**waits**: no process is spawned, the card reads "queued · waits for a
<class> slot", Pia can explain it, the dispatcher takes the next task whose
class has capacity. A quota or rate-limit refusal from the provider shrinks
that provider's capacity for a while (req-63's rule stands).

**Three ledgers.** Ticket allowance (`allowance:` in the frontmatter,
req-113), persona per day (`budget:` in `persona.md`), provider per day
(Settings). A full ledger grants no slot and raises a Needs-you card; the
persona's `allowed:` says whether it may spend above the allowance or must
wait for the owner. Counting happens on the session record only (run
telemetry, ADR-0081): the ticket's cumulative cost, the persona's day, the
provider's day and the report's groups are sums of it.

**Who asks for which class — assumed, to be confirmed.** Paul gives each plan
part a size (S/M/L) that maps to a class; a phase has a floor in
`pipeline.md` (plan and review not below class B); a ticket pin (`model:`)
overrides; the owner can change the class on the card. The decision sits
where the knowledge about the task arises and stays auditable in the run
record (the model that actually ran, as §4.6 demanded).

## Consequences

- `fleet.pool.<provider>.size` becomes a column of the model table; the
  Capacity band and the Crew tab draw slots per persona from the same
  record.
- "Smallest sufficient model" (req-112's wording) is rejected: a task that
  cannot have its class waits. The owner accepts latency over a weaker
  answer.
- The Persona page shows the pool rows with class, factor and busy slots and
  links to Settings → Models for the definitions (req-168).
- Mission Control gains the queue as a reportable state ("why is T-0122
  waiting") and a pin as a proposal card ("take opus for T-0130").
- Open: the class names (A/B/C or words), whether the global cap is in cost
  factors or in sessions, the mapping S/M/L → class, and the Settings →
  Models design pass (described, not drawn).
