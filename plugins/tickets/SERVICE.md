# Drey Service — operations guide

Drey Service is the one background process shipped with Drey (req-164,
milestone 209, [ADR-0092](../../docs/09_architecture_decisions/0092-drey-service-the-shipped-background-process.md)).
It replaced the detached tickets engine and the detached fleet runner. This
file is the tool-neutral guide for the owner at a terminal and for coding
agents; the Crew runner's own routes, run states and diagnosis stay in
[FLEET.md](FLEET.md).

## Components

| Component | What | State |
|---|---|---|
| **engine** | the tickets engine (ADR-0088): board service, chat, verify, the invoke channel Drey talks to | always `running` while the service runs |
| **runner** | the Crew runner (the fleet runner, ADR-0075), **in the service's own process** | `sleeping` until something needs it, `running` while awake, `failed` with the reason when it cannot start |
| **gateway** | the remote gateway for phone and iPad (ADR-0086), inside the engine | `running` (address, paired devices), `stopped` (remote access off) or `failed` (why it does not listen) |
| **mcp** | Drey's MCP server for other programs | `external` — still served by the Drey process until req-167 moves it |

The tray icon, the service window and Settings → Background service are
req-165; the Sessions area req-166. Until then the service is seen through
`--status`, its control port and `service.log`.

## Where everything lives

The service home is `~/.drey-engine` (`%USERPROFILE%\.drey-engine`) — the
engine's home before, unchanged so `config.json`, the fleet root and the
e2e isolation stay where they were (req-173 may move it).

```
~/.drey-engine/
├── service.lock        discovery: pid, build, control port + token, one record per component
├── service.log         the one log: `<ISO time> <level> <component> <message>`, capped at 1 MB
├── service-start.log   stdout/stderr of the last start (a start that dies says why here)
├── config.json         the engine's config (keys unchanged; `service.vaultPath`, `service.idleMinutes`, `service.autostart` added)
└── fleet/              the Crew runner's root (FLEET.md): runs/, chain.json, runner.log
```

### `service.lock`

Written owner-only and atomically, rewritten whenever a component changes:

```json
{
  "version": 1,
  "pid": 12345,
  "build": "2026-11-08T10:00:00.000Z#9f3c…",
  "startedAt": "2026-11-08T10:01:02.000Z",
  "home": "C:\\Users\\me\\.drey-engine",
  "vaultPath": "E:\\notes",
  "port": 51234,
  "token": "<bearer of the control port AND the engine's invoke channel>",
  "components": {
    "engine":  { "state": "running",  "detail": "E:\\notes", "port": 51233 },
    "runner":  { "state": "running",  "detail": "127.0.0.1:51240", "port": 51240, "token": "<runner bearer>", "pid": 12345, "build": "…" },
    "gateway": { "state": "running",  "detail": "http://192.168.1.20:47811 · 2 paired devices", "port": 47811 },
    "mcp":     { "state": "external", "detail": "served by Drey (until req-167)" }
  }
}
```

