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
<fleet root>/                 (machine state; runner owned)
├── runner.json     descriptor: {port, token, pid, startedAt, version, build?}
├── runner.log      the daemon log (every dispatch decision; ring-capped ~512 KB)
├── chain.json      persisted chain state (only on daemon builds)
├── runs/<run-id>/
│   ├── run.json    the full record: {request, info}
│   └── stream.jsonl the run's output events (ndjson)
└── worktrees/      LEGACY (pre-T-0044): emptied by the boot migration
                    and the Clean up worktrees control, never written again

<tickets repo root>/_worktrees/<ticket-id>/   the agent's checkout since
                    T-0044 (ADR-0080), branch t/<ticket-id> — visible,
                    gitignored, skipped by the vault's tree/index/watcher;
                    a repo's `worktrees:` key in _meta/repos.md overrides
                    the base
```

`runner.json` missing means the runner is **down** (it exits cleanly after
~15 min idle with no live runs; Drey respawns it on demand). A present
descriptor with an unreachable port means it died hard — the stale
descriptor gets taken over by the next spawn.

### Cleanup surfaces (T-0044, ADR-0080)

All removal goes through **real git** (`git worktree remove` /
`git worktree prune`), never a bare rmdir; the **branch always stays**
(it carries the work).

- **Per ticket:** the card menu's "Remove worktree…" — refuses a dirty
  tree unless the owner confirms the armed second click; refuses a live
  run; appends the ticket's Log line (one commit).
- **Global:** "Clean up worktrees" in the panel header — removes every
  worktree whose ticket has no live run (dirty ones kept and reported),
  then prunes every mapped repo. Liveness = the ticket's `run:` stamp ∪
  non-terminal fleet records — never fleet status alone.
- **Boot sweep:** every plugin boot migrates the legacy root (clean
  leftovers removed automatically, dirty ones kept and reported; a live
  run's tree waits for its settle) and **lists** orphan folders under
  the new base as cleanable — listed, never auto-deleted.
- **Re-run healing:** a leftover *registered checkout* of `t/<id>`
  anywhere (the re-run trap) is removed by the runner before
  `worktree add` when provably clean and not live — refused
  descriptively otherwise.

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
| `GET /health` | alive check: `{ok, version, live}` — `live` = live run count; newer builds add a `build` stamp — `<builtAt>#<hash>`, a content hash of the compiled fleet code (req-51; older builds: runner.js mtime) |
| `GET /status` | all runs (newest info per run) |
| `GET /status/<runId>` | one run: `{run, streamPath}` |
| `GET /stream/<runId>` | the run's stream.jsonl tail (last ~200 KB, ndjson) |
| `GET /log?tail=N` | daemon log tail, plain text (default 300 lines, max 2000; daemon builds) |
| `GET /chain` | chain state + config (daemon builds) |
| `GET /report` | token telemetry grouped by ticket, phase and model, sorted by total desc: `{ok, groups: [{ticket, phase, model, runs, total, input, cacheRead, cacheCreation, output, beforeFirstWrite, beforeFirstWriteShare}]}` — a counter the provider never reports counts 0 into the sums; pre-T-0048 records fall back to their cumulative `tokensIn`+`tokensOut` (T-0048) |
| `POST /stop` `{runId, reason}` | stop one run |
| `POST /send` `{runId, text}` | steer a live run (rung: inject/resume/refused) |
| `POST /chain/master` `{mode: "run"\|"halted"}` | master switch (daemon builds) |
| `POST /chain/column` `{phase, mode: "playing"\|"held"}` or `{phase, stop: true}` | column control |
| `POST /chain/abort` | stop every live run |
| `POST /shutdown` | graceful retire: stops live runs (bounded), exits. With `{handover: true}` (what Drey sends for a newer build, req-51) no run ends: live runs are left to the successor (OpenCode re-attached; a worker it cannot bind to is stopped and its session resumed in place under the same run id); 409 while a run is gating/starting/stopping |
| `POST /start` | starts a run — **do not hand-craft**: the `RunRequest` (see `plugins/tickets/main/fleet/protocol.ts`) carries the composed instruction, worktree, gate commands, phase plumbing; runs are started by the board's "Run agent" or the chain dispatcher |

