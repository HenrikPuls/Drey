---
name: ticket-handling
description: >
  Working the tickets board's owner checkpoints by hand — the commit →
  done discipline. Use this whenever the user asks about tickets on the
  commit column, moving tickets to done, cleaning up the board, or whether
  a ticket's work is fully implemented, merged and pushed to main (via
  pull request where direct commits are forbidden); also when they say
  "räume auf" for the commit column, ask which tickets are finished, or
  want the schema-exact git move performed or checked — even if they just
  say "handle the tickets".
---

# Ticket handling — the board's owner checkpoints

The harness-agnostic guide lives in the repo at
[`plugins/tickets/BOARD.md`](../../plugins/tickets/BOARD.md) — read it
and follow it. That file is the single source of truth (the rule, the
git-only evidence recipe, the schema-exact move); this shim exists only
so skill-capable harnesses can trigger on ticket-handling asks. A
pointer to the guide is also in `AGENTS.md`, which every tool reads.
