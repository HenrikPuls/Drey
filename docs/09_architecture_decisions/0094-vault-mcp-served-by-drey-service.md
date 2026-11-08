# 0094 — The vault MCP for workers is served by Drey Service, with per-run tokens and persona permissions

## Status

Proposed (design session 2026-11-07/08, owner rulings R5 and R7 in
`docs/design/work-panel/crew-internals-concept.md`). A later change of
ADR-0071 (one vault toolset) and ADR-0075 ("vault access for a worker goes
through Drey's governed MCP server" — promised, never wired). Gives req-142
its enforcement. Built as req-167.

## Context

No worker is given an MCP server today. Drey's MCP server lives in the Drey
process and dies with it; the runner and the engine survive Drey on purpose
(ADR-0075, ADR-0088), and the engine already reads and writes the vault
directly for the phones (Notes API, req-100) with ADR-0060's mtime guard but
without save hooks or the local history. A run that depends on Drey being
open would be a run that fails when the owner closes the laptop lid.

## Decision

**Drey Service (ADR-0092) serves the vault MCP** that runs and 1:1 sessions
use. Same tool names and semantics as ADR-0071 — `vault_list`,
`vault_search`, `vault_read`, `vault_edit`, `vault_write`, `vault_move` —
built on the shared pure code (`shared/text-edit`, `shared/note-search`,
`shared/frontmatter`), the path the Notes API already walks; this is the one
toolset, hosted in the service instead of the Drey process, not a plugin-owned
twin. `vault_delete` is not offered to workers.

**Rights (R5).** Without an entry in the persona record a run **reads every
registered vault and writes none**. `persona.md` grants writing per vault
(`allowed:`; req-142's block also covers commands = the harness permission
mode, network, spending above the allowance). No confirmation dialog: a
detached run cannot wait for a click; a refused write returns `Error: <who>
may not write vault "<id>" (allowed: read)` to the model (ADR-0071's
convention) and is logged. The tickets repository is reached by no vault
tool.

**Authentication.** The service mints a **token per run (or 1:1 session)** at
spawn and hands it to the worker in its MCP configuration — claude-code
`--mcp-config`, opencode its config file in the worktree, Kimi by its
capability; a harness without MCP gets no vault and the run log says so (a
capability of the adapter, like the steer ladder). Token → run → persona →
permissions. Every call is appended to the run's stream and visible in the
service's Sessions area (the audit of ADR-0075). The token ends with the
run. The device tokens of the remote gateway (milestone 204) stay the
phones' and never reach a worker.

**What a write does not do.** It does not pass through an open Drey tab
(milestone 78's `OpenDocsBridge`) and leaves no entry in the local history.
ADR-0060's mtime guard refuses a stale write; Drey's vault round reloads
clean tabs and marks dirty ones "Changed on disk". If this bites in practice,
the service may route a write to Drey while Drey is up (the proxy variant the
owner saw and did not choose now).

## Consequences

- A run has the vault whether Drey is open or not; so does a 1:1.
- Programs on the machine (Claude Desktop, the stdio bridge) connect to the
  service as well; `mcp.enabled` / `mcp.yolo` keep their meaning for them,
  while a worker's rights come from its persona, never from `mcp.yolo`.
- The per-run token is a second token kind beside the device tokens; both
  are hashes at rest in the service record.
- ADR-0071's rule "a new vault capability goes into this set" stands; the
  set moves house.
- Open: the exact 1:1 read set; whether `vault_move` is a write right or
  its own right.
