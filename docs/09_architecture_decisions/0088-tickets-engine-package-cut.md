# 0088 — Tickets engine: the package cut (Mission-Control migration, E0)

- Status: accepted (2026-11-01, E0 of the owner-approved migration plan; the
  later etappen amend this record as they land — E1–E9 and the redesign
  E10–E12 are recorded under "Later changes", up to milestone 132 (E10-6) and
  the chat-model fix D-1 (milestone 131); the desktop integration E13 is
  [ADR-0089](0089-views-saved-layouts-with-their-own-tabs.md))
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
   keep importing `plugins/tickets/shared/*`, where the moved
   contracts (four at E0; by E13 six: `capture-tidy`, `changes`,
   `fleet-defaults`, `question-shape`, `remote-protocol`, `tickets`) leave thin `export *` re-export shims (the esbuild guard
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
8. **Roadmap honesty** (replaced 2026-11-03, concept v2). Req-75 W6 (the
   Shape track) is recut as E10-2 – E10-4; W7 (orchestrator, overlap
   guard, routing) and W8 (phone as chat client) are dropped; W9 (audit
   runs) stays. `apps/mission-control` arrived with E5 — see "Later
   changes" below, E10 – E12.

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
- **E5c (milestone 106):** the ticket screen, the raw-edit exception
  path and Drey hosting. **The ticket screen** (concept §5.5) is
  read-only first: the gate bar over the safe-markdown render, the proof
  card (concept §5.3) with its swipable screenshot gallery, the
  fullscreen shot viewer, and the capped unified diff — per file
  collapsible, the +/- balance, horizontally scrollable lines, the
  per-file fullscreen zoom with stepped font size — rendered from
  `GET /api/tickets/<id>/diff` (`{files: [{status, path, patch}],
  truncated}`) through the `diffOfOutput` parser; the raw edit mode is
  the exception path behind a warning and saves through
  `POST /api/tickets/<id>/save` (`{text, baseRevision?}`) — a stale
  revision is refused in-band (`{ok: false, conflict: true}`, the
  refine wording, never a 409), a save that stops parsing as a ticket
  is refused, every accepted save is one commit; `POST
  /api/tickets/<id>/accept` and `POST /api/tickets/<id>/send-back`
  close the owner checkpoint, the send-back note mandatory (an empty
  note is a 200 refusal). `GET /api/attachments/<name>` serves the
  proof shots' bytes bearer-authenticated, the name pinned to
  `[A-Za-z0-9._-]+.(png|jpg|jpeg|webp|mp4|webm)` with no slashes, the
  gateway CSP widening only to `img-src 'self' data: blob:`.
  **Drey hosting (concept §3.5.4 — the same app in a Drey window):**
  `RemoteService.localClient` registers Drey itself as a device (no
  pairing dance) and returns the bearer token plus the gateway URL —
  null while the remote is off. The tickets plugin's main opens one
  sandboxed window (`plugins/tickets/main/mission-control.ts`, the
  browser plugin's view discipline minimised: own persisted partition,
  no preload, sandbox + context isolation, http(s)-only top-level
  navigation, off-window links to the OS browser) and loads
  `${url}#token=${token}`; the Work panel's ⋯ menu gains the
  'Mission Control' row, and a remote that is off answers honestly
  ('Enable remote access in Settings → Tickets → Remote'). Not yet
  manually verified by the owner.
- **E6 (milestone 107):** the self-improvement loop (concept §4.8) —
  personas that improve from their own friction. The worker's write
  path is one line per finding in the persona's `friction.md` (the
  build / review / qa prompts carry the 'Friction is a gift'
  paragraph); the `ImprovementsService`
  (`services/improvements-service.ts`, composed over the
  `PersonaImprovementsPort` the board service implements on its
  single-writer queue) turns a persona's findings into at most three
  evidence-backed drafts once the threshold is met — the first
  aggregation at `IMPROVEMENTS_THRESHOLD` = 3 waiting findings, a
  repeat after 5 settled runs since the file's last `- aggregate:`
  stamp — through the E5a chat bridge behind its own
  `AGGREGATOR_SYSTEM_PROMPT`: the same OpenAI-compatible stream, the
  same honesty when no model is set; the survivors land through the
  port's `applyAggregation`, one commit per aggregation.
  `core/improvements.ts` owns the machine format (`improvements.md`:
  strict writer, tolerant reader, `imp-<n>` ids never reused, 10
  evidence items / 8 KiB content per proposal — phone-reviewable by
  design). The owner's unit of work is the persona detail's 1:1: the
  open proposals as cards, an armed two-step Apply / Dismiss deciding
  each — the board service applies through its service entries
  (`prompt.md` rewritten, `models.default` patched via
  `patchHeaderFields`, the lesson appended to `memory.md`), exactly one
  commit per decision, never rewriting a line already written. The
  Needs-you group gains the `'improvements'` kind, raised when a
  persona's open proposals reach the threshold. Not yet manually
  verified by the owner.
