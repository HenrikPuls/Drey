# The fleet runner — operations guide

The tool-neutral guide to operating and diagnosing Drey's fleet runner —
the standalone agent-runner process behind the tickets board (ADR-0075).
It is aimed at any coding agent (referenced from `AGENTS.md`) and at the
owner working from a terminal. Skill-capable harnesses may carry a thin
shim pointing here; this file is the single source of truth.

The fleet runner is Drey's standalone agent-runner process (ADR-0075,
M84): a plain Node process spawned detached by the tickets plugin, so it
outlives the app. It owns the worker process table (OpenCode / Claude
Code CLIs), the per-run stream files, the ticket worktrees and the
machine gate. Drey talks to it over a loopback HTTP endpoint with a
bearer token — and so can a terminal, which the owner explicitly wanted.

Newer checkouts (the chain work, M85 / ADR-0077) run a **daemon** on top:
auto-dispatch across board columns, a master switch (run/halted),
per-column play/hold, red-streak cooldowns and a token budget. Which
flavour is alive cannot be read off `/health` alone (older daemon builds
predate the `build` stamp) — probe `GET /chain` or `GET /log`: a 404
means a pre-chain M84 runner, a hit means the daemon. The running build
may be newer than the checkout you are standing in — worktrees carry work
in progress, and a spawned daemon can even lag its own source until
rebuilt.

## Where everything lives

The fleet root is `<userRoot>/fleet`, where `userRoot` =
`<userData>/plugins` (on Windows: `%APPDATA%\drey\plugins\fleet`; the app
id is `drey`).

```
<fleet root>/
├── runner.json     descriptor: {port, token, pid, startedAt, version, build?}
├── runner.log      the daemon log (every dispatch decision; ring-capped ~512 KB)
├── chain.json      persisted chain state (only on daemon builds)
├── runs/<run-id>/
│   ├── run.json    the full record: {request, info}
│   └── stream.jsonl the run's output events (ndjson)
└── worktrees/<repo>-<ticket>/   the agent's checkout, branch t/<ticket-id>
```

`runner.json` missing means the runner is **down** (it exits cleanly after
~15 min idle with no live runs; Drey respawns it on demand). A present
descriptor with an unreachable port means it died hard — the stale
descriptor gets taken over by the next spawn.

## Talking to the runner

Every route needs `Authorization: Bearer <token>` from `runner.json`.
PowerShell:

```powershell
$root = "$env:APPDATA\drey\plugins\fleet"
$d = Get-Content "$root\runner.json" -Raw | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($d.token)" }
Invoke-RestMethod "http://127.0.0.1:$($d.port)/health" -Headers $h
```

(or `curl.exe -s -H "Authorization: Bearer $($d.token)" http://127.0.0.1:$($d.port)/status`)

| Route | What it gives |
|---|---|
| `GET /health` | alive check: `{ok, version, live}` — `live` = live run count; newer builds add a `build` stamp (runner.js mtime) |
| `GET /status` | all runs (newest info per run) |
| `GET /status/<runId>` | one run: `{run, streamPath}` |
| `GET /stream/<runId>` | the run's stream.jsonl tail (last ~200 KB, ndjson) |
| `GET /log?tail=N` | daemon log tail, plain text (default 300 lines, max 2000; daemon builds) |
| `GET /chain` | chain state + config (daemon builds) |
| `POST /stop` `{runId, reason}` | stop one run |
| `POST /send` `{runId, text}` | steer a live run (rung: inject/resume/refused) |
| `POST /chain/master` `{mode: "run"\|"halted"}` | master switch (daemon builds) |
| `POST /chain/column` `{phase, mode: "playing"\|"held"}` or `{phase, stop: true}` | column control |
| `POST /chain/abort` | stop every live run |
| `POST /shutdown` | graceful retire: stops live runs (bounded), exits |
| `POST /start` | starts a run — **do not hand-craft**: the `RunRequest` (see `plugins/tickets/main/fleet/protocol.ts`) carries the composed instruction, worktree, gate commands, phase plumbing; runs are started by the board's "Run agent" or the chain dispatcher |

Writes change real state (worker processes, the board, the tickets repo).
Diagnose read-only first; only stop/steer/switch on the owner's ask.

## Checking status — the usual recipe

1. Descriptor: read `runner.json` (down if missing; note `startedAt`, `pid`,
   `build`).
2. `GET /health` — alive, how many live runs, which build.
3. `GET /status` — the runs: id, ticketId, provider, **state**, pid,
   tokensIn/Out, costUsd, sessionRef, worktreePath, gateFailure. A run id
   can appear **twice**: at boot every provider supervisor adopts every
   stored record from `runs/`, so boot-adopted runs land in both lists —
   dedupe by id when summarizing.
