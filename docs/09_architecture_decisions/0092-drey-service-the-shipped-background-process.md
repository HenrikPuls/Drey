# 0092 — Drey Service: one shipped, visible background process

## Status

**Accepted — as built (milestone 209, req-164)** for the process, its
components, discovery and lifecycle; the deviations are listed under "As
built" below. The tray icon, the window and Settings → Background service
(req-165), the Sessions area (req-166), the MCP server's move (req-167) and
`service.json` / the three configuration layers (req-173) remain proposed
in this ADR until those items ship. Design session 2026-11-07/08, owner
ruling R6 in `docs/design/work-panel/crew-internals-concept.md`. Amends
ADR-0075 (the fleet runner as a standalone companion) and ADR-0088 (the
engine as its own process); will change ADR-0021 (the MCP server's home)
with req-167.

## Context

Drey runs two invisible processes beside itself: the tickets engine
(`~/.drey-engine`, lockfile, spawned by the plugin, never stopped by Drey,
serves the phones with Drey closed) and the fleet runner
(`~/.drey-engine/fleet`, detached, idle exit per req-110). Drey's MCP server is a
third thing, in the Drey process, and dies with it. The owner's verification
round of 2026-11-07 hit the consequence twice: the Autopilot could not be
switched on and nothing said why (D-51: no spawn attempt was visible
anywhere), and chats seemed to need the Autopilot (req-154). His ruling:
*"unsichtbare Hintergrundprozesse sind nicht gut."*

Building it raised the question whether a process outliving Drey should exist
at all by default (question Q3 of req-164, 2026-11-08). The owner weighed it:
Drey could stay open in the taskbar while a run goes on, but then Drey must
end the runs on exit — or a backend service that is started on demand and
independently of Drey **when it is activated**, and otherwise not. *"Ich
bevorzuge den optionalen Service."*

## Decision

**The background service is optional (owner ruling on Q3, 2026-11-08).**
`service.enabled`, default **off** (Settings → Tickets → Background service
until req-165 gives it its own category):

- **On:** the service runs independently of Drey — started on first need,
  and with Windows when `service.autostart` is on — and outlives Drey with
  the lifecycle below.
- **Off:** the components live and die with Drey. Closing Drey while an
  agent run is live asks first — *Stop the runs and quit* / *Keep running
  (enable the service)* / *Cancel*, the save-before-exit prompt's pattern —
  and nothing survives Drey. The engine's former behaviour (outliving Drey,
  serving the phones with Drey closed) is now conditional on the setting.

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

## As built (milestone 209, req-164)

What req-164 built, and where it differs from the decision above:

- **Components.** `packages/tickets-engine/src/service/`: `ServiceHost` hosts
  the **engine** (always on), the **Crew runner** — in the service's own
  process, not a child process: `startRunner` runs in-process with no
  descriptor file and no signal handlers of its own, its exit is a sleep and
  the next demand wakes it (one process fewer than before) — the **remote
  gateway** (inside the engine; its row follows Settings → Remote access)
  and the **MCP server** as a row reading `external — served by Drey (until
  req-167)`: Drey's MCP server stays in the Drey process for now
  (integrator's ruling Q1, 2026-11-08). Only the runner has start/stop of
  its own; the engine runs as long as the service, the gateway follows its
  settings.
- **Home (deviation).** The service home is `~/.drey-engine`, not
  `<userData>/service/` (integrator's ruling Q4, 2026-11-08): the engine's
  `config.json`, the fleet root `~/.drey-engine/fleet` (the Context's
  `<userData>/fleet` was stale) and the e2e isolation through
  `USERPROFILE` stay where they were. req-173 may move it.
- **Discovery.** One `service.lock` (pid, build stamp, control port + token,
  a record per component with the runner's own port and token) replaces
  `engine.lock` and `fleet/runner.json`. The control port serves `/health`,
  `/status`, `/log`, `/shutdown` (`{handover: true}` for a newer build) and
  `/components/runner/start|stop`; its token is the engine's.
- **One log.** `service.log`, one line per event with the component as a
  field, capped at 1 MB. The per-component files rotated daily and kept 14
  days, the log level and the log folder are Settings → Background service
  (req-165).
- **Sleep, two levels (background mode).** The runner keeps req-110's verdict. The service
  leaves when no Drey holds the engine's event stream (`DreyPresence`), the
  runner sleeps and **no enabled remote gateway with at least one paired
  device** holds it (integrator's ruling Q2, 2026-11-08 — the ADR's "keep
  running after Drey quits" did not say what keeps it for the phones) — for
  `service.idleMinutes` (15). The boot rule of ADR-0077 stands.
- **Drey as a client.** `plugins/tickets/main/service-lifecycle.ts`
  (`ensureService`) adopts a live service of the same or a newer build,
  asks an older one for the handover (req-51's rule, now for the whole
  service; refused while a run gates — Drey then adopts it and asks again on
  its next start, where the old fleet client asked again on every poll), or
  starts one. A boot claim keeps two Dreys from starting two.
- **Optional, as the owner ruled (Q3).** `service.enabled` (default off) and
  `service.autostart` are switched in Settings → Tickets → Background
  service; Drey writes them into the engine's config and the service
  re-reads its mode every tick. **With Drey** (off): once no Drey has held the
  event stream for 10 s (2 min for a Drey that never came) the service stops
  its live runs and leaves — a paired phone does not keep it; closing Drey
  with live runs asks through a quit guard (SDK 1.53,
  `ctx.app.registerQuitGuard`, run by `main-window.ts` after the
  save-before-exit prompt). **Background** (on): the two-level sleep below.
  *Keep running* at the prompt switches the service on and the running
  service follows within a tick.
- **Process mode (decided here, owner left it open once the service was
  optional).** Node under Electron's binary (`ELECTRON_RUN_AS_NODE`), not
  a headless Electron (`Drey.exe --drey-service`): neither "enabled → starts
  with Windows" nor "disabled → dies with Drey" needs Electron, and Node
  mode costs no Chromium — the ~50–80 MB the owner watches. Start with
  Windows is a hidden `wscript` launcher in the service home
  (`start-service.vbs`, it sets the variable and starts the service with no
  window) named by the per-user `Run` value `DreyService`; the service
  applies it whenever `enabled && autostart` changes and removes the value
  only when it is its own home's. The tray of req-165 is the one part that
  needs Electron; it can be a small window process started on demand. The
  ADR's "Electron app run headless" sentence is superseded by this.
- **Migration.** On its first start the service ends a pre-service engine
  (by pid, after that engine's own health check answered with its own token)
  and asks a pre-service runner for the handover; both lock files go. A
  runner that refuses keeps the Crew runner component blocked until it has
  gone. `config.json` keys stay where they are (req-173 moves them).
- **Command line.** `service-main.js --version | --status | --stop |
  --autostart on|off|status`; operations in `plugins/tickets/SERVICE.md`.