It replaces `engine.lock` (the engine's port + token) and
`fleet/runner.json` (the runner's). A device never sees it: phones reach
the gateway through their pairing, never these tokens.

## Command line

The entry is `dist-electron/packages/tickets-engine/src/service/service-main.js`
(in a packed build inside the app's resources). It is Electron-as-Node:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "<Drey.exe or node_modules\electron\dist\electron.exe>" "<...>\service-main.js" --status
```

| Command | What |
|---|---|
| `--status` | the components, read from `service.lock` and `/status`; exit code 3 when not running |
| `--version` | the app version and the build stamp |
| `--stop` | asks the service to leave (live runs are stopped first, like the owner's quit) |
| `--autostart on\|off\|status` | start with Windows (opt-in, off by default): the per-user `Run` value `DreyService` |
| `--vault <path> [--home <dir>]` | run the service (what Drey does); without `--vault` the last one from `config.json` |

## Control routes

Every route needs `Authorization: Bearer <token>` from `service.lock`.

```powershell
$l = Get-Content "$env:USERPROFILE\.drey-engine\service.lock" -Raw | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($l.token)" }
Invoke-RestMethod "http://127.0.0.1:$($l.port)/status" -Headers $h
```

| Route | What |
|---|---|
| `GET /health` | `{ok, pid, build}` |
| `GET /status` | `{pid, build, startedAt, vaultPath, components, sleep, dreyClients}` — `sleep` is `{sleep: true}` or `{sleep: false, reason: "drey" \| "runner" \| "remote gateway"}` |
| `GET /log?tail=N&component=<name>` | the log tail, plain text, optionally one component |
| `POST /components/runner/start` | wake the Crew runner |
| `POST /components/runner/stop` | put it to sleep — its live runs are stopped first |
| `POST /components/<engine\|gateway\|mcp>/<start\|stop>` | 409 with the reason: the engine runs as long as the service, the gateway follows Settings → Remote access, the MCP server is Drey's until req-167 |
| `POST /shutdown` | leave: live runs stopped, engine closed, lock removed |
| `POST /shutdown` `{handover: true}` | what a newer Drey build sends: the runner hands its live runs over (req-51 — workers keep running, the successor takes them back); 409 while a run is in its gate, and the service serves on |

The engine's invoke channel (`/api/invoke`, `/api/events`, `/api/health` on
`components.engine.port`) and the runner's routes (`components.runner.port`,
its own token — FLEET.md) are unchanged.

## Lifecycle

**Start.** The tickets plugin's main process (`plugins/tickets/main/service-lifecycle.ts`,
`ensureService`) reads `service.lock`. A live service of the same or a newer
build is adopted. An **older** build is asked for the handover; if it
refuses (a run in its gate) Drey keeps using it and the next Drey start asks
again. Otherwise — or with no service — Drey starts one through the single
launch seam (`service/launch.ts`) and waits (up to 60 s) for `service.lock`
with the engine running. A boot claim (`service.starting`) keeps two Dreys
starting at once from starting two services. Drey never stops the service.

**First start after the update (migration).** A tickets engine from before
the service (`engine.lock`) is ended by pid after its own health check
answered with its own token; a fleet runner from before (`fleet/runner.json`)
is asked for the handover. Both lock files are removed. A runner that
refuses (a run in its gate) keeps its runs; the Crew runner component stays
blocked (row `failed`, the reason named) and the service asks again every
tick until the old runner has gone. Handed-over runs wake the runner at
boot so they are taken back at once. Nothing else changes shape: `config.json`,
`fleet/runs/` and `chain.json` are read where they are.

**Sleep, in two levels.**

1. *The Crew runner* sleeps on req-110's verdict (`fleet/runner-lifecycle.ts`):
   a live run or an On/Paused Autopilot keeps it; otherwise it goes when the
   Autopilot is switched Off, when Drey has gone (`/retire-if-idle`, sent once
   the last Drey's event stream has been closed for 5 s), or after 15 min
   without a write. The next write that needs it — a run start, a message to
   a run (req-154), the Autopilot switch (D-51) — wakes it in the same
   process. Nothing is spawned.
2. *The service* leaves only when nothing holds it — no Drey on the event
   stream (`DreyPresence`), the runner asleep, and **no enabled remote gateway
   with a paired device** (a phone cannot wake a service that is gone) — and
   that has lasted the idle span: `service.idleMinutes` in `config.json`,
   15 by default. Then it closes the engine, removes the lock and exits.

The boot rule of ADR-0077 stands: every runner wake starts with the
Autopilot Off, except a handover, which keeps the master as it stood.

**Start with Windows** is opt-in (`--autostart on`; the Settings switch
arrives with req-165). In Node mode the `Run` entry goes through a hidden
PowerShell that sets `ELECTRON_RUN_AS_NODE` (a console may flash for an
instant at log-in); the process mode is the owner's open question Q3 and
only `launch.ts` changes with the answer. A log-in start with no paired
device and no Drey leaves after the idle span.

## Diagnosing

- **Drey says the service did not come up** → `service-start.log` (the
  crash of the start), then `service.log`.
- **Is it running, and why not asleep?** → `--status`: the `held by` line.
- **The Autopilot will not switch on** → the runner row: `failed` names the
  cause (D-51), e.g. a file where `fleet/` should be, or an older runner
  still in its gate.
- **Two checkouts on one machine** share one service: the newer build serves
  both; an older Drey adopts it without asking it to leave.
- **A pre-service Drey still running** (an old build in another checkout)
  starts its own old engine again when it finds `engine.lock` gone — close it.

## Pointers

Code: `packages/tickets-engine/src/service/` (`service-host.ts`,
`runner-component.ts`, `sleep.ts`, `service-lock.ts`, `legacy.ts`,
`launch.ts`, `service-main.ts`); the client `plugins/tickets/main/service-lifecycle.ts`;
the Drey-gone signal `packages/tickets-engine/src/server/drey-presence.ts`.
Docs: ADR-0092, docs/05 §5.0, docs/06 "Drey Service: start, adopt, hand over",
docs/07 (the packaged layout).
