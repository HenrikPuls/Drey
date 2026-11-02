# 0088 — Tickets engine: the package cut (Mission-Control migration, E0)

- Status: accepted (2026-11-01, E0 of the owner-approved migration plan; the
  later etappen E1–E6 amend this record as they land)
- Relates: [ADR-0075](0075-agent-fleet-architecture-governance-and-run-control.md)
  (the fleet runner — its code moves, its behaviour does not),
  [ADR-0076](0076-ticket-repository-format-and-coordination.md) (the format
  stays untouched), [ADR-0086](0086-tickets-remote-access.md) (the planned
  host split this cut begins), [ADR-0087](0087-work-panel-replaces-the-kanban-board.md)
  (the phone-as-chat-client stage W8 is superseded by etappe E5)

## Context

The phone-first decision (ADR-0086, req-66) and the owner-approved
architecture concept (2026-11-01) restructure the tickets system: a pure
`tickets-engine` package, a served Mission-Control web app as the primary
client, and a thin — but native — Drey plugin. The starting point is two
god files (`plugins/tickets/main/index.ts` ≈ 124 KB, `renderer/index.ts`
≈ 132 KB) with the domain logic, the fleet runner and the contracts in one
plugin folder, no npm workspaces, and a renderer/remote bundling guard
(`onlyOwnSources`) that only admits the plugin's own folder and `shared/`.

## Decision

1. **npm workspaces, first package.** The root becomes a workspace root
   (`packages/*`, `apps/*`); `packages/tickets-engine` is the first package
   (`@drey/tickets-engine`, private, no runtime deps). Hoisting risk is nil
   at E0 — the package carries no dependencies.
2. **E0 is a pure code move.** Domain (`ticket-board`, `ticket-files`,
   `phase-dirs`, `normalize`, `blocked`, `tickets-git`, `commands`,
   `default-prompts`), the whole fleet runner (`main/fleet/**`) and the
   cross-layer contracts (`tickets`, `question-shape`, `fleet-defaults`,
   `capture-tidy`) move to `packages/tickets-engine/src/{core,fleet,contracts}`;
   the shipped prompts move to `packages/tickets-engine/prompts`. No
   behaviour change: every moved module's spec moves with it and passes
   unmodified.
3. **One compile program, no build order.** The shipping compile stays the
   plugin main tsc program (`plugins/tsconfig.main.json`, `rootDir` = repo
   root) with the engine sources added to its `include` — the engine emits
   to `dist-electron/packages/tickets-engine/src/` and the plugin's emitted
   CJS reaches it by relative `require`, exactly like the old intra-plugin
   imports. No d.ts boundary, no workspace-symlink dependency at runtime,
   and electron-builder's existing `dist-electron/**` globs ship the engine
   without config changes. The package's own `tsconfig.json` typechecks it
   standalone (the boundary marker; ESLint typed rules use it).
4. **The boundary is enforced, not described.** ESLint layer rules:
   `packages/**` may import only its own folder and the repo's `shared/`
   (never `src/`, `electron/`, `plugins/`, `apps/`) — the purity the E2
   process split depends on. The `NO_RENDERER` glob (`**/src/**`) gains a
   `!**/packages/**` negation so it keeps meaning the renderer root.
5. **Plugin reaches the engine by relative import; renderer/remote keep
   their paths.** Staying plugin files import engine modules directly
   (`../../../packages/tickets-engine/src/...`); renderer and remote code
   keep importing `plugins/tickets/shared/*`, where the four moved
   contracts leave thin `export *` re-export shims (the esbuild guard
   admits `packages/tickets-engine/src/` like it admits `shared/`).
   The shims are an E0 compatibility seam — E2/E5 collapse them as the
   API/client split lands.
6. **Runtime anchors move with the engine.** The bundled runner entry is
   exported by the engine (`fleet/runner-path.ts`, `RUNNER_SCRIPT_PATH`,
   resolved next to the compiled `runner.js`); `SHIPPED_PROMPTS_DIR`
   resolves `packages/tickets-engine/prompts` in source and dist; the
   build script copies the prompts next to the compiled engine.