- **E7 (milestone 108):** the status log + fleet ledger (concept §3.3) —
  the machine keeps a ticket's status and the fleet's events in
  machine-shaped files the UI reads as projections. The per-ticket
  `tickets/<phase>/<id>.status.log` (the contract in
  `core/status-log.ts`, a data form since E1) is append-only beside
  the ticket: one line per event, `- '<ISO stamp>' <verb>: <payload>`,
  the verbs `working` / `needs-decision` / `blocked` / `paused` /
  `done` / `failed` / `resolved`, every `needs-decision` and `blocked`
  keyed (`[short-key]`) so the owner can resolve it — an open key
  stays on the owner's desk until a `resolved:` line closes it (the
  open-decisions fold; strict writer, tolerant reader). The fleet
  ledger (`core/ledger.ts`) writes `tickets/_meta/ledger.jsonl` — one
  strict JSON line per `dispatched` / `phase` / `proof_ready` /
  `merged` / `archived` / `run_settled` event (the format is in
  `specs/ticket-schema.md`, "The fleet ledger"), swept into git by the next regular
  commit, never committed per line. The writers are optional seams:
  the orchestrator's deps carry a runner-side event-writer
  (dispatched / working / done / blocked / failed), the board service
  appends phase / merged / archived on its transitions, the verify
  service appends proof_ready with the settled cost. The Needs-you
  composition (`drey-port.ts`'s `needs()`) lifts every open key into
  one card of the two new kinds `'needs-decision'` / `'blocked'`
  (`NeedKind` in `contracts/remote-protocol.ts`), and the build /
  review / qa prompts carry the status-log paragraph asking the worker
  to keep the log current before the run ends. Not yet manually
  verified by the owner.
- **E8 (milestone 109):** the Scout track (concept §5.6) — `form: scout`
  for exploration-only tickets: a scout run writes the ticket's
  `## Report` chapter and decision list into its own file, with no
  worktree, no gate and no move; the report surfaces as a card in
  Needs you and the chat's `promote` command (with confirmation) flips
  the ticket to ship. Not yet manually verified by the owner.
- **E9 (milestone 110):** the chain delta (concept §5.7) — a ticket's
  `chain:` stores only its deviations from the pipeline's standard flow
  (`insert` / `skip` / `notify`), the engine merges both, a semantic
  write guard (`validateChain`) refuses unreachable edits, and the
  chat's `setChain` command executes only on confirmation. Milestone 111
  adds the configurable priority vocabulary and the chat's
  `setBlockedBy`. Not yet manually verified by the owner.
- **E10 – E12 (concept v2, 2026-11-03):** the owner redesigned the UI in
  the design canvas and updated the concept; owner decisions D5–D12 are
  closed. What this changes in the record above:
  - **Decision 8 is replaced.** Req-75 W6 (the Shape track) is *recut*
    — E10-2 – E10-4 carry it as Shape mode with Paul, Plan to approve
    and the plan delta; W7 (orchestrator: overlap guard, `touches:`,
    rules-file routing) and W8 (the phone as a chat client) are
    *dropped* (D5), the chain delta and Mission Control being what they
    were for; W9 (audit runs) stays.
  - **Names (D7).** *Pia* is the name of Mission Control, the one
    central contact; the planner persona formerly called Pia is **Paul**,
    the design persona is dropped. The default team is Paul, Ben, Ralf,
    Tessa.
  - **Team states (E12-4, milestone 115).** `POST /api/runs/<id>/handoff`
    (stop, wait, restart on Claude Code, fresh) and `ChainStatus.poolSize`
    join the engine surface; the persona detail's Chat and 1:1 are one tab.
  - **Navigation supersedes E5b's bottom tab bar.** On a phone a menu
    replaces it (chat with its history is home; Work, Team, Settings
    behind the menu); from 768 px a top tab bar (Work with a needs-you
    counter, Chat, Team, Settings) and a right dock (Chat | Capacity |
    history list). Chat history is a screen over the `_meta/chat/` files
    (old sessions read-only). Persona detail Chat and 1:1 merge into one
    conversation (D8).
  - **Settings screen (D10; shipped as E12-3, milestone 114).** The engine
    half is `GET /api/settings`, `POST /api/settings/engine` and
    `POST /api/settings/devices/revoke` (engine `src/server/settings.ts`). Appearance (themes, highlight colour,
    text size S–XXL, Compact lists, Reduce motion) is per *device*;
    everything else — Chat, Away and alerts, Devices, Repositories,
    Engine — is per *vault*.
  - **Proof rule (D12) supersedes E4's failure-only video.** A ticket's
    proof is a UI walkthrough video (≤ 60 s, chaptered) plus ≤ 6
    captioned screenshots when it changes the UI, and only test results
    in `## Verification` otherwise. The builder declares
    `proof: ui|tests` in the Handover, the review prompt confirms or
    corrects it, the ticket frontmatter `proof:` pins it, missing means
    `ui`; the verify harness starts the app only for `ui`.
  - **Videos.** Reserved folder `tickets/videos/`, not in git by default
    (the engine maintains the `.gitignore`); engine keys `videos.inGit`
    (default false, turning it on is a warned and confirmed act) and
    `videos.maxMb` (default 25 per video; owner decision 2026-11-04: no
    retention limit by age or total size, nothing is deleted
    automatically, the disk is the only bound; this replaces the first
    cut `videos.limitMb` 2000 with oldest-first deletion, which E11-1
    still implements until E11-1c); served by a
    bearer-authenticated, Range-capable `GET /api/videos/<name>`.
  - **Schema deltas** (`specs/ticket-schema.md`): `### Parts`,
    `parent:`, `proof:`, `videos/`, a per-part `chain:` scope.
  - **Language.** Every UI string in `libs/mission-ui` is English
    (E12-1, guarded by a spec that greps for `[äöüß]`); the `## Verlauf`
    keys `dauer` / `ausgang` are file format and stay.
  - **Review.** Line and range comments on the diff travel as
    structured feedback (file, line, text) into the Handover to the
    responsible persona (D6); the cost estimate is shown only with ≥ 3
    similar runs of the owner's own history (D9). The product name
    "Drey Crew" needs a name check before rollout, with "Kobel" as the
    fallback name; code is not renamed (D11).
  - **Shape mode (E10-3, milestone 122) — the one write the chat makes
    on its own.** A chat session may name a ticket (`ticket:` in its
    frontmatter, E10-2); its turns then run on Paul's prompt instead of
    the mission prompt (`SHAPE_SYSTEM_PROMPT`), Mission Control relaying
    him. Paul may read the ticket's repository — `readRepoFile` on the
    board, the ticket's own `repo`, inside it, no `.git`, dependency
    folders, secrets or binaries, a bounded few request rounds per turn —
    and writes **only the ticket's `## Plan` chapter** (`setPlan`, one
    commit `tickets: <id> plan`, refused while a run is live). That is
    a deliberate, narrow exception to the iron rule "the chat never
    writes on its own": the plan is the shared document the owner reads
    and edits beside the dialog, every write is a commit, and nothing
    else of the ticket changes. Everything that moves a ticket stays a
    tap — Paul's split proposal is a card in the session
    (`POST …/split/keep|split`): "Keep as one ticket" moves the ticket
    into the build queue through the board's own transition, "Split into
    N tickets" records the choice for the plan to approve (E10-4); N is
    counted from the plan's `### Parts`, never fixed. Questions are
    answer cards above the composer (pick, then send; the pick is never
    the action).
  - **Plan to approve (E10-4, milestone 126) — the owner's tap releases,
    the chat proposes nothing.** The approval is a tap on the plan card
    itself (`POST /api/tickets/<id>/release`), not a chat proposal card:
    the plan is the shared document the owner just read, the screen
    states what the tap will do (Mission Control's proposal text:
    approve all N parts, or only the first) and nothing is written before
    it, so the iron rule holds without a second confirmation in the
    thread. The desk owns the edits (`GET/POST /api/tickets/<id>/parts`
    — persona pick, move, delete over `### Parts`) and the release
    (`BoardService.releasePlan`): one ticket per new part in the build
    queue with `parent:`, `persona:`, its own `chain:` and `blocked-by:`
    the part before it; a part that is a ticket is locked. Locked is
    wider than "running" on purpose — a released part is a ticket and its
    order, owner and removal live there. No overlap guard, touches or
    routing (D5).
  - **Flow editor (E10-5, milestone 128) — edit the arrangement, not the
    strings.** The chain delta stays the one source of truth in the file;
    the editor never edits entry text. It edits the merged steps and the
    desk regenerates the smallest canonical delta that merges back to the
    same arrangement (a verified round trip, refused when the grammar
    cannot write it). Two entries were added to the grammar for it: `move`
    (a standard gate runs elsewhere) and `assign` (a standard gate's
    persona); `before`/`after` and the per-part scope were already there.
    The draft lives in the app and each tap is a stateless round trip
    (`POST …/flow-edit`), so nothing is written before "Save flow"
    (`POST …/flow-save`, ticket header or the part's line in the parent's
    plan) and no draft state exists on the desk. Paul's draft
    (`POST …/flow-draft`) is one bridge turn under its own prompt that
    answers a `setChain` command; the desk reads it back through the same
    guard as a hand edit, and it is never written by the draft.
