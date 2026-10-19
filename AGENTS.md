# Drey — Agent Instructions

This file is the tool-neutral entry point for coding agents (any tool that
reads `AGENTS.md`). The complete, binding project context lives in
[`CLAUDE.md`](CLAUDE.md) — read it in full before proposing or changing
anything: language conventions, the no-global-Node toolchain, architecture
decisions, ownership map, coding style, and working style all apply to every
agent, regardless of tool.

Tool-neutral operational guides:

- [`plugins/tickets/FLEET.md`](plugins/tickets/FLEET.md) — running and
  diagnosing the fleet runner (agent runs on tickets: status, HTTP surface,
  run files, chain state). Read it when the user asks about the agent
  runner, the fleet, ticket runs, or a stuck/red ticket.
- [`plugins/tickets/BOARD.md`](plugins/tickets/BOARD.md) — working the
  board's owner checkpoints by hand (commit → done: verify implemented,
  merged and pushed, then move per the ticket schema). Read it when the
  user asks about tickets on commit, moving tickets to done, or cleaning
  up the board.