7. **Drey stays a native client (owner decision 2026-11-01).** The engine
   becomes its own process and serves the web app (etappe E2), but Drey
   keeps rendering the Work panel, ticket threads and the editor natively
   against the same engine API — the webview is optional, not the product.
8. **Roadmap honesty.** The migration supersedes req-75 W6–W8 (personas and
   the chat surface replace the Shape dialog and the phone-client rebuild);
   W9 (audit runs) stays. `apps/mission-control` arrives with E5, when
   there is real content — no empty skeleton in E0.

## Consequences

- `npm run test:all` keeps passing (2718 plugin/engine + 1196 renderer
  tests at E0); `pack:dir` ships the engine output unchanged.
- Import rewriting is mechanical and verifiable: stale-specifier scans plus
  the four typecheck programs cover the seam.
- The contracts shims mean the moved modules exist in one place only — the
  plugin surface is a re-export, never a copy.
- E1 has its home: `core/transition.ts` (one transition machine) and
  `store/` extract from the now-visible domain core; E2 turns
  `packages/tickets-engine` into the standalone server process.
- Licence stays GPL-3.0-only; no repo split (concept §9 trigger list).

## Later changes

- **E1 (milestone 98):** `core/transition.ts` is the one transition
  machine (read → patch → rename → write → commit → push → announce, IO
  injected via `TransitionIo`); the five historical move variants run
  through it. `core/status-log.ts` (per-ticket append-only verb log, the
  `[key=slug]` convention, the open-decisions fold) and `core/ledger.ts`
  (`_meta/ledger.jsonl` fleet events) land as pure data forms.
- **E2a (milestone 99):** the whole board service moves into the engine as
  `services/board-service.ts`, host-agnostic over `services/host.ts`
  (`EngineHost` + `FleetPort`, the owner identity injected). The plugin
  kept a thin subclass over `DreyEngineHost`/`FleetClientPort`; the
  planned four-way service split deliberately became one service class
  first — the board/run/settings cycles share one context, and forcing
  four services would have fought that graph.
- **E2b (milestone 101):** the engine becomes a process.
  `src/server/engine.ts` composes board service + fleet client + remote
  gateway over one vault (`FsEngineHost` + `FileConfigStore` in
  `~/.drey-engine`); the channel is one loopback invoke listener with an
  explicit method allowlist, a persisted bearer token and an SSE stream;
  `engine-main.js --vault <path>` is the CLI. The Drey plugin adopts or
  spawns the engine (lockfile, `ELECTRON_RUN_AS_NODE`) and proxies the
  service surface through `EngineClient` — the IPC handlers and the
  renderer are untouched; Drey config syncs into the engine config on
  activation. The engine outlives Drey; the phone uses the same engine
  through the gateway's pairing either way. Known wrinkles (owner-visible,
  accepted for E2): remote settings/devices move to the engine home
  (synced at activation), the fleet run history moves to
  `~/.drey-engine/fleet`, and unsynced per-worker handover overrides fall
  back to defaults.
- **E3 (milestone 102):** personas — a named agent (role + behaviour +
  model + memory) as one directory `tickets/_meta/personas/<id>/`
  (`persona.md` + `prompt.md` + `memory.md`, optional `avatar.png`; the
  format lives in
  [`specs/ticket-schema.md`](../../specs/ticket-schema.md)). The
  three-level ladder (ticket `persona:` pin > phase `persona:` key >
  engine default `personas.default`) resolves at dispatch ahead of the
  legacy assignment ring, which stays the fallback for persona-less
  boards; runs stamp `RunInfo.persona` and the token report groups cost
  per persona (`unassigned` bucket). Memory appends at settle (capped at
  200 lines, a write failure never fails the settle) beside the
  confirmed `personaLearn` service entry, the run brief carries the
  persona's memory slice, and the board service migrates the legacy
  column `worker:`/`model:`/`prompt:` keys onto personas in one
  idempotent commit (`tickets: personas migrated`).
