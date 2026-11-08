# 0092 — Drey Service: one shipped, visible background process

## Status

Proposed (design session 2026-11-07/08, owner ruling R6 in
`docs/design/work-panel/crew-internals-concept.md`). Amends ADR-0075 (the
fleet runner as a standalone companion) and ADR-0088 (the engine as its own
process); changes ADR-0021 (the MCP server's home). Built as req-164–163
once the integrator schedules them.

## Context

Drey runs two invisible processes beside itself: the tickets engine
(`~/.drey-engine`, lockfile, spawned by the plugin, never stopped by Drey,
serves the phones with Drey closed) and the fleet runner
(`<userData>/fleet`, detached, idle exit per req-110). Drey's MCP server is a
third thing, in the Drey process, and dies with it. The owner's verification
round of 2026-11-07 hit the consequence twice: the Autopilot could not be
switched on and nothing said why (D-51: no spawn attempt was visible
anywhere), and chats seemed to need the Autopilot (req-154). His ruling:
*"unsichtbare Hintergrundprozesse sind nicht gut."*

## Decision

**One process, shipped with Drey, named Drey Service.** It hosts components
that plug into it: the **Tickets engine**, the **Crew runner** (the fleet
runner, renamed with the product), the **MCP server** (Drey's vault toolset,
ADR-0071, plus the plugin tools, ADR-0077) and the **Remote gateway** (the
phones' HTTP gateway, ADR-0086). Drey is a client of the service, like the
phones: it starts the service when missing, never stops it, and reads its
state over the loopback API with the lockfile's token.

**It is visible.** A tray icon (Windows: the notification area at the right)
shows its state as a dot (green running, amber something needs the owner,
grey stopped), carries a menu (open the service window, open Drey, the
Autopilot state, stop all running steps, start with Windows, quit) and opens
**its own small window** on double-click: a component list with state line,
restart and stop per component, counters, and the filtered, following log; a
**Sessions** area that shows every harness session raw (process, session ref,
tokens, MCP calls; Stream / Instruction / Tool calls / Process; a send line
into the session's stdin, interrupt, resume after stop, open worktree, copy
the attach command). Closing the window keeps the service running; "Quit
service" asks while runs live. Drey's Thread stays the clean view; the
service window is the workshop.

**Settings → Background service** (a core category of Drey's Settings): status
with open/restart/stop, start with Windows, keep running after Drey quits
(the idle span; live runs and a running Autopilot always keep it alive),
tray icon shown/hidden, a switch per component (the engine is always on while
the service runs), log level, log folder (one file per component, rotated
daily, kept 14 days).

**Lifecycle rules carried over.** Single instance by lockfile; survives Drey;
leaves after the idle span when nothing lives and no Autopilot is on
(req-110's verdict, now the service's); the boot rule of ADR-0077 stands
(every start is Autopilot Off). A component's crash restarts the component,
not the service, and shows as a red row.

**Homes and configuration (R13).** The service keeps one `service.json`
(machine scope: model table, capacity cap, providers, keys, paths,
autostart) and per tickets vault one runtime-state file (the former
`chain.json`: autopilot, column states, breaker). Everything that describes
a vault's crew — pipeline, personas, repos, default persona and worker,
permission mode, caps — lives in that vault's `_meta/`; keys that sit in
`~/.drey-engine/config.json` today migrate once. Session-scoped values
(directory, class, pin, handover) live on the session record (ADR-0095).

## Consequences

- One place answers "is anything running, and why not": the tray dot, the
  window, the Settings status. D-51's class of silent failure gets a surface.
- The engine's lockfile, the runner's `runner.json` and Drey's MCP port
  collapse into one service record under `<userData>/service/`; the
  plugin's engine-lifecycle and the engine's runner spawn become component
  starts inside the service. The migration keeps the old homes readable for
  one release.
- Drey's MCP server moves out of the Drey process (ADR-0021 later change):
  programs on the machine and the workers (ADR-0094) connect to the service;
  the stdio bridge keeps its name and env variable. What the in-process
  server could do and the service cannot — read and change a note through
  its open Drey tab (milestone 78) — is handled as ADR-0094 says.
- The renderer gains a Settings category and the title bar nothing; the
  status bar's Autopilot item stays. The window is an Electron window of
  the service process (the service is an Electron app run headless until
  the window is asked for), so it ships with the installer and needs no
  second runtime.
- Risk: a tray icon is a second entry point; it must never start a chain
  (the boot rule) and never show a token.