Writes change real state (worker processes, the board, the tickets repo).
Diagnose read-only first; only stop/steer/switch on the owner's ask.

## Checking status — the usual recipe

1. Descriptor: read `runner.json` (down if missing; note `startedAt`, `pid`,
   `build`).
2. `GET /health` — alive, how many live runs, which build.
3. `GET /status` — the runs: id, ticketId, provider, **state**, pid,
   tokensIn/Out (`tokensIn` counts cache reads; `cacheReadTokens` is
   that cached part, req-53 — and a resumed session counts only this
   run, its earlier spend is `usageBase` in `run.json`), costUsd,
   sessionRef, worktreePath, gateFailure. A run id
   can appear **twice**: at boot every provider supervisor adopts every
   stored record from `runs/`, so boot-adopted runs land in both lists —
   dedupe by id when summarizing.
4. `GET /log?tail=50` — what the daemon last decided and why
   (e.g. `dispatch skips T-0041: ... no acceptance criteria`).
5. `GET /chain` — master/columns/cooldowns/token budget (daemon builds).
6. `GET /report` — token cost per ticket/phase/model (T-0048): what the
   columns spend, sorted by total.
7. For a specific run: `GET /status/<id>` then tail `stream.jsonl` directly
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
`worktreePath` (since T-0044 — computed plugin-side, the runner never
derives paths), `branch`, `phase`/`column`, `instruction`, `acceptance`
(the gate commands), `model`, `permissionMode`; the info is the same
object `/status` reports.
Since T-0041 the request also carries `nextPhaseDir` (the resolved
numbered directory the success move targets — `50-build`, the owner's
`35-qa`, whatever exists) and `pushRemote` (pipeline.md `push:`; the
runner pushes each transition commit `git push <remote> HEAD` when it is
set — a failed push is a log line here, never a failed move). Ticket
paths may be numbered (`tickets/30-plan/…`) or unprefixed — the stripped
id is the identity everywhere. `stream.jsonl` lines are
`{ts, kind, text, ...}` with kinds `note`
(runner notices: gate lines, run bookkeeping), `text` (worker output),
`usage` (token/cost updates), `result` (the worker's final answer) and
`error`.

Since T-0048 the info also carries the run's **token telemetry** (all
optional — adopted pre-T-0048 records lack them, and every reader
treats absent as unknown):

- `usage`: `{input, cacheRead, cacheCreation, output}` summed over the
  run's model calls — a counter the provider never reports stays `null`,
  never 0 (the pinned plan provider may report no cache fields);
- `lastTurnContext`: input+cacheRead+cacheCreation of the LAST assistant
  turn — the real context size (the providers' `tokensIn` and the result
  events are cumulative aggregates, not context);
- `turns` (model calls that reported usage), `readCalls`
  (read/grep/glob tool calls), `tokensBeforeFirstWrite` (input-side
  tokens over the turns before the first write/edit — the exploration
  cost; the full input side when no write came);