- **E10-6 (milestone 132):** the owner is a team member. A persona file may
  say `kind: human` (`personas/you`, created on first sight with the title
  from config `personas.humanName`, default "You"); a human persona is never
  dispatched, counted toward capacity or budgeted. A manual gate is either an
  inserted chain phase `manual` / `manual-<word>` (the one phase id that is
  not a pipeline directory — valid only as an `insert`) or any gate whose
  resolved persona is human. Both **park** the ticket with a new frontmatter
  field `awaiting: <persona>` instead of running an agent: the run request
  carries `parkFor` (the runner stamps the field where the ticket sits
  instead of moving it on), or the dispatch pass stamps it before it composes
  a run (so no worktree is ever prepared). Accept and Send back are the
  existing board moves — any transition clears the field — so the phone, the
  Drey desk and the ledger needed no new verb; Needs you gets one new item
  kind, `manual`. Considered and not done: a pipeline column per manual step
  (it would add a column to every board), and a separate "manual-done"
  endpoint (Accept already is that). The dispatcher still reads the rest of
  the delta (`move`, `skip`, `assign` of agents) nowhere — that stays
  roadmap E10-5b.
  Not yet manually verified by the owner; the etappen land one
  milestone at a time (roadmap, "Mission Control redesign").
- **The chat model reaches the engine on every change and speaks two
  dialects (D-1, milestone 131).** The first E5a cut synced the assistant
  settings once and spoke only the OpenAI-compatible wire, so a provider
  switch in Drey (or a Z.ai / Anthropic preset) left the chat on a stale or
  wrong endpoint, and a failed turn was written into the session as the
  mission's words. Now `chat.provider` / `chat.enabled` travel with the
  URL, key and model, pushed at activation and on every app-config change
  (SDK 1.40 `appConfig.onChange`); the bridge speaks OpenAI-compatible and
  Anthropic Messages (the engine package reuses Drey's pure `shared/llm`
  adapter, never `electron/`) and refuses the CLI providers by name; a turn
  without a model is a typed failure (error card, `{ok: false, failure}`),
  never a reply. The engine config keys stay Drey's mirror, not a second
  source of truth. Rejected for now: an engine-side CLI bridge (roadmap
  follow-up); the Chat page shows only whether a key is set, never the key.