- **E4 (milestone 103):** verify/proof — a ticket's proof is the app
  run, not an agent's say-so: the verify step is a machine step (a
  harness run → screenshots + the ticket's `## Verification` section →
  one commit → the owner's checkpoint), never a fleet run. The contract
  (`src/contracts/verify.ts`) carries the report, the harness seam and
  the proof card's status, with `MAX_VERIFY_SHOTS` = 6; the section
  itself (`core/verification.ts`, the canonical shape in
  `specs/ticket-schema.md`) is written strictly and read tolerantly —
  an absent or half-readable section means "not verified yet", never a
  guess. Screenshot discipline: at most six per run, `verify-…` names
  in `tickets/attachments/`, the phone's `img-…` untouched. The judge
  seam (`VerifyJudge`) ships stubbed — without a judge a captured
  screenshot counts as its criterion's pass; the vision pass that fills
  the seam is its own milestone, its worker's prompt already shipped as
  `prompts/qa-default.md`.
- **E5a (milestone 104):** the Mission Control chat engine — the chat
  is a **client of the board**, never a second writer. A mission turn
  proposes typed mutations (`createTicket` / `transition` /
  `setPriority` — the union in `src/contracts/chat.ts` is the entire
  write surface, growing only with the intents) as proposal cards in a
  session file under `tickets/_meta/chat/` (one session = one
  strict-written, tolerant-read vault file, openable in Drey's editor;
  the grammar lives in
  [`specs/ticket-schema.md`](../../specs/ticket-schema.md)); only the
  owner's explicit confirm executes a command — through the same board
  methods the invoke channel exposes — and the decision records its
  outcome on the file's decision line, one git commit per turn
  (`tickets: chat <file>`). **The LLM seam is a direct call** behind
  `ChatBridge` — an OpenAI-compatible chat-completions stream, no
  harness and no fleet slot; the bridge reads the engine config keys
  `chat.baseUrl` / `chat.apiKey` / `chat.model`, synced from Drey's
  assistant settings on activation like the other engine keys, and an
  unconfigured chat answers honestly that no model is set, never a
  silent fallback. **The engine invoke allowlist gains**
  `chatSessions` / `chatOpen` / `chatSend` / `chatStart` /
  `chatConfirm` / `chatDismiss`, **the SSE change kinds stay
  additive** (`'chat'` beside board/fleet/remote — a client that does
  not know it ignores it), and the paired-device gateway routes the
  same `ChatServicePort`, so the phone chats under the board's writer
  rules. E5b (`apps/mission-control`, the Angular mission-control app —
  the owner decisions of 2026-11-02: the web UI stack is Angular, the
  UI language is English) renders this surface; the wider intents
  (configure, dispatch) wait for E5c/E6.
- **E5b (milestone 105):** the Mission Control app — `apps/mission-control`,
  an Angular project owned by the repo workspace but **built standalone**:
  its own `ng build mission-control --configuration production` into
  `dist/mission-control/browser`, while the repo's chains learn it —
  `npm run build` gains `build:mission-control`, `test:app` runs drey's
  renderer suite then mission-control's, lint and the typecheck cover the
  app's sources, `apps/` joins the cycles scan roots. **The engine serves
  the build output** (engine-main) — the strangler tightens one more loop,
  and the legacy remote stays the fallback until the owner verifies; no
  cutover. **`PersonaView` is the wire DTO** the new device route
  `GET /api/personas` returns, and the Team tab renders it personas-only
  (concept §4.3 — one card per persona: avatar on the persona colour,
  role, worker/model, the state-coloured live-run chip; cards read-only).
  **The shell is phone-first** per concept §7 and the owner's 2026-11-02
  decisions: one column, English UI, the chat tab raised in the bottom
  tab bar (the regular intervention), cards not columns on the Work tab;
  tablet/desktop widen the same views instead of replacing them.