- `gateResult` (`green`/`red` once the gate ran), `model`, `phase`,
  `handoverMode` (`fresh` — the field exists for T-0049's modes).

`GET /report` groups these by ticket, phase and model (see the route
table); the board's lanes show `ctx`/`turns`/`reads` chips per run.

### The instruction (T-0048: the context pack)

Every phase's instruction is composed in one stable order — repo agent
instructions (`CLAUDE.md`, fallback `AGENTS.md`, verbatim) → phase
template → the ticket's `## Plan` verbatim → the variable parts
(who/where, description, the worktree's `git diff --stat` head-capped,
and on a retry the previous run's gate failure tail-capped). The prefix
up to the plan is byte-identical across runs of the same repo and
phase, so a warm prompt cache survives. A red-gate retry is a fresh run
whose instruction carries the ticket's most recent `gateFailure`
section — the worker continues the branch instead of starting over.

The caps are the plugin config keys `fleet.cap.gateFailureLines` /
`fleet.cap.gateFailureBytes` / `fleet.cap.diffStatLines` /
`fleet.cap.diffStatBytes` (Settings → Tickets → Fleet; defaults 40/4096
tail and 50/4096 head). Each application is logged:
`instruction: <ticket> gateFailure truncated: true, originalSize 9821`.

### chain.json fields (daemon builds)

`config` (tickets vault path, git, defaultWorker, permissionMode, caps)
· `master` (`run` / `halted`) · `columns` (per-phase `playing` / `held`)
· `redStreak` · `cooldownUntil` (per column ISO instant) · `tokensDay` +
`tokensUsed` (the per-column token budget) · `ciBackoff`.

## Lifecycle gotchas

- **Which checkout runs it**: the runner was spawned by some Drey instance.
  `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"`
  shows the command line — `electron.exe <checkout>\dist-electron\plugins\tickets\main\fleet\runner.js --root <fleetRoot>`.
  A worktree checkout (e.g. `Drey-t0007` on its ticket branch) may run
  newer fleet code than `main` — feature parity questions go there first.
- **Restart**: `POST /shutdown` (graceful, stops live runs) — Drey respawns
  the runner on the next run start. Daemon builds are also retired when the
  plugin finds newer fleet code on disk (a different content hash in the
  descriptor's build stamp — a rebuild of unchanged code keeps the runner);
  that retirement is a handover, so live workers carry on under the new
  runner (`handover` in a `run.json` marks a run in transit).
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
  which the machine gate refuses to run. Since T-0050 also: the ticket
  is **blocked** — `blocked-by:` names ids that have not reached the
  last phase, and the dispatcher skips it by design; the log says
  `dispatch holds <id>: blocked by <ids> — the blockers must reach the
  terminal phase first` (an id missing from the board blocks too, and
  warns on the card). It dispatches by itself once every blocker
  reaches the last phase.
- **Run stuck** → `/status` state + stream tail; `stopping` for long means
  the worker ignores the stop — the supervisor tree-kills, give it a moment,
  then check the pid.
- **Where did the agent work?** → since T-0044:
  `<tickets repo>/_worktrees/<ticket-id>/` on branch `t/<id>` (a repo's
  `worktrees:` override moves the base); pre-T-0044 runs:
  `<fleet root>/worktrees/<repo>-<ticket>`, until the boot migration
  collects them. Inspect with `git -C <worktree> ...`. Folders listed under
  the repo's `link:` in `repos.md` (req-56) are junctions into the
  owner's checkout — the stream's `worktree links:` line says which were
  linked or left out and why. Before removing a worktree by hand, remove
  its junctions (`cmd /c rmdir <worktree>\node_modules` removes the link,
  not the target) — never a recursive delete through them. The runner's
  own recreate does that itself. The runner commits
  ticket bookkeeping ("fleet run bookkeeping") in the tickets repo itself.
- **`worktree add` says the branch is "already checked out"** (a settled
  ticket's leftover checkout somewhere — the re-run trap) → the runner
  heals this itself when the conflicting tree is clean and not live; if
  it refuses (dirty or live), clean or stop that tree, or use the board's
  card menu / "Clean up worktrees".
- **A worker's npm or Electron behaves oddly** → the runner drops the
  `npm_*`, `INIT_CWD` and `ELECTRON_RUN_AS_NODE` variables it inherits
  at boot (req-56; `runner.log` names them); a runner started before that
  build still hands them on.
- **A transition did not reach the remote** → check pipeline.md's `push:`
  key first (absent = pushing is the owner's business), then
  `GET /log?tail=50` for `push of the transition to "<remote>" failed`.
  Archived tickets (`tickets/archive/`, T-0041) never dispatch and never
  count toward the board — the owner archives and deletes them by hand.

## Pointers

- Code: `plugins/tickets/main/fleet/` (`runner.ts`, `runs.ts`, `chain.ts`,
  `orchestrator.ts`, `providers.ts`, `protocol.ts`), client side
  `plugins/tickets/main/fleet-client.ts`
- Specs: `specs/ticket-schema.md` (tickets, gates, agent lane rules),
  ADR-0075/0076 (+0077 for the chain), `specs/changelog.md` M84+,
  manual §13 "Running agents on tickets"