- **The Markdown surface lib (E12-6, milestone 133).** Mission Control's
  hand-written Markdown reader (headings, paragraphs, bullets, code only)
  showed tickets wrongly. The renderer is not rewritten for the phone: the
  Angular-free half of the desktop editor — CodeMirror theme, the extended
  dialect, Live Preview, link and wikilink handling, the formatting
  actions — moved from `src/app/editor/` to **`libs/markdown-surface/`**
  (alias `@markdown-surface/*`, its own `ng test markdown-surface`
  project and lint rule: own folder + `shared/`, no Angular). Both clients
  build their state from `engine.ts`; nothing is copied. Mission Control
  mounts it through `mc-markdown` in `libs/mission-ui`, behind a dynamic
  `import()` so the CodeMirror (and KaTeX, mermaid) chunks load on first
  use only. The rest of the editor (tag pills, spellcheck, slash menu,
  frontmatter fold, plugin extensions) stays desktop-only in
  `src/app/editor/`.
- **Shared UI lib and the desktop surfaces (E12 – E13, milestones 112 – 130).**
  The Mission Control screens (Work, Chat, Ticket, Plan, Flow, Team, Capacity,
  Settings, Pairing) live in `libs/mission-ui` (`@mission-ui/*`), which
  `apps/mission-control` composes; the lib has its own spec project, so the
  `test:app` chain runs three Angular suites (drey, mission-control,
  mission-ui). Drey does not import the lib (it is Angular; the plugin
  renderers are plain DOM): the desktop surfaces of E13 (ticket document,
  Board, Team, Capacity band) read the same engine surface and re-implement the
  few word helpers. The engine's invoke allowlist gained `estimateOf`
  (E13-6) and `TEAM_METHODS` (E13-8: the remote port's `personas`,
  `handoffRun`, `chainPersonaPause`, persona thread and memory reads,
  `planParts`) so the desk shows what the phone shows. Because the engine
  hosts the vault as `standalone`, its vault id never equals Drey's;
  `plugins/tickets/main/host-vault-id.ts` maps it in the `board` answer.
  The engine's `announceChanges` only emits the `board` event, so Drey's own
  vault layer learns of an engine write through its vault round or the
  opt-in watcher.

- **Zod dropped (owner, 2026-11-04, convergence audit).** Concept v2 §3.3 wanted Zod schemas as one contract source. Not adopted: the hand-written `parseXxx` validators cover the contracts, no new dependency; reversible later if wanted.