4. `GET /log?tail=50` — what the daemon last decided and why
   (e.g. `dispatch skips T-0041: ... no acceptance criteria`).
5. `GET /chain` — master/columns/cooldowns/token budget (daemon builds).
6. For a specific run: `GET /status/<id>` then tail `stream.jsonl` directly
   from disk (`Get-Content "$root\runs\<id>\stream.jsonl" -Tail 20`) — that
   works even after the run ended.

### Run states

| state | meaning |
|---|---|
| `starting` / `running` | live worker |
| `stopping` | stop requested, worker ending |
| `done` | worker finished its turn (gate ran after; check `gateFailure`) |
| `stopped` | stopped by request |
| `failed` | worker died or errored (see stream `error` events) |
| `detached` | the runner restarted while the worker lived on — unwatchable, treat as busy |

A "red gate" shows as `gateFailure` on the run plus `note` events in the
stream; on daemon builds it also feeds `redStreak` and `cooldownUntil` in
`chain.json` for the working column.

### run.json and stream events

`run.json` = `{request, info}`: the request carries `ticketId`, `repoPath`,
`branch`, `phase`/`column`, `instruction`, `acceptance` (the gate commands),
`model`, `permissionMode`; the info is the same object `/status` reports.
`stream.jsonl` lines are `{ts, kind, text, ...}` with kinds `note`
(runner notices: gate lines, run bookkeeping), `text` (worker output),
`usage` (token/cost updates), `result` (the worker's final answer) and
`error`.

### chain.json fields (daemon builds)

`config` (tickets vault path, git, defaultWorker, permissionMode) · `master`
(`run` / `halted`) · `columns` (per-phase `playing` / `held`) · `redStreak` ·
`cooldownUntil` (per column ISO instant) · `tokensDay` + `tokensUsed` (the
per-column token budget) · `ciBackoff`.

## Lifecycle gotchas

- **Which checkout runs it**: the runner was spawned by some Drey instance.
  `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"`
  shows the command line — `electron.exe <checkout>\dist-electron\plugins\tickets\main\fleet\runner.js --root <fleetRoot>`.
  A worktree checkout (e.g. `Drey-t0007` on its ticket branch) may run
  newer fleet code than `main` — feature parity questions go there first.
- **Restart**: `POST /shutdown` (graceful, stops live runs) — Drey respawns
  the runner on the next run start. Daemon builds also self-retire when the
  plugin notices a newer `runner.js` on disk (build stamp in the descriptor).
- **Single instance**: a second runner finding a healthy peer exits quietly;
  a stale descriptor (dead peer) is taken over.
- **Idle shutdown**: no live runs and ~15 min without requests → the runner
  exits itself. Not a malfunction.
- **No global Node**: the runner is Electron-as-Node. To start one by hand
  (rarely needed), use the spawning checkout's electron binary with
  `ELECTRON_RUN_AS_NODE=1`, or the repo's vendored Node (`. .\env.ps1`, then
  `.tools\node\node.exe runner.js --root <fleetRoot>`).

## Diagnosing common symptoms

- **Runner unreachable** → `runner.json` there? pid alive? If the pid is
  dead but the file is there, it died hard: check the tail of `runner.log`,
  then just let Drey respawn it (or POST `/shutdown` to clear the descriptor).
- **Ticket not being dispatched** (daemon) → `GET /chain` + `/log`:
  master `halted`? column `held`? cooldown active? token budget exhausted
  (`tokensUsed` vs day)? ticket claimed, carries a `run` stamp, has
  validation errors, or — most common — **no backticked acceptance criteria**,
  which the machine gate refuses to run.
- **Run stuck** → `/status` state + stream tail; `stopping` for long means
  the worker ignores the stop — the supervisor tree-kills, give it a moment,
  then check the pid.
- **Where did the agent work?** → `worktrees/<repo>-<ticket>` on branch
  `t/<id>`; inspect with `git -C <worktree> ...`. The runner commits ticket
  bookkeeping ("fleet run bookkeeping") in the tickets repo itself.

## Pointers

- Code: `plugins/tickets/main/fleet/` (`runner.ts`, `runs.ts`, `chain.ts`,
  `orchestrator.ts`, `providers.ts`, `protocol.ts`), client side
  `plugins/tickets/main/fleet-client.ts`
- Specs: `specs/ticket-schema.md` (tickets, gates, agent lane rules),
  ADR-0075/0076 (+0077 for the chain), `specs/changelog.md` M84+,
  manual §13 "Running agents on tickets"
