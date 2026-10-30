# Drey — Changelog

The record of everything **implemented**, newest first. Open work lives in
[`roadmap.md`](roadmap.md), decided-against ideas in
[`decisions.md`](decisions.md); when an item ships it moves here. The finer-grained history is not duplicated: the
milestone-by-milestone build log is archived in
[`docs/milestones-done.md`](../docs/milestones-done.md), lasting decisions
live in the ADRs
([`docs/09_architecture_decisions/`](../docs/09_architecture_decisions/)),
and the current architecture in
[`docs/05_building_block_view.md`](../docs/05_building_block_view.md).

**Standing rule (since milestone 32):** the PDF export is a second
renderer of the note. When the editor gains a new rendered element, it
must carry into the export in the same change — or its absence there is
recorded as an explicit decision. The parity checklist lives in
[`docs/06_runtime_view.md`](../docs/06_runtime_view.md) §6.39.

---

## Recent milestones

### req-66 R5 — Tickets remote: refine from the phone

**Not yet manually verified by the owner** (above all the on-screen
keyboard over the editor in real Safari). Owner request, outside the
list (ADR-0084, later change). Description, Plan, Acceptance criteria
and the header (title, priority, repository) are editable on the phone:

- **Ticket view**: an **Edit** link beside each of the three sections,
  **+ Description / Plan / Acceptance criteria** for a missing one, and
  "Refine title, priority, repository" in the ⋯ sheet. Hidden on a
  read-only device and while a run lives.
- **Refine view** (`#refine/<id>/<part>`): one part at a time behind
  chips; the typed text is kept as an on-device draft until it is saved
  (restored on return, flagged when it started from an older version).
  A form is never redrawn under the typing hand.
- **Desk side**: `POST /api/tickets/:id/refine` → `parseRefine`
  (sections up to 20 000 characters, title 1–200, known priority, at
  least one change) → `BoardService.refineTicket` inside the board
  queue: refused when the file's revision (16-hex SHA-256, now also in
  `GET /api/tickets/:id`) differs from the one the device read, refused
  while a run owns the ticket; else the pure `refineTicket`
  (`main/ticket-refine.ts`) — header keys through `patchHeaderFields`
  (comments and other keys survive), sections replaced up to the next
  heading of any level, a missing one added before the Log — one Log
  line `refined (<what>)` with the device actor, one commit
  `tickets: <id> refined`, announced.
- **Deviation from ADR-0084 as first written**: the remote was to refuse
  a refine while the ticket is dirty in a Drey tab, but no plugin seam
  reaches open tabs. It relies on ADR-0060 like every board write; the
  SDK seam is a roadmap follow-up. `specs/ticket-schema.md` records the
  refine commit and Log line.

Specs: `main/ticket-refine.spec.ts`, `parseRefine` in
`commands.spec.ts`, the refine route in `router.spec.ts`, the port in
`drey-port.spec.ts`, `remote/model.spec.ts` (section text);
`e2e/tickets-remote.spec.ts` R5 case (save, a desk-side change refused
with the draft kept through Reload, the header priority). Docs: ADR-0084
later change, docs/05 §5.41, docs/06 §6.70, manual.

### req-66 R4 — Tickets remote: runs on the phone

**Not yet manually verified by the owner** (real Safari on iPhone/iPad
above all). Owner request, outside the list (ADR-0084). The phone
client now drives the fleet:

- **Answer a waiting worker** in Needs you and in the run view:
  OpenCode's question form as choice buttons (a one-question,
  one-choice form answers with one tap; several fields or multiple
  choice collect, then send), own words instead of a choice, a
  `QUESTION:` turn answered as a message, and permission requests
  with Once / Always / Reject. Read-only devices see the question only.
- **Runs** tab (fourth tab): live runs newest first with their current
  activity line, then the ten most recent settled ones.
- **Run view** (`#run/<id>`, also the ticket's third tab): state, model,
  context and token figures, the gate failure, the transcript — the
  desk's own `watch-format.ts` view model drawn as text (tool steps one
  line each, replies, the owner's prompts, results, errors; thinking
  as one muted line; the last 80 blocks), following the end while you
  are at the bottom and pulled every 3 s while the run lives; a
  composer to steer (`/send`) and Stop with the armed second tap.
- **Fleet switches**: the header chip opens Run / Halt and "Stop every
  live run" (armed); an agent column's Playing / Held chip opens Play /
  Hold and "Stop <column>" (armed).
- Redraws: skipped when a refresh brought identical data (no flicker,
  no lost touch target — found by the e2e round), and deferred while a
  text field has focus, so an update never wipes what is being typed.

Specs: `remote/model.spec.ts` (run lists, state labels, `answersOf`);
`e2e/tickets-remote.spec.ts` R4 case (answer from Needs you, the Runs
list, the transcript, steer, the master and column switches, the armed
stop). Docs: docs/05 §5.41, manual.

### req-66 R3 — Tickets remote: the phone client

**Not yet manually verified by the owner** — above all on a real
iPhone/iPad in Safari (the automated round runs Chromium at iPhone
size; WebKit is not part of the toolchain). Owner request, outside the
list (ADR-0084). The gateway now serves a real client instead of the
pairing page:

- **Needs you** (start screen): waiting questions and permission
  requests, red gates and failed runs, then the checkpoint tickets;
  the tab badge counts the first group.
- **Board**: one column at a time behind scrollable phase chips with
  counts, WIP and the column's play/hold state; cards with priority
  edge, run / blocked / claim / issue chips. **Swipe left** moves a
  card to the next column (not while a run lives); a tap opens it.
- **Ticket**: title, chips, description / plan / acceptance criteria
  (checkboxes) and the Log tab, rendered as text only. One primary
  action — *Approve → next* in a checkpoint column, *Run agent* in an
  agent column, *Move to next* otherwise, disabled while a run lives —
  plus **Move…** (every phase, the commit line it makes) and **⋯**
  (claim / take over / release, archive with the armed second tap).
- **Capture**: title, priority, repository, description into the Inbox,
  then the new ticket opens.
- Pairing from the QR link or a typed code; an unknown or revoked token
  returns to pairing. Home-screen web app (manifest, icons), safe-area
  insets, 44 px targets, Anthrazit palette.
- Live: the event stream (read with `fetch`, bearer header) redraws on
  every board or fleet change, reconnects with backoff and when the app
  returns to the foreground; a redraw waits while a swipe is under a
  finger (found by the e2e round: an update mid-swipe dropped the
  gesture). The Move sheet's hover preview was dropped — on touch it
  fired on the tap itself.
- Server side: `GET /api/tickets/:id` (card + file text,
  `BoardService.readTicket`, `TicketsRemotePort.ticket`).
- Build: `scripts/build-plugins.mjs` bundles `plugins/<id>/remote/app.ts`
  into one IIFE script (Safari 15 target, own-sources rule) and copies
  the client's static files; `plugins/tsconfig.renderer.json`
  typechecks `plugins/*/remote/`.

Specs: `remote/model.spec.ts`, `remote/sse.spec.ts`; router spec for
the ticket route; `e2e/tickets-remote.spec.ts` (Chromium at iPhone 13
size against the built gateway and client with an in-memory English
demo board, `e2e/fixtures/tickets-remote-desk.ts`: pairing from the
link, Needs you, a swipe move with the device actor, approve, the Move
sheet, Capture, the unpaired path, no console errors). Docs: docs/05
§5.41, manual "The board from a phone or tablet".

### req-66 R2 — Tickets remote: gateway, pairing and settings

**Not yet manually verified by the owner.** Owner request, outside the
list (ADR-0084). The tickets plugin now serves the board over HTTP to
paired devices — off by default:

- **Settings → Tickets → Remote access** (`renderer/settings-remote.ts`):
  Enabled, Reach (loopback through Tailscale Serve, or one LAN
  interface with a plain-HTTP warning), port (default 47811), device
  address, bypass runs. Changes apply at once (the gateway restarts).
  Pairing shows a QR code of `<device address>/#pair=<code>` plus the
  typeable code (10 characters, Crockford base32, single use, 5
  minutes); paired devices list with "last seen" and Revoke; a device
  can be paired read-only.
- `main/remote/gateway.ts` — `node:http`, strict CSP and security
  headers on every response, JSON API, Server-Sent Events
  (`board` / `fleet`), static client files (the built-in pairing page
  until R3), 64 KB body cap.
- `main/remote/router.ts` — the API as a pure function: Host allowlist
  first (DNS rebinding), foreign Origin refused on writes, pairing,
  bearer auth, failure limit (10 per 10 minutes per address), read-only
  devices, the device actor (`owner@<device>`) on every write. Routes
  as in ADR-0084; a board refusal stays a 200 with `{ ok: false }`.
- `main/remote/auth.ts` — pairing codes, device registry storing only
  SHA-256 token hashes (in the plugin config, `remote.devices`), the
  failure limiter. `config.ts` — normalized `remote.*` settings, bind
  address (never 0.0.0.0), allowed hosts, device URL.
- `main/remote/qr.ts` — a dependency-free QR encoder (byte mode, level
  M, versions 1–10); every version was decoded with OpenCV when it was
  written, instead of adding a package.
- Wiring: the board's debounced change and the fleet push feed a
  `ChangeHub`; the plugin's new `deactivate` stops the server.

Specs: `remote/qr.spec.ts`, `auth.spec.ts`, `config.spec.ts`,
`router.spec.ts`, `gateway.spec.ts` (real loopback socket: headers,
Host refusal, bad JSON, the event stream). Checked beyond the specs: the
built service end to end (pair by the QR's code, `/api/me` actor,
foreign Origin 403, no plain token stored) and the pairing page in
Chromium at iPhone size (pairs from the link, strips the fragment,
survives a reload, no CSP errors). Docs: docs/05 §5.41, docs/06 §6.70,
manual "The board from a phone or tablet", FLEET.md.

### req-66 R1 — Tickets remote: command layer and port

**Not yet manually verified by the owner.** Owner request, outside the
list (ADR-0084). The first step of the tickets remote, behaviour-neutral
in Drey:

- `plugins/tickets/main/commands.ts` — one parser per board command
  (create, transition, reorder, unpin, claim, archive, unarchive, run
  start/stop/send/answer/permission, chain master/column/stop) and
  `chainResult`. The IPC handlers now call them; refusal texts are
  unchanged. The gateway (R2) will call the same parsers.
- The board writes (create, transition, archive, unarchive, claim)
  take an optional actor; Drey keeps `owner@<host>`, a remote device
  will write `owner@<device>` (`remoteActorOf`, `specs/ticket-schema.md`).
- `plugins/tickets/shared/remote-protocol.ts` — `TicketsRemotePort`,
  the host-neutral surface a gateway talks to, and the "Needs you"
  item shape.
- `plugins/tickets/main/remote/needs.ts` — the pure `needsOf`: waiting
  questions and permissions, red gates and failed runs whose ticket
  still sits in the run's phase (latest run only), checkpoint tickets
  without a live run, in that order, oldest first.
- `plugins/tickets/main/remote/drey-port.ts` — `DreyTicketsPort` over
  the board service and the fleet client, plus `ChangeHub`; a bypass
  run is refused unless the (R2) setting allows it. Not wired to a
  server yet.

Specs: `commands.spec.ts`, `remote/needs.spec.ts`,
`remote/drey-port.spec.ts` (16 cases). Docs: ADR-0084, docs/05 §5.41.

### req-62 — Ticket header in the editor

**Not yet manually verified by the owner.** Owner request, outside the
list. A ticket opened from the board showed its frontmatter folded behind
the `▸ Frontmatter` pill — no title, and priority / repo / worker only
by editing YAML. Now a ticket of the board's vault opens with a header in
the pill's place (`plugins/tickets/renderer/ticket-header.ts` +
`ticket-header.css`): id, phase, priority, repository, worker, branch and
the issue badge on one row, the title as an editable headline below
(Enter / leaving the field applies, Escape restores). Priority,
repository and worker are menus. The header reads the editor's buffer,
not the file: main parses and rewrites the block (`header` /
`headerEdit`, `patchHeaderFields` in `main/ticket-files.ts` — `yaml`
document mutation, title double-quoted unless the owner chose single
quotes, an empty repo stays `repo:`, an empty worker drops the pin) and
the renderer applies the result as one editor change, so dirty state,
undo, save and the conflict merge stay the editor's. A code button opens
the base's YAML view. The `## Log` section folds the first time a ticket
shows in a session.

The phase chip is display only — a deviation from the plan, which had a
"Move to" menu: the move renames the file, and an open tab whose file
vanished becomes a draft that a save would recreate in the old folder (a
duplicate id). Moving stays on the board; the header move is a roadmap
follow-up.

**SDK 1.34** (base seam): `api.editor.registerFrontmatterView({ matches,
render })` — `frontmatter-fold.ts` asks the new `FrontmatterViewRegistry`
(through `MarkdownSurface`) and draws the plugin's element as the folded
block widget (`input`: view, frontmatter, path, vault id, `expandRaw`);
a throwing render falls back to the pill; a (de)registration redraws
open editors (`refreshFrontmatterView`), and so does a change of the
surface's path or vault — on a tab switch the text lands before the path
input names the new document, so the first lookup saw the old path (found
in the live e2e run). `EditorSurfaceContext` gained `vaultId()`.
`plugins/AUTHORING.md` documents both.

Specs: `src/app/editor/frontmatter-fold.spec.ts` (the plugin view takes
the pill's place, gets path and vault, `expandRaw`, fallback, redraw only
on a changed block, refresh effect), `plugins/tickets/main/ticket-files.spec.ts`
(`patchHeaderFields`), `plugins/tickets/renderer/ticket-header.spec.ts`
(ticket paths, phase of a path, the Log fold range), and the e2e
`e2e/ticket-header.spec.ts` in the built app (card click opens the ticket
with the header and the folded Log; a priority pick and a title edit are
buffer edits shown in the raw YAML; Undo reverts the title; a plain note
keeps the pill).

### req-64 - A worker that needs the owner asks, waits and says so (owner request, outside the list)

**Not yet manually verified by the owner.** No worker ever got an answer:
OpenCode 2.0.32's own `question` tool asks through a *form*
(`/api/session/{id}/form`, not under any "question" route) and blocks its
call until the form is answered — the adapter never looked, so such a
worker stood for good; a question at the end of a turn counted as "done"
and went to the gate; and req-56's orientation told workers nobody
answers. A second wait was invisible: OpenCode holds a tool call that needs
approval (`/api/session/{id}/permission`), and the adapter never looked —
such a worker looked busy and turned red after five minutes.

- **Asking** (owner's choice: a text marker over an MCP `ask_owner` tool):
  a turn whose last message starts with `QUESTION:` does not end the run.
  The adapter stands the worker — OpenCode keeps its server, Claude Code
  its stdin — and reports `waiting: {kind: 'question', text}`; the owner's
  next message is the answer (no takeover: the next finished turn ends the
  run as usual), and handing back unanswered ends it. Every brief carries
  the rule (`composeInstruction`), and `docs/agents/fleet-worker.md` says
  to ask only what blocks the step.
- **OpenCode's `question` tool**: the adapter polls the session's pending
  forms; one becomes `waiting: {kind: 'question', text, requestId,
  questions}` — each question with its header, its choices and whether
  several may be picked. The takeover's wait card shows them as buttons
  (one click answers a single question; several are picked, then sent);
  a typed answer works too (one line per question, a choice by its number
  or label, otherwise the owner's own words). `POST /answer` replies to
  the form (`/form/{id}/reply`, `{answer: {q0: …}}`), the blocked call
  returns, and the turn goes on — no takeover. The transcript shows the
  call as "asks …", not a bare "question".
- **Approvals**: the OpenCode adapter polls the session's pending
  permission requests and reports `waiting: {kind: 'permission', text,
  requestId}`; `POST /permission` (`once` / `always` / `reject`) answers
  it through `/permission/{id}/reply`.
- **The run records it**: `RunInfo.waiting` (with `since`), a ticket Log
  line ("asks the owner — …", "rejected by the owner — …"), a runner log
  line. A waiting run is amber, never stalled.
- **Telling the owner** (owner's choice: Windows plus the board): SDK 1.34
  adds `ui.notify` — the renderer's Web Notification API, a Windows toast
  (the app now sets its AppUserModelID: `de.lariscus.drey` packaged, the
  executable in dev), a click brings the window forward over the new
  `window:focus` channel. The tickets renderer announces each new wait
  once (`newWaits`); a click opens the run's takeover tab, where a wait
  card shows the question above the prompt box or the three approval
  buttons. Lane and card chip turn amber ("? waits for you").
- Fixed while the owner tested: the wait card stayed on screen with its
  approval buttons when nothing waited (its `display: flex` beat
  `[hidden]`), so a click answered "waits for no approval".
- Specs: `providers.spec.ts` (both adapters' question flow, the permission
  and form polls and replies, `questionOf`, `permissionText`,
  `answersFromText`, `formText`, `answersText`), `runs.spec.ts`,
  `waiting.spec.ts`, `worker-status.spec.ts`, `fleet-fields.spec.ts`,
  `src/app/plugin-host/os-notify.spec.ts`.

### T-0050 — Ticket dependencies: the `blocked-by` field, board display and fleet enforcement

Tickets could not express "do not start before X is done" — the order
lived in prose (T-0049: "Blocked by T-0048"), invisible to the board
and the fleet. A first-class dependency field now exists
([ADR-0076 later change](../docs/09_architecture_decisions/0076-ticket-repository-format-and-coordination.md),
`specs/ticket-schema.md` § Dependencies):

- **The field**: `blocked-by: [T-0048, T-0049]` — a flow list with
  comma + space as the canonical form, round-tripped byte-stably by the
  transition patcher (no patcher change was needed, verified against
  the vendored `yaml`; every list shape parses, a no-space list
  normalizes cosmetically on the next machine rewrite). The parser
  keeps entries as written; an unreadable shape warns and reads absent.
- **Blocked is derived, never stored** — the columns/order/claims
  discipline: a pure dependency pass (`plugins/tickets/main/blocked.ts`)
  runs in every board assembly after the duplicate-id pass and stamps
  each card with its open blockers (`blocked`, unknown ids included)
  and the open-edge inverse (`blocks`). A reference is satisfied
  exactly in the terminal phase — one global rule; per-reference
  override syntax was rejected (no user, grammar cost). Never a silent
  unblock: an unknown id (deleted, renamed, archived — the board never
  reads `tickets/archive/`) warns and keeps blocking; self-reference
  and cycles are one error per member naming the cycle, and cyclic
  members count as blocked.
- **Enforcement at the machine gates**: `dispatchable` refuses blocked
  cards, the chain's `noteWaits` logs the hold naming the blockers
  (before the claim/run branches, per-reason dedup), the ci sweep skips
  them, and the manual run start refuses through `blockedRefusal`. The
  owner stays the final authority: a drag into an agent column opens a
  Cancel / Move anyway confirmation; other columns never ask. The drift
  pass never enforces blocked-ness.
- **The board**: `blocked by <ids>` / `blocks <ids>` chips (titles name
  the ids; both hide once satisfied), and a "hide blocked" toolbar
  filter above the columns — pure view state
  (`localStorage['drey.tickets.hideBlocked']`, the column-collapse
  pattern): it hides cards, it never reorders anything.
- Follow-up data edit: T-0049's prose dependency became
  `blocked-by: [T-0048]`.
- Specs added: `main/blocked.spec.ts` (parse shapes, derivation,
  validation, byte-stable round-trip), `main/fleet/blocked-dispatch.spec.ts`
  (the real orchestrator over a temp vault), `renderer/blocked-view.spec.ts`;
  manual §13, `BOARD.md`, `FLEET.md`, `docs/05` §5.0/§5.41 updated.
  **Not yet manually verified by the owner.**

### req-63 — Fleet: provider pools and column priority instead of per-column slots

Owner-verified (signed off 2026-10-30). Owner request, outside the
list. A column's `workers:` pool bound its slots to that column: an idle
`plan` slot could not serve `build`, the dispatcher filled columns left
to right (starting work before finishing it), and a ticket's priority
only sorted inside its own column.

The parallel slots now belong to the **worker providers**
(`fleet.pool.opencode.size`, `fleet.pool.claude-code.size`, Settings →
Tickets → Fleet; default one each). Every live run of a provider — the
owner's on-demand runs included — takes one of its slots. `planDispatch`
(`plugins/tickets/main/fleet/chain.ts`) builds one candidate list over
every playing automatic column and orders it by **priority class**
(`urgent`/`high` before `normal`/`low`), then **column rank — rightmost
first**, then the column's own order; a candidate takes a slot of the
pool its assignment resolves to (the same ladder as the run request) and
waits when that pool is full. A running run is never preempted. Master,
brakes, cooldown, breaker and the checkpoint rule are unchanged.

Can the capacity be read from the provider? Only from a **llama.cpp**
server (`/props` → `total_slots`): `fleet.pool.opencode.probe` takes its
base URL, and the probe (every five minutes) caps the configured size.
vLLM, LM Studio and Ollama keep their parallelism in server flags;
hosted APIs and the CLIs' subscriptions report none. Instead a run that
fails on a **rate limit** (`429`, "rate limit", "too many requests" in
the worker's last error, new `RunInfo.lastError`) shrinks its provider's
pool by one slot for five minutes (never below one).

The column `workers:` key is gone (owner decision — no per-column cap or
reservation): `PipelinePhase.workers`, the settings table's Pool column
and the `×N` on the column chip are removed; a leftover key is ignored
with a noise badge that points at the Fleet settings, and clearing a
column's worker still removes it. The lane strip shows a column's busy
runs without a slot count. Specs: `chain.spec.ts` (shared pool,
rightmost-first, priority classes, two providers, live runs, an
unresolvable assignment), `orchestrator.spec.ts` (shared pool, probe
cap, rate-limit shrink, pool helpers), `ticket-board.spec.ts` (the
retired key). Docs: `specs/ticket-schema.md`, ADR-0077 later change,
`docs/05`, `docs/06`, the manual.

### req-61 — Tickets board: messages at the right end of the status bar

Owner request, outside the list. req-60 put the board's message at the
left of the status bar, so every message that appeared or faded shoved
the cycle times sideways — restless in use. The bar's right end is now
one group (`.tickets-statusbar-right`, `statusBarNode` in
`plugins/tickets/renderer/index.ts`): the message, then the worktree
pill anchored at the edge. A message comes and goes in the free space
left of the pill, so neither the cycle times nor the pill move. In a
narrow panel the cycle-time segments that do not fit drop whole (they
wrap onto a hidden second line) instead of being cut mid-word; the
right group takes at most 60 % and cuts the message text with an
ellipsis (full text in its tooltip). Also: the `fleetHeaderNode` doc
comment sits on its function again. Manual: the status-bar sentence.
Owner-verified (signed off 2026-10-30).

### req-60 — Tickets panel: fleet status in the panel header

Owner request, outside the list. The fleet summary sat as a row of three
pills between the panel header and the board (`● 1 running` ·
`18.9M tokens in flight` · `running 26:22`), a whole row of board height.
It now rides the panel header as one compact group before the New /
Refresh / master buttons (`fleetHeaderNode` in
`plugins/tickets/renderer/index.ts`): the worst light of all live runs,
the non-zero states in words (`2 running · 1 stalled`), then tokens in
flight and the oldest run's age in muted tabular mono
(`· 18.9M tok · 26:22`); the long form is its tooltip and `aria-label`.
It repaints on fleet updates and once a second, hides without live runs,
and drops the numbers below a 480px panel width (a `ResizeObserver` on
the panel — no size container around the base header). The counting is
the pure `fleetSummary` in `worker-status.ts` (spec added). The
"Tickets" title stays — the uniform panel head (ADR-0057/M69); hiding it
was considered and declined with the owner (it would need an SDK option
like the calendar's `headerReplacesTitle`). `fleetSummaryNode` and the
`.tickets-summary` / `.tickets-pill*` styles are gone.

The whole header row was then redesigned (owner request, same item):
four groups set apart by air and a hairline — **status chip** (the
fleet group as a quiet `--bg-input` chip; below 380px its light alone)
│ **board actions** (new, refresh) │ **chain controls** — run / halt
as one global `.seg` switch with the active half filled
(`--accent-surface`), then the emergency stop as a `square` icon (was
`triangle-alert`, which read as a warning, not a stop), muted until
hovered │ **`⋯` overflow** (`headerMenuButton`) with *Chain log* and
*Clean up worktrees…*. The text button "Log" and the always-visible
trash icon are gone: every header control is icon-only (ADR-0057); the
menu is keyboard-usable (focus on open, arrows, Escape returns focus).

The board's messages moved too (owner request, same item): they were
an extra `tickets-note` row between the header and the board that
pushed the board down and stayed until the next action overwrote it.
They now lead the one-row status bar under the board (req-59) as a
typed message (`setNote(text, kind)`): **busy** pulses while an action
runs, **ok** shows a green tick and fades after 6 s, **warn** (amber —
a mutation's warning, a cleanup that kept dirty trees) and **error**
(red, `role="alert"`) stay until closed with ×. A failed board pull
clears itself on the next good pull; the bar also shows on the
loading / no-vault screens so a failure there is visible. The plain
refresh no longer flashes a "Loading…" line. `BoardView.status` is
gone.

Manual: the lane paragraph, the master switch, the Log and cleanup
mentions, the status bar's messages. Owner-verified (signed off
2026-10-30).

### T-0049 — Fleet: session resume and native compact (measurement-gated)

The remainder of the original T-0046, gated on T-0048's numbers: the
start condition was met via the retry arm (gate-failure retries on 3 of
5 post-pack tickets, each re-paying 0.5–1.3M input-side tokens before
its first write; the token arm stayed under the bar at 6.6 %). Three
spikes measured the ground first — `/compact` routes natively in both
CLIs' command plumbing, opencode's `POST /api/session/{id}/compact`
compacts for real (context halved, facts kept, ~0.75k tokens), and a
resumed turn re-pays the transcript as cache reads (still ~99 % cached
after a ≥ 6 min pause; measured auto-retry gaps ran 1–13 min).

- **The handover modes** (`HandoverMode` on `RunRequest.handover`:
  `fresh` | `resume` | `resume-compact` | `auto`, absent = fresh — wire
  compatible). One pure resolver, `main/fleet/handover.ts`, runs inside
  `RunSupervisor.start()` after worktree preparation: review always
  fresh; the candidate is the newest terminal run of the same ticket +
  provider + model (`detached` never qualifies); a recreated/moved-aside
  worktree (T-0047's `sessionInvalidated`) or a session another
  non-terminal run holds resolves fresh; a warm pause (TTL) or a context
  below the threshold resumes; a cold pause with a big context resumes
  and compacts first — natively, where the provider can (opencode:
  measured; claude-code: `COMPACT_CAPABILITY` stays `none` until an
  effect is verified). An unknown context (pre-T-0048 records) never
  auto-compacts. `handoverMode` and `resumedFrom` are recorded per run.
- **The adapters** (`ProviderStart.compactFirst`/`onResumeFailed`):
  opencode pre-flights every resume with a session GET and settles the
  compact's turn (its `idle` marker) before the instruction rides —
  `lastPromptAt` only exists after, so the poll cannot kill the worker
  on the compact's own idle; claude-code sends `/compact` as a
  stream-json user message and awaits its `result`, and treats an exit
  before any init as a failed resume. A failed resume never fails the
  run: the supervisor respawns fresh under the same run id, same
  instruction, one stream note.
- **The start dialog** (renderer `handover-ui.ts`, pure) offers the
  three options with the computed default preselected and the last run's
  phase · state · ctx · age in one status line; an option is enabled
  exactly when an explicit ask for it would be honoured (the same rules
  asked per mode), so illegal choices are disabled with their reason —
  never silently switched. Per-run choice, nothing persisted; the lanes
  append a `resumed` chip. The dispatcher sends `auto`.
- **Config**: `fleet.compactAboveTokens` (default 60000, provisional —
  the bar guards fidelity loss, not tokens) and `fleet.resumePauseTtlMin`
  (default 15) in Settings → Tickets → Fleet, pushed to the runner with
  the chain config; per-provider/model override flat keys
  (`fleet.compactAboveTokens.<provider>[/<model-pin>]`, most specific
  wins) ride along for the providers and the board's pins — no UI.

Specs: `handover.spec.ts`, `handover-ui.spec.ts` (new — one case per
rule), `providers.spec.ts` (pre-flight, compact-first, no-init failure),
`runs.spec.ts` (resolution, guards, fallback, stamps, resume strip),
`request.spec.ts`/`orchestrator.spec.ts` (passthrough, `auto`),
`worker-status.spec.ts` (resumed chip). ADR-0075 carries the
T-0047–T-0049 later-change note; FLEET.md documents the modes, fields
and fallback; manual §13 the dialog. **Not yet manually verified by the
owner.**

### req-59 — Tickets board: one-row status bar

Owner request, outside the list. The board's status area under the
columns stacked two `tickets-metrics` text lines — the per-column
average dwell (M85, `Inbox ⌀11d · Prioritized ⌀30m · …`) and below it
the worktree note (T-0044, "Worktrees: 9 legacy worktree folders to
clean up"). Now one 26px bar (`statusBarNode` in
`plugins/tickets/renderer/index.ts`, `.tickets-statusbar*` in
`board.css`): on the left the label *Avg. time in column* and one
segment per non-empty column (name muted, value in tabular mono); on
the right an amber warning pill with an icon (`9 legacy worktrees ·
2 orphans`) whose tooltip lists the folders and points at the Clean up
worktrees control. When the panel is narrow the cycle times are cut
off, the pill stays visible; the bar is absent when neither has
anything to say. Renderer-only. Supersedes the never-merged one-line
variant left in `stash@{0}` (not applied, not dropped). Manual: the
board paragraph. Owner-verified (signed off 2026-10-30).

### Fix — fleet: the build column dispatches again (worktree leftovers, the walk-up misread, the silent queue)

Owner request, outside the list (the runner stopped picking up tickets
under `50-build`). Three defects compounded: a worktree cleanup left the
repo's `link:` junctions (`.tools`, `node_modules`) behind as
unregistered folders; `prepareWorktree`'s stale-row check then ran
`git rev-parse` inside such a leftover, which walked up into the tickets
vault — itself a repo on `main` — and reported the VAULT's branch as the
folder's, turning the designed "uninspectable → move aside" into a
permanent wrong-branch refusal (`worktree … is on main, expected t/<id>
— refusing to touch it`); and with `workers: 1` the refused candidate
consumed the column's only plan slot on every 15 s pass, parking every
queued ticket behind it in silence. Now:

- **`worktrees.ts`**: `currentBranch` resolves `--show-toplevel` first
  and answers only when the toplevel IS the worktree path (either
  spelling — the `findWorktreeEntry` alias discipline); an inherited
  answer from an enclosing repo reads as "no longer answers to git", so
  the leftover is moved aside and a fresh checkout takes its place
  (self-healing, reported as `moved-aside`).
- **Every removal path unlinks the junctions first** (`unlinkShared`,
  now exported from `worktrees.ts`): `removeWorktree`/`cleanWorktrees`
  (`worktree-clean.ts`, new `links` option carrying the repo's `link:`),
  the card-menu and Files "Remove worktree" commands (`main/index.ts`),
  and the re-run healing's own `worktree remove` (`healBranchConflict`).
  git's removal never passes through a reparse point cleanly, so none is
  left in its way — a cleanup can no longer leave a poisoned folder.
- **`orchestrator.ts`**: a dispatchable candidate the plan had no slot
  for is no longer silent — `dispatch waits <id>: no free <column>
  worker slot yet` behind a live run, and `dispatch waits <id>:
  <column>'s dispatch of <id> was refused — the queue cannot advance`
  when a refused start parks the queue (deduped like every note: one
  line per episode).
- Specs: the walk-up trap reproduces the production layout (a junction
  leftover inside a git vault) and pins the self-healing; an unregistered
  folder that IS its own repo on a wrong branch still refuses; removal
  unlinks and the delete never reaches through a junction; both queue
  notes are pinned in the orchestrator suite.
### req-58 — Takeover tab: readable transcript + structured header

Owner request, outside the list. The takeover transcript ran through
the host's Markdown view, which showed every tool outcome as a literal
`&nbsp;&nbsp;⎿ …`, drew thinking as a heavy blue quote callout and
printed full absolute worktree paths; the banner packed every number
into one mono `·` string. Now:

- **Own DOM transcript** (`plugins/tickets/renderer/transcript-view.ts`)
  over the watch view model, which carries tool calls and thoughts as
  data (`WatchBlock.step` / `thought` / `text`): tool calls are quiet
  rows (state dot, tool, target relative to the run's worktree with the
  full path in the tooltip, result muted), runs of four or more fold
  into an "N tool calls" line (open while it is the live tail), thinking
  is a borderless fold with a one-line preview, the owner's messages a
  bubble, errors a tinted row, "Turn finished" a divider. Replies render
  a small Markdown subset as nodes, never `innerHTML`
  (`transcript-text.ts`: paragraphs, headings, lists, quotes, rules,
  pipe tables, fenced code); prose keeps a 76ch reading width, tables
  and code use the whole column. A fenced block has a head (language,
  Copy on hover) and the editor theme's syntax colours via
  `ui.highlightCode` (worker spellings `ps1`/`pwsh`/`sh`/`bash`/`jsonl`
  mapped to the catalogue's names; `diff`/`patch` coloured per line); a
  fence inside a list item loses its indent. Thoughts render through the
  same subset, muted — that is where workers write most of their code.
  Items whose content did not change keep their nodes across the 2 s
  pull, so an unfolded thought stays unfolded; the view follows new
  output only while the reader is at the bottom (else a
  "↓ New output" button).
- **View-model fixes the new view surfaced** (`watch-format.ts`):
  parallel calls of one tool pair with their inputs in call order and
  their outcomes by the target the outcome names (longest wins), else
  call order — they used to leave orphan "running…" steps and swap
  results; a turn's end drops input-less placeholders and stops every
  running step; a reply part whose deltas tool calls cut up is replaced
  whole at its first fragment by its seal (no more half sentences
  followed by the full one); `run finished` and `gate:` notes are muted
  lifecycle lines instead of tool steps.
- **Two-row header**: ticket, worker · model, a mode pill (Runner
  driving / You have control / Detached / Run …, the explanation in its
  tooltip), the status word; below, labelled metrics — Turn, Context as
  a mini bar (amber ≥ 70 %, red ≥ 90 %), Tokens in (cached) / out with
  the ctx/turns/reads telemetry in the tooltip, Elapsed. The banner's
  gradient is gone (flat, the state colour stays as the bottom border).

Specs: `transcript-view.spec.ts`, `transcript-text.spec.ts` (new),
`watch-format.spec.ts` (structured blocks, parallel pairing, fragment
seal, outcome by target). Manual: the takeover paragraph. Owner-verified
(signed off 2026-10-29).

### T-0053 — Tickets board: card-menu move to top / bottom

The card context menu gains "Move to top" / "Move to bottom": the same
`reorder` operation a within-column drag performs, with drop index 0 /
the column's end — no new IPC and no main-process change, so a menu
move and the equivalent drag write identical `order.md` pins (the top
pins only that ticket, the bottom pins the whole column in its visual
order with it last). Both items are disabled when the card already
sits at that end (a single-ticket column disables both) and carry
tooltips naming the pin effect, which a plain menu item cannot show.
The index math lives in the pure, specced helper
`plugins/tickets/renderer/card-order.ts`; `specs/ticket-schema.md`
records the drag equivalence. **Not yet manually verified by the
owner.**

### Fix — fleet: cleanup survives path aliases (`RUNNER~1`, junctions); CI green again

Follow-up in the family of the T-0047 alias fix below, caught by CI on
the GitHub Windows runner: `cleanWorktrees` compared the porcelain
listing against the bases, the protected paths and the repo's own
checkout by string form — while git reports the paths it registers
canonically and the caller can hold an alias, the runner's 8.3 temp dir
(`C:\Users\RUNNER~1\…` for `runneradmin`) being the live case. Under an
alias every entry fell outside the bases, so the Clean up button and
the boot migration silently removed nothing (and the specs' own path
compares missed too). Boundaries now match through both spellings, the
given form and its realpath (`matchForms` in `worktree-clean.ts`, the
`findWorktreeEntry` discipline); the report keeps git's paths, and
`realPathOrNull` is now part of `worktrees.ts`'s exported compare
discipline. Second, caught by the first `npm run dev`/build since the
merge: the T-0048 context pack in `plugins/tickets/main/index.ts`
narrowed `repo.path` but not `repo` itself (`RepoRef | null`), so
`plugins/tsconfig.main.json` — compiled by the build step, not by the
four typecheck gates — failed with five errors; the guard now checks
both. Specs: fixtures start canonical (the runner's temp dir no
longer decides which shape a test exercises), and a junction test pins
the alias case on any Windows checkout. **Not yet manually verified by
the owner.**
### T-0045 — Git repository auto-detection under parent vaults

A vault that is only a **parent folder of repositories** (`E:\projects`
with `drey/`, `drey-tickets/`, … inside) showed nothing in Source
control — every repository below had to be registered as its own vault.
Shipped as
[ADR-0083](../docs/09_architecture_decisions/0083-repository-discovery-under-parent-vaults.md),
layered strictly on T-0042's protections:

- **The bounded scan** (`plugins/git/main/discover.ts`): fs-only, at
  most 3 folder levels below a vault that is no repository itself, at
  most 25 repositories per vault (clipped + logged). A `.git` FILE
  counts like a `.git` directory (linked worktrees); dot-directories,
  `node_modules`, reserved `_`-root folders, other registered vaults'
  subtrees and symlinks are skipped; a found repository is never
  descended into; a candidate overlapping another registered vault
  (ancestor or descendant) is dropped.
- **Read-only by construction**: every found repository surfaces in the
  panel and as Files badges with vault-relative paths
  (`prefixStatusPaths`), but ALL mutating handlers refuse it as their
  FIRST guard — before a repository is located or git runs — with
  "This repository was found under "\<vault>" and is read-only here.
  Register it as a vault to work with it." (the scan could surface an
  unregistered tickets repo that no plugin claimed — refusing
  everything is the airtight boundary; queries answer, diffs and file
  history stay).
- **One-click registration (SDK 1.33)**: `ctx.vault.register(path)` —
  `VaultManager.addVaultAt` plus the same watcher-sync + full-refresh
  round the vaultAdd IPC handler runs — is the hint row's *Register as
  vault* button; the refresh makes the panel swap the found twin for
  the vault's own entry.
- **Repo-keyed panel**: commands carry `{vaultId, subPath}` (`''` = the
  vault's own repository — every existing payload stays valid); the
  panel's current repository, drafts and busy bookkeeping key by
  `vaultId::subPath`; the focused document's path picks between several
  found repositories; one vault's decorations (own + found) ride one
  `setFileDecorations` call. Rescans on registry changes and relocate.
- Specs: `plugins/git/main/discover.spec.ts` (the walk: depth, skips,
  `.git` files, overlap, cap), `plugins/git/main/discovered.spec.ts`
  (real git over temp dirs: states, all fifteen refusals, queries,
  registerVault routing), `status.spec.ts` / `repo-model.spec.ts` (the
  mapping helpers and the repo picker), an `e2e/git.spec.ts` flow.
- Also fixes a pre-existing tsc error the T-0042/T-0048 merge left in
  `plugins/tickets/main/index.ts` (a `RepoRef | null` deref no gate
  command covers — found via `npm run build:plugins`).

**Not yet manually verified by the owner.**

### T-0042 — Files vault extension: per-vault operations, plugin-managed repositories

The Files panel treated every vault the same; a dedicated vault (the tickets
repository) needs its operations to BE the feature's semantics. Owner
decisions from the 2026-10-18 rounds, shipped as
[ADR-0082](../docs/09_architecture_decisions/0082-per-vault-files-seam-and-plugin-managed-repositories.md):

- **The `files` SDK seam (1.32).** A plugin registers an operations handler
  (`api.files.registerOperations`) that the Files panel consults BEFORE any
  dialog or base-side work — create, rename, move (drag & drop), copy
  (paste/duplicate), delete: `allow` runs the base flow, `refuse` shows its
  reason and replaces the flow, `handle` performs the operation as a
  structured action (open tabs re-key to the outcome path). First refusal
  wins, then the first handler, registration order. Plugin context rows
  (`api.files.registerContextMenuItems`) append to both Files menus,
  re-evaluated per open.
- **The tickets vault is guarded and its drags are transitions.** Inside
  `tickets/`: create/rename/delete/copy refuse with educating reasons
  (capture, filename identity, pipeline, archive); a drag between phase
  folders or into `tickets/archive/` performs the SAME single-writer
  mutation the board runs — stamp, Log line, pin cleanup, one commit. A
  drag out of `tickets/archive/` is a new one-commit `unarchive`
  (`archive -> <phase>`), never a raw move. Context rows: "Archive
  ticket", "Unarchive ticket" (to the first phase), "Remove worktree" on
  `_worktrees/<id>` (dormant until T-0044 creates the folder).
- **Plugin-managed vaults are read-only in Source control.** The tickets
  plugin flags the detected vault (`ctx.vault.markManaged`, main-side
  base-owned registry, follows detection both ways); the git plugin
  refuses stage/discard/commit(+amend)/pull/push with "Managed by
  Tickets" — first statement of each handler, no repo lookup needed — and
  the panel shows a "Managed by" banner with those actions disabled.
  Branch, dirty state, log, file history and decorations stay. T-0045
  (repo auto-detection) is sequenced after this protection.
- **Housekeeping:** `.gitattributes` keeps the shipped tickets prompts LF
  (fresh worktrees under `core.autocrlf=true` smudged them CRLF and
  `default-prompts.spec.ts` asserts raw LF — every fresh worktree was red
  before this).

Tests: `plugins/tickets/shared/files-guard.spec.ts` (the verdict table),
`plugins/git/main/managed.spec.ts` (the five refusals, queries untouched),
`electron/plugin-host/managed-vaults.spec.ts`, the two renderer registry
specs, `files-panel.spec.ts` (refused/handled moves, plugin rows),
`worktree-removal.spec.ts`, `ticket-files.spec.ts` (the `archive ->` patch).

**Not yet manually verified by the owner.**

### T-0048 — Run token telemetry, output capping and the plan context pack

**Not yet manually verified by the owner.** Cost visibility and context
hygiene for the fleet (ADR-0081):

- **Telemetry per run**, folded live into `run.json` (`RunInfo`): `usage`
  (`input`/`cacheRead`/`cacheCreation`/`output`, summed over the run's
  model calls — a counter the provider never reports stays `null`, never
  0), `lastTurnContext` (the LAST assistant turn's input side — the real
  context size; the providers' aggregates are cumulative and never used
  for it), `turns`, `readCalls` (read/grep/glob), `tokensBeforeFirstWrite`
  (the exploration metric), plus `gateResult`, `model`, `phase`,
  `handoverMode: 'fresh'` (the field exists for T-0049). Both adapters
  emit one `turnUsage` per model call and the tool name on tool-call
  notes; the board's lanes and the takeover tab show `ctx · turns ·
  reads` chips. `GET /report` on the runner groups tokens by ticket,
  phase and model, sorted by total (curl-able; pre-T-0048 records fall
  back to their cumulative counters).
- **Output capping**: a gate failure is stored multi-line but
  sanity-bounded (400 lines / 64 KiB) on the record, and injected into a
  retry's instruction as a configurable tail (default 40 lines / 4096
  bytes); the worktree's diff stat rides every instruction as a
  configurable head (50 / 4096). Keys `fleet.cap.*` (Settings → Tickets
  → Fleet); every application is logged with `truncated: true,
  originalSize`. The ticket Log keeps its single-line discipline
  (`shortGateLine`).
- **The plan as context pack**: `composeInstruction` now orders every
  instruction repo agent instructions (verbatim, `CLAUDE.md` preferred)
  → phase template → `## Plan` verbatim → variable parts (who/where,
  description, diff stat, the previous run's gate failure on a retry,
  gate commands, completion discipline) — the prefix up to the plan is
  byte-identical across runs of the same repo and phase, so a warm
  prompt cache survives. A red-gate retry is a fresh run carrying the
  ticket's most recent `gateFailure` (owner-started and dispatched
  retries behave identically). The plan prompt now demands six fields
  (Files, Interfaces, Decisions, Pitfalls, **Verification commands**,
  Out of scope); build/review prompts sharpen tool-output guidance
  (line ranges, head/tail for logs).
- Specs: `capping.spec.ts`, `telemetry.spec.ts`, `report.spec.ts` (new),
  fixture-driven per-adapter multi-turn cases in `providers.spec.ts`,
  the fold and gate verdicts in `runs.spec.ts`, the pack order/prefix/
  retry in `fleet-fields.spec.ts` + `request.spec.ts`, the retry
  dispatch in `orchestrator.spec.ts`, `telemetryParts` in
  `worker-status.spec.ts`.

### Fix — fleet: the context bar measures the model's real window (T-0052)

The worker lanes measured the used context (`RunInfo.contextTokens`,
the last model call's input incl. cache reads) against a hardcoded
200k — a 1M-token model read ~5× too full and warned "Context full"
from the first call. The runner now asks the opencode v2 server for
the model's window once per worker (`GET /api/model`, matched by the
run's model pin — `providerID` + `id`, then `providerID` + `modelID`,
a `#variant` suffix stripped; without a pin `GET /api/model/default`):
a hit rides the run as `RunInfo.contextWindow` (absent on old run.json
records), a miss or a failed fetch is one stream note — the number is
never guessed. The board (`plugins/tickets/renderer/worker-status.ts`)
defaults the denominator to `run.contextWindow ?? DEFAULT_CONTEXT_WINDOW`;
200k stays only as the documented fallback, and the new pure
`contextLabel(run)` builds the lane row text in one place. claude-code
stays on the fallback (its stream-json surface reports no window).
Specs: `main/fleet/context-window.spec.ts` (the adapter against
scripted fakes), `renderer/context-window.spec.ts` (fill, status,
label), plus a runs.spec.ts pin that a once-reported window survives
later events. **Not yet manually verified by the owner.**

### T-0044 — Fleet worktrees: home in the tickets repo and git-only cleanup (owner request, outside the list)

The workers' checkouts hid under the machine-local fleet root
(`<userRoot>/fleet/worktrees/<repo>-<ticket>`) with no supported way to
tidy up. Now they have a visible home and real-git cleanup
([ADR-0080](../docs/09_architecture_decisions/0080-fleet-worktrees-home-and-cleanup.md)):

- **Home:** `<ticketsRepo>/_worktrees/<ticket-id>/` — a sibling of
  `tickets/` at the repo root. `_`-prefixed folders at the vault root
  are reserved: file tree, markdown index and the opt-in watcher skip
  them (root depth only — `tickets/_meta` stays indexed); the repo's
  `.gitignore` covers the base (ensured by the boot sweep and the board
  initialize, one commit when appended). A repo may override its base
  with a `worktrees:` key in `_meta/repos.md` (`RepoRef.worktrees`,
  absolute or repo-root-relative). The path is computed in
  `composeRunRequest` and carried as the required
  `RunRequest.worktreePath` — the runner never derives paths, and the
  worker's brief names the absolute location.
- **Cleanup — everything through real git, never a bare rmdir:**
  - per ticket, the card menu's "Remove worktree…" runs
    `git worktree remove` (dirty → armed confirm, live run → refusal,
    a tree that no longer answers → error); the **branch stays**, the
    removal is a Log line with one commit;
  - global, "Clean up worktrees" in the panel header removes every
    worktree whose ticket has no live run (dirty ones kept and
    reported), then prunes every mapped repo — plugin-side
    (`worktree-clean.ts` over `TicketsGit`), no new runner routes;
  - the boot sweep migrates the legacy fleet root on every boot until
    it is empty (clean leftovers go automatically, dirty ones stay and
    are reported, a live run's tree waits for its settle) and lists
    orphan folders under the new base — listed, never auto-deleted.
  - Liveness is the ticket's `run:` stamp ∪ non-terminal fleet records,
    never fleet status alone (a down runner's history marks still-live
    runs `stopped`).
- **Re-run healing:** `prepareWorktree` removes a conflicting
  *registered* checkout of the same branch before `worktree add` when
  provably clean and not live (guarded by the supervisor's live set;
  never `--force`) — otherwise a settled ticket's leftover checkout
  would make every dispatch skip-and-retry forever.

Specs: `worktree-home.spec.ts` (base/naming/parse/compose), extended
`worktrees.spec.ts` (healing) and `runs.spec.ts` (request-carried path),
`worktree-clean.spec.ts` (real-git removal/cleanup/orphans),
`vault-scan-rules.spec.ts` + extended `vault-manager.spec.ts`
(reserved-root skip). FLEET.md and `specs/ticket-schema.md` document the
layout, the `worktrees:` key and the cleanup surfaces. **Not yet
manually verified by the owner.**

### req-57 — CI green on Windows runners: the shipped ticket prompts stay LF on every checkout (owner request, outside the list)

M85 added `default-prompts.spec.ts`, which byte-compares the raw shipped
prompt files against their CRLF-normalized text — the invariant that
`plugins/tickets/prompts/*.md` are LF, newline-terminated. GitHub's
Windows runners configure `core.autocrlf=true`, and the repo had no
`.gitattributes`, so the runner's fresh checkout rewrote the LF blobs as
CRLF: CI failed on `main` (two runs) while local runs — whose worktree
files were never re-checked out — stayed green. The fix is a one-rule
`.gitattributes`, `plugins/tickets/prompts/*.md text eol=lf`, which
overrides `autocrlf` at checkout; the blobs were already LF, so nothing
needed renormalizing. **Not yet manually verified by the owner.**

### T-0051 — Live run streaming, complete editor syntax colors (ticket build)

**Not yet manually verified by the owner.** The test ticket's pipeline
run surfaced two defects; both are fixed on the branch `t/T-0051`:

- **Runs stream live (OpenCode workers).** The adapter subscribes to
  `opencode serve`'s SSE `/api/event` (verified live against v2.0.32):
  reply text streams as throttled `text-delta` events sealed whole per
  part, tool calls emit `tool` events at start, call and settle, model
  steps report the context size, and `session.usage.updated` drives the
  run's own token totals. Polling stays as the fallback and owns the
  turn end; the takeover transcript (now formatted by the pure
  `watch-format.ts` view model, which `transcript.ts` delegates to)
  shows tool steps and growing replies while the turn runs. The card
  chip reads `▶ running · <turns> · <kIn>/<kOut> · <mm:ss>`, the
  summary pills add the oldest live run's age, and the takeover stats
  line carries the turn count and a clock.
- **Editor syntax colors are complete.** `dreyHighlightStyle` gains the
  three tags that fell through (`escape`, `literal`, `name`), pinned by
  a coverage-guard spec over the mandatory tag set of the common
  grammars (js/ts, json, html, css, python, markdown). A dark
  `dreyFallbackStyle` mounted before `basicSetup` replaces the light
  `defaultHighlightStyle` in the fallback slot. Fenced code in rendered
  Markdown (Live Preview table cells, HTML regions) now colors through
  the same Lezer grammars and palette via `preview-highlight.ts` and
  `applyExtendedMarkdown`'s new `fenceHighlight` option — the PDF
  export keeps plain fences (its print palette has no editor tokens).
- **The legacy Karma gate command runs again.** `npm test` is a small
  wrapper (`scripts/test.mjs`) that drops the fossil `--browsers` flag
  (loudly, on stderr) and forwards everything else verbatim to `ng
  test`: the tickets pipeline still invokes
  `npm test -- --watch=false --browsers=ChromeHeadless`, which vitest
  otherwise fails at launch demanding an uninstallable
  `@vitest/browser-*` provider. The suite itself is untouched — it
  runs headless in jsdom as it did, and the exit code is the real
  suite's.

### req-56 — Fleet workers start oriented: a ready toolchain, a clean environment, a short map (owner request, outside the list)

**Not yet manually verified by the owner.** The run audit (2026-10-19)
found every worker spending 8–28 shell calls on the toolchain alone —
probing for `.tools` / `node_modules`, making junctions of its own, even
`npm ci`, and clearing an inherited `npm_config_allow_scripts` — and
reading the whole 49 KB `CLAUDE.md` first, because `AGENTS.md` (which
OpenCode loads by itself) said "read it in full". `CLAUDE.md` is written
for pair programming (ask, pause, wait for confirmation), which an
unattended run cannot follow.

- **`link:` in `repos.md`**: the checkout's git-ignored folders a fleet
  worktree links instead of rebuilding (`linkShared` in
  `fleet/worktrees.ts`): a junction on Windows, a directory symlink
  elsewhere; only when the checkout has the folder, the worktree does
  not, and git ignores it there (asked as a folder, with the literal
  pathspecs the git seam sets lifted for that call — `check-ignore`
  refuses them). The stream opens with a `worktree links:` line; a
  recreate removes every top-level link before it deletes the old tree,
  so a recursive delete never reaches the checkout. The brief gains a
  "Toolchain" line: use the links, install nothing.
- **Clean environment**: the runner drops the `npm_*`, `INIT_CWD` and
  `ELECTRON_RUN_AS_NODE` variables it inherits at boot
  (`scrubInheritedEnv`, logged), so workers, the gate's shell and git
  start without `npm run dev`'s config — and an Electron a worker starts
  is Electron again, not Node.
- **`docs/agents/fleet-worker.md`**: a short orientation — how to behave
  without anyone to ask, the toolchain commands, where things live, how
  to find the rest, which specs a change owes. `AGENTS.md` and
  `CLAUDE.md` send fleet workers there and to `CLAUDE.md` by section.
- The board's `repos.md` needs `link: [.tools, node_modules]` under
  `drey` for this repo (owner's data; not set by this change).
- Specs: `worktrees.spec.ts` (real git: linked / present / left out, a
  non-ignored folder refused, a recreate keeps the checkout's folder),
  `ticket-board.spec.ts` (`link:` parsing and its refusals),
  `procs.spec.ts`, `fleet-fields.spec.ts` (the Toolchain line).

### req-55 — Fleet: the run brief stops duplicating the ticket; prompts keep the context small (owner request, outside the list)

**Not yet manually verified by the owner.** The run audit (2026-10-19)
measured every model call's input from the session deltas — it matches
the reported context to within 0.2 %, so the token figures are real: a
plan run is ~59 calls averaging ~111k tokens. Part of that was
duplicated: the brief quotes the ticket's description and plan in full,
and the worker's first step was reading the whole ticket file anyway
(T-0043's build: 26k chars of brief, then 25k chars of the file), followed by
the whole 49 KB `CLAUDE.md` — both carried by every later call.

- `composeInstruction` now says, before the quoted ticket, that the
  description and plan are complete there, the ticket file is not to be
  read to learn them, and an edit reads only the section it changes (the
  Log: its last lines). This holds for every run, whatever prompt the
  column uses (`fleet-fields.spec.ts`).
- The four shipped prompts (`plugins/tickets/prompts/`) gain a "keep the
  context small" rule under *How to work*: search first and read line
  ranges, read a file whole only when it is short, never re-read an
  unchanged file, search `AGENTS.md` / `CLAUDE.md` for the topic instead
  of reading them whole. The board's own copies in
  `tickets/_meta/prompts/` are the owner's (Settings → Tickets offers
  "Reset to the shipped version").

### req-54 — Foldable callouts; the takeover shows each thought whole, folded (owner request, outside the list)

**Not yet manually verified by the owner.** The worker's thinking was cut
to 600 characters when it was stored and to one 280-character line in
the takeover transcript.

- **Foldable callouts in the editor** (Obsidian's fold suffix, parsed
  since milestone 72 but never acted on): `> [!note]-` starts folded,
  `> [!note]+` open; a click on the title widget (chevron + icon, in the
  reading view also the title text) flips it. The fold is view state — a
  `calloutFolds` state field of flipped first-line positions, mapped
  through edits — and is never written to the file; the caret inside the
  body unfolds it, like every construct reveals around the selection.
  Folded body lines leave the layout (`.lp-callout-folded`). The PDF
  export and markdown-it render a folded callout open: a printed page
  cannot fold (`conceal.spec.ts`).
- **Thinking whole**: both adapters keep up to 8,000 characters of a
  thought (`THINK_MAX`), OpenCode's reasoning parts joined by blank
  lines instead of spaces. The takeover transcript renders each thought
  as `> [!QUOTE]- Thinking — <preview>`, folded, with the whole thought
  as its body (`transcript.spec.ts`).

### req-53 — Fleet: a resumed OpenCode session counts only its own run; cache reads recorded apart (owner request, outside the list)

**Not yet manually verified by the owner.** An audit of the fleet's run
history (2026-10-19) found a resumed run starting at the session's
lifetime totals: OpenCode keeps cumulative tokens per session, and the
adapter reported them as the run's own. One resumed T-0041 build showed
18.5M input tokens of which 17.9M belonged to the run before it — the
token budget (`tokensUsed`), the board's lanes and the ticket Log all
counted that twice.

- **Usage base.** On a resume the OpenCode adapter reads the session's
  totals *before* its first prompt and reports only what grows past them
  (`usageSince`). The base is reported through `onUsageBase` and kept in
  `run.json` (`usageBase`, beside the record, not in the board's
  `RunInfo`), so a re-attach or a resume in place after a runner handover
  (req-51) goes on subtracting the same base instead of restarting the
  count. An unreadable base is zero, said in the stream. A fresh session
  starts at zero as before.
- **Cache reads apart.** `cacheReadTokens` rides the usage and result
  events (OpenCode `tokens.cache.read`, Claude Code
  `cache_read_input_tokens`) and the run record. `tokensIn` keeps
  counting them (the budget is unchanged); the ticket Log says
  `6.6M in (6.2M cached) / 13k out`, the worker lane adds `cached …`, the
  takeover tab's stats the same.
- Specs: `providers.spec.ts` (resume subtracts the pre-prompt totals, a
  given base is used as is, cache reads on both adapters),
  `runs.spec.ts` (the base survives a handover; none recorded = zero;
  the Log names the cached part).

Not covered: the second-opinion worker (M85 quality rungs, flagged off)
starts a fresh session whose counts replace the first worker's in the
same run — a roadmap follow-up.

### req-52 — Test splitting: scoped day-to-day runs, full gate at release (owner request, outside the list)

The two unit suites grew past 240
spec files, and every change — even in one plugin — ran all of them. The suites
themselves stay as they are; what changed is how they are *selected*:

- **One plugin's specs:** `npm run test:plugin -- <id>` (`scripts/test-plugin.mjs`)
  runs only `plugins/<id>/**` through `vitest.plugins.config.mts`. A path
  fragment instead of an id scopes anywhere in that suite (`shared`,
  `electron/ipc`, `plugins/tags/main`); `--watch` switches to watch mode,
  any other argument passes through to vitest (`-t "name"`). An unknown scope
  fails with the list of plugin ids instead of silently running nothing.
- **Renderer suite once:** `npm run test:app` (`ng test --watch=false`;
  scope with `npm run test:app -- --include "src/…/x.spec.ts"`).
- **Typecheck in one command:** `npm run typecheck` chains the four tsc
  configs (main+shared, renderer, plugin specs, electron/shared specs).
- **Release gate:** `npm run test:all` — lint, the four typechecks, import
  cycles, `test:app`, `test:plugins`. `prepack` runs it before every
  `npm run pack`; skip with `npm run pack --ignore-scripts`. `pack:dir`
  stays the fast unpacked smoke build without a gate: npm fires no
  pre-hooks for colon-named scripts (`prepack:dir` never ran — verified
  against npm 11.19), and a full gate would defeat the "fast" in its
  docs/07 purpose; `npm run test:all` is the manual gate there.
- e2e (Playwright) stays a conscious separate step (`npm run e2e`) — it
  builds the whole app itself, which would double the gate's runtime.

Docs: CLAUDE.md toolchain section now leads with the scripts; docs/07's pack
sequence gains the gate as step 0. VS Code gained one-shot tasks
`npm: test:plugins` / `npm: test:app` beside the existing watch task.

### req-51 — Fleet workers survive a Drey rebuild (owner request, outside the list)

**Not yet manually verified by the owner.** The owner develops Drey with Drey's own fleet while running the
checkout under `npm run dev`, and every rebuild used to stop all live workers. Now
([ADR-0079](../docs/09_architecture_decisions/0079-run-takeover.md) later change):

- **Content-hash build stamp** (`plugins/tickets/main/fleet/build-stamp.ts`). The runner's `build` is
  `<builtAt>#<hash>`, a hash over `runner.js` and every module it requires from the build (18 files today), where
  the runner's stamp used to be the mtime of `runner.js`. A rebuild that leaves that code unchanged keeps the runner
  and its workers. When the code differs, only an older daemon is retired, as before (two checkouts on one fleet root).
- **Handover instead of stop.** Retiring a runner sends `POST /shutdown {handover: true}`. A run that is gating,
  starting or stopping defers the handover (409, logged once; the old runner keeps serving and the next poll asks
  again). Otherwise the old runner starts nothing new and leaves OpenCode workers running for re-attach. It stops any
  other worker, since a worker whose pipes nobody reads is unsupervised, and marks each live record `handover`. The
  new runner re-attaches, or **resumes the session in place** (same run id, record, stream and ticket stamp; a held
  run comes back held and waits for the owner). A plain `/shutdown`, Stop and Notaus still stop runs.
- **Fixed:** both per-provider supervisors adopted every run record, so the Claude Code supervisor detached an
  OpenCode run that had just been re-attached (and the history of a run sat in the wrong supervisor). Each now adopts
  only its own provider's runs.
- **Takeover tabs reopen after a restart.** The tab saves its title in the session, so the restore no longer waits
  for a fleet snapshot that hasn't arrived yet.
- Specs: `fleet/build-stamp.spec.ts` (stamp decision, require closure, an unchanged rebuild keeps the hash),
  `fleet/runs.spec.ts` "RunSupervisor handover" (stop vs. leave running, gate deferral, resume in place, held,
  no session → detached, provider filter) and `fleet-client.spec.ts` (a refused handover keeps the old runner, logged
  once). Docs: ADR-0079, `plugins/tickets/FLEET.md`, docs/05, docs/06 §6.65, the manual.
- Not covered: the real CLIs across a real rebuild. Whether an OpenCode server outlives its runner's exit on Windows
  is assumed from ADR-0079's re-attach, not re-measured.

### req-50 — the Tickets settings page reworked: a sortable pipeline, numbered folders, prompts as they are on disk (owner request, outside the list)

**Not yet manually verified by the owner.** Designed first in Claude
Design (Anthrazit); the mockup is the reference for the layout. Built on
T-0041, which is merged into this branch.

- **One sortable pipeline table** instead of a card per column: grip,
  folder number (`10` … `80`), column name with a Runs itself /
  Checkpoint chip and its folder, worker, model, pool, prompt — manual
  columns show dashes where a pool would be. Drag a row by its grip or
  press Alt+↑/↓ on a focused row; Inbox (capture) and Done (terminal)
  are pinned. A move rewrites `pipeline.md` **and renumbers the phase
  folders in one commit** (`tickets: reorder phases …`); the status line
  says what moved and offers **Undo** (the reverse move). Refused while
  a ticket in a renamed folder has a live run.
- **"Number folders"** — a banner appears while any phase folder lacks
  its number (an unprefixed repo from before T-0041, or a gap number);
  one click renames them all in one commit
  (`tickets: number phase folders`). **T-0041 rule change:** code still
  never renumbers on a move or a hand-made gap column; it renumbers only
  on the owner's explicit reorder or "Number folders".
- **Prompts are the files on disk, nothing else.** The shipped defaults
  are real files now, `plugins/tickets/prompts/{plan,build,review,commit}-default.md`
  (copied beside the built plugin by `scripts/build-plugins.mjs`;
  `commit-default` is new as a shipped prompt), read by
  `loadShippedPrompts()` for "Initialize board" and for **Reset to the
  shipped version**. The page lists only `tickets/_meta/prompts/*.md`
  (no rows for prompts the folder lacks, no "Edited" badge from comparing
  with code), shows the folder's path with an open-folder button, and
  follows the board's change events, so an outside edit shows up
  (silently when nothing is unsaved, as a "changed outside Drey" notice
  otherwise). An empty folder offers **Add Drey's prompts**.
- **The prompt editor is the host's Markdown editor**
  (`ui.createMarkdownView`, Live Preview) in a list/detail layout; it
  saves when the editor is left or on Save, one commit per save.
  Ctrl+S is not offered: the app's keybinding layer takes it at window
  capture before a plugin page sees it.
- Main: `reorderPhases`, `numberFolders`, `folders`, `promptRestore`,
  `openFolder` handlers; pure `reorderPipelinePhases` (ticket-board.ts),
  `planFolderNumbering` / `applyFolderNumbering` (phase-dirs.ts, swaps
  through temporary names, refuses before touching anything when two
  files of one name would meet), `TicketsGit.commitTree` (`add -A` for
  the renames). The renderer is split into `settings-page.ts`,
  `settings-columns.ts`, `settings-prompts.ts`, `settings-model-picker.ts`,
  `settings-order.ts` (pure) and `settings.css` (`tset-` prefix); the
  duplicated req-46 block in `board.css` (which also overrode board
  rules) is gone.
- Specs: `default-prompts.spec.ts`, `settings-order.spec.ts`, reorder
  rules in `ticket-board.spec.ts`, planner / executor / real-git commit
  in `phase-dirs.spec.ts`. Driven in the built app against a scratch
  clone of the tickets repo: Number folders, keyboard and drag reorder,
  Undo, prompt save, reset, outside edit — each one clean commit.
- Not changed: the board itself, the SDK. Known gap found on the way: a
  `pipeline.md` with CRLF line endings does not parse (a fresh clone with
  `core.autocrlf=true`) — a follow-up.

### Fix — fleet: worktree matching survives path aliases (`RUNNER~1`, junctions)

Follow-up on the T-0047 fix below, caught by CI on the GitHub Windows
runner: `git worktree list --porcelain` reports the canonical path git
resolves through the filesystem, while the requested path can reach the
same directory through an alias — the runner's 8.3 temp dir
(`C:\Users\RUNNER~1\…` for `runneradmin`) being the live case. The
string-form comparison missed the listing entry, so healthy worktrees
fell into the stale rows: a locked tree was renamed aside, a clean one
recreated over its still-live registration ("missing but already
registered worktree"). Listing entries now get a `realpath` second
chance (`findWorktreeEntry` in `worktrees.ts`); a path that cannot be
resolved (a registered but vanished tree) still matches by string form
only. Spec: a junction reproduces the alias shape on any Windows
checkout (`worktrees.spec.ts`).

### Takeover steering and colour (owner request, outside the list)

**Not yet manually verified by the owner.**

- **Claude Code workers can be taken over**: hold (a finished turn no longer
  closes stdin), soft interrupt (stream-json `control_request`, unverified
  against the real CLI), turn state busy/idle, release ends a standing worker.
  A finished turn now closes stdin, so the process exits.
- **Composer in the takeover tab**: status hint (working / waiting for you /
  runner driving / ended), quick prompts (Continue, Status, Run checks, Wrap
  up), Send and Interrupt-and-send buttons.
- **Colour**: the tab banner, prompt box and controls take the run's state
  tone; lanes are tinted by light; stronger pills.
- **Resume an ended run's session** ("Resume session" in the tab): a new run
  picks the provider session up held — it answers one line and waits for the
  tab's prompts; no ticket stamp, gate or move (the ticket may have moved on).
  Not covered by a spec yet.
- **Composer slimmed**: no hint text, short placeholder, a red **Stop** button
  while a turn runs (replaces the banner's Interrupt), and a progress line
  ("Thinking… 12s · ↓ tokens", or the current tool call) above the box.
- **Slash commands and attachments in the takeover prompt**: typing `/`
  lists the commands the worker reports (Claude Code: the CLI's init list;
  OpenCode: `compact` plus the project's `GET /api/command`); a command
  goes through as typed — for OpenCode as the real `/compact` / `/command`
  call, not as text. The "+" button, drag-and-drop and paste (screenshots)
  attach files: stored in the run's worktree under `.drey-attachments/`
  (git-excluded, 10 MB each, `POST /attach`) and named in the message.
  Attached files are not yet checked against a real worker.
- Specs: three claude-code adapter cases in `providers.spec.ts`.

### req-49 — past worker logs on the board; the board follows the runner (owner request, outside the list)

**Not yet manually verified by the owner.**

- A card's context menu lists the ticket's earlier runs (finished, stopped, failed, detached; newest first, eight at most) as "Past run — column · state · time"; each opens its read-only transcript in the takeover tab. The runs and their `stream.jsonl` were already kept on disk — only the menu offered the live run alone. With no fleet daemon alive (it retires when idle) the client now reads the history straight from `runs/<id>/run.json` and `stream.jsonl` (`fleet-client.ts`, `readHistory`), so past logs are listed and readable then too.
- The board now pulls when the fleet snapshot's runs or run states change (`plugins/tickets/renderer/index.ts`, `applyFleetSnapshot`): the runner moves tickets with git commits that raise no vault event, so a run starting or ending left the columns stale until the manual refresh.

### req-48 — theme contrast repair and formatted, coloured assistant answers (owner request, outside the list)

**Not yet manually verified by the owner.**

- Contrast: `--accent` as text measured 3.5–4.0:1 on Anthrazit docks and fields; a new `--accent-fg` token (accent lifted toward the heading colour, ≥4.5:1 on dock, editor and field surfaces) now carries every accent-coloured text/link. Code comments use `--text-4` instead of `--text-faint` (3.7:1). The tickets board used an undefined `--text-secondary` (now `--text-3`), 9px chips, and 0.55–0.72 opacity stacked on dim text — raised.
- Assistant answers render fenced code (language label, copy button, `diff` per line), headings, quotes, rules and tables (`plugins/assistant/renderer/{rich-blocks,rich-text}.ts`). The code is coloured by the host: new SDK 1.31 `ui.highlightCode(code, lang)` (`src/app/plugin-host/code-highlight.ts`, ADR-0078 later change) -- `language-data` grammar loaded on demand, Lezer parse, the theme's `HighlightStyle`. Specs: `rich-blocks.spec.ts`, `code-highlight.spec.ts`.
- Active states use the highlight colour again (ticket card hover, open panel icons, active Settings category, active file); the card of the ticket open in the editor is outlined; the editor selection selector matches CodeMirror's focused chain.

### req-47 — the takeover transcript reads like Claude Code (owner request, outside the list)

**Not yet manually verified by the owner.**

- Tool calls are `● Tool target` steps (a run stays together), thinking is
  a one-line `∴ Thinking —` quote cut at 280 characters, run setup folds
  into one muted line, the owner's prompts are `›` quotes, and the turn's
  end is a rule plus `✓ Turn finished` (the result body is dropped when the
  last reply already said it). Specs: `transcript.spec.ts`.
- **Claude Code workers now fill the transcript.** The `claude-code`
  adapter only emitted usage events, so its takeover tab stayed empty; it
  now writes thinking, replies and every tool call like the opencode
  adapter, and each tool's outcome hangs under its call as a `⎿` line
  (first line of the result, `failed:` on an error). Spec:
  `providers.spec.ts`, `transcript.spec.ts`.
- **Seeded prompts share a "How to work" block** (batched reads, dedicated
  tools, smallest change, verify before claiming, short factual
  hand-off). Only new boards seed it; edited vault prompts are untouched.

### req-46 — the Tickets settings page: column cards, a model picker and editable prompts (owner request, outside the list)

**Not yet manually verified by the owner.**

- **Column cards.** The pipeline columns were one cramped row each (the column
  name cut to "I…", the model pin a 110px field). Each column is now a card:
  full title, a "Runs itself / Your checkpoint" badge, worker and pool size
  on one line, model and prompt full width. A manual column's pool, model and
  prompt are disabled, not hidden.
- **Model picker.** A combobox over what the worker CLI offers: `opencode
  models` (new `worker-models.ts`, cached for a minute, `providerID/modelID`
  lines grouped by provider) or the Claude Code aliases; type to filter,
  arrows/Enter/Escape, free text stays possible when the list is empty or
  stale. Saved when a row is chosen or the field is left.
- **Prompt editing.** The prompt is a select over `tickets/_meta/prompts/`
  with an Edit shortcut, and a new **Prompts** section holds one editor per
  file: saved on leaving the field or Ctrl+S, one commit per save
  (`tickets: prompt <ref> edit|add|reset`), Revert, Reset to default for the
  three seeded prompts (two-click confirm, no native dialog), New prompt.
  Main gained `prompts`, `promptSave` and `models` handlers.
- Specs: `worker-models.spec.ts`; manual updated. Not changed: ADRs, schema.

### Milestone 87 — stale runner daemons retire; the board seeds its prompts (owner request, outside the list)

**Not yet manually verified by the owner.**

- **A daemon without a build stamp is stale.** `isStaleDaemon`
  (`fleet-client.ts`): a runner whose descriptor carries no `build` predates
  the stamp, so the client retires and respawns it. Before, it was trusted
  forever and kept running pre-fix dispatch (pulling from `prioritized`,
  refusing plan tickets for missing acceptance criteria).
- **Setup defaults.** "Initialize board" writes the plan column as
  `agent plan-default` (build was already `agent build-default`) and seeds
  `tickets/_meta/prompts/{plan,build,review}-default.md`
  (`main/default-prompts.ts`, same texts as the owner's repo). A column's
  prompt is passed with the ticket as before (`composeInstruction`).
- **Clear in the chain-log tab.** A "Clear" button hides every line logged
  up to now; only newer lines show (session-only; the daemon's ring buffer and
  `runner.log` stay untouched). Pure filter in `renderer/chain-log.ts`.
- Specs: `fleet-client.spec.ts`, `default-prompts.spec.ts`, `chain-log.spec.ts`.

### Milestone 86 — worker lanes on the tickets board (owner request, outside the list)

Part of ticket T-0007's review round. **Not yet manually verified by
the owner** — typecheck, lint and the plugin suite are green; the board
was not yet looked at in the running app.

- **Worker lanes replace the run footer.** Every working column shows a
  "Workers" strip under its head: one lane per live run of its pool,
  folded to a single line (traffic light, state in words, ticket, a
  small context bar) and unfolded to the worker's current activity, its
  context window against 200k, in/out tokens, cost, age and the
  Watch / Steer / Stop buttons. A lane that needs a look (amber, red)
  opens by itself until the owner folds it; the choice is per run and
  lives in memory only.
- **The board look follows the redesign:** wider columns (264 px, 320 px with a worker pool), count pills, 8 px cards and a dashed pool tag, a 40 px rail for folded columns, and a pill row above the board (working / need attention / stalled / tokens in flight).
- **The light** (`renderer/worker-status.ts`, pure + spec): red = a
  running worker silent for 5 minutes ("Stalled Nm"), amber = context at
  80 % or more, or stopping; green otherwise. It always carries a word.
- **Data.** `RunInfo` gained optional `activity`, `contextTokens` and
  `column`; both adapters report them (claude-code from each assistant
  event's usage + tool use, opencode from the last assistant message's
  tokens + text). The context window itself is not known to the runner —
  the board assumes 200k.
- **Fix: a no-op bookkeeping commit no longer logs as a failure.** Git prints "nothing to commit" on stdout, which execFile's error message omits, so `commitPaths` rethrew it and the runner log showed "clearing the ticket's run stamp failed"; stdout is now folded into the message and "no changes added to commit" is recognised too (`tickets-git.spec.ts`).
- **Fix: the run brief names the ticket file.** A plan-phase worker burned most of a run (10 model calls, ~290k input tokens counting cache reads, one line of output) recursively searching the disk for `T-0047.md`, which lives in the tickets repo, outside the worktree it was told was its only writable place. `composeInstruction` now carries the absolute ticket-file path and says it is editable and must not be searched for (`fleet-fields.spec.ts`).
- **Fix: a run the daemon dispatches on its own now shows up.** The client polled the runner only while it already knew of a live run, so a run started by the chain (not by this client) appeared only after a manual refresh and the column looked idle while the worker ran. The poll never ran when the daemon was down at the first request (a build change retires it, the restart brings it back), so it is now always on for the plugin's lifetime (2.5 s, pushes only on change).
- **Tool calls are visible.** The opencode adapter turns every tool call into a lane line (`read src/a.ts`, `shell git status`) and counts it as activity, so a worker that only calls tools neither looks silent nor stalls (`toolActivity`, `providers.spec.ts`).
- **The chain log runs in the host's Markdown editor** (SDK 1.30, [ADR-0078](../docs/09_architecture_decisions/0078-markdown-view-for-plugins.md)): new `ui.createMarkdownView` hands a plugin the existing `MarkdownSurface` as an element (read-only viewer or compact prompt box, tail-following, no document behind it). The log tab replaced its `<pre>` with it, one paragraph per log line, no fence, so the text marks and copies normally (`asParagraphs`). Specs: `markdown-view.spec.ts`, `chain-log.spec.ts`.
- **Fix: a stop no longer waits forever for the opencode interrupt.** `stop()` awaited the server's answer to the soft interrupt without a bound, so when it never came the runner's 10 s shutdown race exited first, the tree-kill never ran and the worker lived on unsupervised (it finished its plan 16 minutes later while its run sat `detached`). The wait is now 3 s (`INTERRUPT_WAIT_MS`), then the tree-kill runs (`providers.spec.ts`). The chain log also says when a detached run blocks a ticket.
- **The takeover tab** ([ADR-0079](../docs/09_architecture_decisions/0079-run-takeover.md)). A lane's "Take over" holds the run (the runner no longer ends it after a finished turn, `held` on `RunInfo`) and opens a tab: the worker's transcript in the host's read-only Markdown view (rendered from the normalized stream, owner prompts included), a compact prompt box, Interrupt (soft stop, session kept) and Hand back (an idle worker ends the run, the gate decides). New runner routes `/takeover`, `/interrupt`, `/release`, plugin IPC `fleetControl`, adapter handle `setHold` / `interrupt` (OpenCode only). Specs: `runs.spec.ts`, `providers.spec.ts`, `transcript.spec.ts`.
- **The ticket Log records a run's tokens** (`usageSummary`: `run done — 331k in / 2k out`, cost only when the provider reports one — the GLM coding plan reports 0).
- **Fix: the lease reaper no longer kills healthy workers.** The runner's process probe joined `tasklist /FI "PID eq 42"` into one shell string, which tasklist rejects ("Argument/Option ungültig"), so `processAlive` answered false for every live worker and the reaper failed the run ("lease lost — the worker process is gone") about a minute in — the cause of the red plan/build gates on T-0047 and T-0003. The probes now use `execFile` with separate arguments (`probeExec`, `runs.spec.ts`).
- **Fix: the takeover transcript was nearly empty.** The opencode adapter read a message on first sight (while it still streamed) and listed a tool call with its still-empty input, so the tab showed bare `shell` / `read` lines and lost most replies. A message is now read once complete (its text and its thinking, the latter as an italic quote) and a tool call is shown once its input is there (`providers.spec.ts`, `transcript.spec.ts`).
- **Fix: the log and transcript no longer lose your selection.** `createMarkdownView.setContent` replaced the whole document on every 2 s refresh and so reset the caret and any selection. It now edits only what differs (common head and tail stay, the selection maps through; an unchanged text dispatches nothing) — `MarkdownSurface.patchContent`, spec in `markdown-view.spec.ts`.
- **A detached run can be seen and stopped.** A run whose worker outlived a runner restart blocked its ticket with no way out (`stop` refused it, the board did not show it). Its column now shows a "Detached" lane with a Stop button, and `stop` ends a detached record (killing the recorded process if it still lives). Boot also no longer re-detaches an already detached run on every start (that re-stamped its ticket each time), and a stamp clear on a ticket that moved on is silent (ENOENT). Specs: `runs.spec.ts`, `worker-status.spec.ts`.
- **Fix: a stop kills the worker before it touches the ticket.** `stop()` wrote the Log line (a ticket write plus a git commit) before the kill; a runner shutdown that stopped waiting on it after 10 s exited with the worker still alive — the orphans (the log shows "stopping 1 live run" and never "→ stopped"). The kill now comes first and the Log line (`stopped by the owner — …`) is written with the run's end (`runs.spec.ts`).
- **A runner restart no longer orphans an OpenCode worker: it is re-attached** ([ADR-0079](../docs/09_architecture_decisions/0079-run-takeover.md), "Re-attach"). The spawn records `attach.json` (server address, per-boot credential, process + creation time) in the run's folder — never in `run.json` — and boot's `adopt()` binds a new handle to the still-running server (`ProviderAdapter.attach`): polling, steer, interrupt, stop and hold work again, already-streamed messages are not repeated, a held run stays held, a worker that finished meanwhile ends the run through the gate. An already detached run with a live process is taken back too. Claude Code workers still detach. Specs: `runs.spec.ts`, `providers.spec.ts`.
- **Fix: a refused action refreshes the board.** Stopping a run that had already ended answered "already ended" but left its lane on screen (the failure path never re-read the runs), so every click repeated the refusal; `runMutation` now re-pulls the board on a failure too.
- **One button; the first command takes over; running or standing** (owner request, amends ADR-0079). A lane's single
  "Open" button opens the run's tab without holding it; the runner keeps driving until the owner's first prompt or
  interrupt, which hold the run implicitly. A detached run with a session offers "Resume" (lane and tab): a fresh worker
  resumes the session and the run is attached again (`POST /resume`). `RunInfo.turn` shows whether the worker runs
  or stands — breathing green "Running" vs hollow gray "Standing" in lanes, the pill row and the tab. The Watch and
  Steer modals are gone (the tab replaces them). Specs: `runs.spec.ts` (implicit hold, resume), `worker-status.spec.ts`.
- Specs: `worker-status.spec.ts`.

### Milestone 85 — the chain runs itself: continuous orchestration

Ticket [T-0007](https://github.com/HenrikPuls/Drey) in the owner's
tickets repo (M85 folded in by owner request); the design is
[ADR-0077](../docs/09_architecture_decisions/0077-continuous-orchestration.md),
which amends ADR-0075 and M84's gate rule. **Not yet manually verified
by the owner** — the suites are green; the owner's live round (the
verification steps in the ticket) is next.

- **The board becomes a running pipeline.** A column with a worker
  drains itself: the dispatcher (in the fleet runner, which survives
  Drey restarting) serves the column's own queue and moves each ticket
  one column right when its step is done. The machine never pulls from
  a manual column — `prioritized` is the owner's queue, and he moves
  tickets into the worker columns himself. The worker-per-column is the
  auto/manual switch, configured
  in the new Settings → Tickets page (one commit per change on
  `pipeline.md`: `worker:` / `model:` / `workers:` / `prompt:`, plus
  `max-red:` / `token-budget:` / `ci:` / `audit:` / `semantic:`). The
  owner's live tickets repo now carries the proposed defaults (plan 2 ×
  OpenCode/GLM-5.3, build 4 × OpenCode/GLM-5.3-Flash, review 1) and the
  `_meta/prompts/` (plan/build/review-default — build-default had been
  referenced since M84 and was still missing).
- **Completion is the agent's call, the gate the safety net.** Every
  run brief ends with the completion discipline (run the acceptance
  commands yourself; your finished turn is the declaration). The runner
  re-runs the gate: agent-done AND green moves one column right — a
  pulled ticket jumps from its feeding column straight to the working
  column's successor (prioritized → plan-review) — a red gate parks the
  ticket (logged, slot freed).
- **Master control and brakes.** An / Aus / Notaus in the panel header;
  per-column pause / stop / play next to the fold chevron; stopping one
  column never stops the rest. State persists in
  `<userData>/fleet/chain.json` and resumes with the runner; a running
  chain keeps the runner alive, so the board drains while Drey is
  closed.
- **Safety nets.** The lease reaper fails a run whose worker process is
  provably dead and frees its ticket (a silent-but-alive worker is
  never touched — ADR-0014). The circuit breaker counts consecutive red
  gates per column (`max-red:`, default 3): tripping holds the column
  and parks its next candidate in Inbox with `parked-reason` — the one
  machine-sanctioned backward move. A red gate cools the column down
  for a minute; daily `token-budget:` trips the same way.
- **The ci handover works.** A `ci:` command runs in the ticket's work
  repo; green moves the ticket one column right (one commit, `… (ci)`),
  red backs it off for ten minutes.
- **Quality rungs, flagged off.** `audit:` (a fraction) samples green
  steps and `semantic: true` gates every green step — a fresh second
  worker reviews the branch before the move, one round, its own gate
  decides. The live trial decides whether they stay.
- **Cycle-time metrics.** Each card carries its column dwell (from the
  `entered-*` stamps); a line above the run footer shows every column's
  average (`⌀`).
- **The fleet on the MCP server.** SDK 1.29 adds the typed plugin-tool
  seam (`ctx.mcp.registerTools`): a plugin's tools appear beside the
  vault tools on Drey's own MCP server. The tickets plugin registers
  `fleet_status` / `fleet_run` / `fleet_stop` / `fleet_steer` /
  `fleet_watch` — the assistant and any connected program drive runs
  conversationally.
- **One request builder.** `composeRunRequest` builds every RunRequest
  (owner-started and dispatched alike); the assignment ring gained the
  column level (ticket pin > column > handover `@worker` > repo >
  configured default), and model pins now reach OpenCode (v2
  `providerID/modelID`) as well as Claude Code (`--model`).

Suites and checks: the plugins suite grew to 132 files / 1676 tests
(orchestrator, chain planning, request builder, ci sweeps, breaker,
pipeline patcher, MCP seam, fleet tools); `tsc` (main, specs, renderer,
plugins), ESLint, the cycle check and the plugin build are green.
Docs: ADR-0077, docs/05 §5.41, docs/06 §6.66, the manual's fleet
section, `specs/ticket-schema.md` (pool keys, lane rules, ci).
### Tickets — numbered phase folders, file moves as transitions, archive, auto-push (T-0041)

Owner rulings from the 2026-10-18 rounds (ADR-0076 later change,
`specs/ticket-schema.md` updated in the same change):

- **Numbered phase folders** (`10-inbox` … `80-done`, `NN` = pipeline
  position × 10): one strip point for every reader
  (`ticketPathParts` → prefix-stripped ids — board grouping, validator
  and `entered-` noise checks see clean ids), one derive-and-reuse
  resolver for every writer (new `plugins/tickets/main/phase-dirs.ts`;
  an existing `35-qa` or unprefixed `inbox` wins over the derived name,
  so inserting a column takes a gap number and nothing ever renames).
  No ticket-file changes: `entered-*` keys, order.md sections and
  branch names keep the clean ids.
- **A file move is a ticket move:** stateless drift detection (new
  `plugins/tickets/main/normalize.ts`, pure) runs on every `board`
  IPC fetch — a ticket in phase B whose `entered-<B>` stamp is missing
  or older than the newest event gets the full board-move treatment
  (stamp, Log line, pin cleanup, one commit, actor `owner@<host>`);
  works after restarts, skips live-`run:` tickets, logs backwards and
  skipping moves without blocking (lane rules stay runner-only).
  `BoardService.refresh()` (normalize + snapshot) is the board route;
  `snapshot()` itself stays pure so enqueued mutations never deadlock.
- **Archive instead of delete:** reserved `tickets/archive/` beside
  `_meta` — never a column, invisible, no counter. Card menu gains a
  two-step armed **Archive…** item; a file moved into the folder gets
  the same treatment via normalization: Log marker `— archived` (no
  `entered-` stamp — idempotent, and revive → re-archive stays
  detectable), one commit `tickets: <id> archived`, pin cleanup,
  claim fields ride along. Reviving is a move back into a phase;
  deletion inside `archive/` stays the owner's manual act.
- **Auto-push:** optional `push:` remote in pipeline.md (a git-config
  remote name; non-strings degrade to noise). Every transition commit
  — board move, normalization move, archive, runner success move —
  pushes `git push <remote> HEAD` (`TicketsGit.push`); failures warn,
  never block. `RunRequest` grew additively (`nextPhaseDir`,
  `pushRemote`).

Specs: numbered-dir folding and `push:` parsing
(`ticket-files.spec.ts`, `ticket-board.spec.ts`, `tickets.spec.ts`),
resolver (`phase-dirs.spec.ts`), every predicate row of the drift pass
(`normalize.spec.ts`), numbered target dir + prefix-aware validation +
push/no-push over the git seam (`runs.spec.ts`, `tickets-git.spec.ts`).
**Not yet manually verified by the owner.**

### Fix — fleet: worktree preparation is idempotent per ticket (T-0047)

Split from T-0046. The runner's `prepareWorktree` always ran
`git worktree add`, so a second run for the same ticket (the next
phase, a gate retry) failed with "already exists". Preparation is now
a state machine (`plugins/tickets/main/fleet/worktrees.ts`) over
`git worktree list --porcelain`:

- registered and on `t/<id>` — **reused** as is, clean or dirty (a
  retry wants exactly the half-finished work; untracked counts as
  dirty);
- unregistered, directory missing or empty — **created** (`worktree
  prune`, then add — `-b` only when the branch does not exist yet);
- stale (content at the path, no healthy registration) and clean —
  **recreated**; stale and dirty — **moved-aside** to
  `<path>.stale-<stamp>`, never deleted (a directory that no longer
  answers to git counts as dirty);
- wrong branch, locked, or a rebase/merge in progress — a descriptive
  error, nothing modified.

The outcome (`reused | created | recreated | moved-aside`) rides
`RunInfo.worktree` (absent on adopted pre-T-0047 records), the run
stream's opening note and the ticket Log's start action; a moved-aside
worktree adds a stream note with the parking path. `recreated` /
`moved-aside` also set `sessionInvalidated` on the prepared result —
exposed for T-0049's resume work, read by nothing in v1. Preparation
is serialized by a module-level lock keyed by the repo, so two
concurrent starts — one ticket, or two tickets in one repo at
`workers: 2/4` — cannot race on `worktree add`. Spec: real git in
temp repos over every state, the fail rows and the lock
(`worktrees.spec.ts`). **Not yet manually verified by the owner.**

### Architecture cleanup A6 — plugin settings out of the base config

Roadmap item A6 (the 2026-10-13 review, finding 4 in
[`docs/11`](../docs/11_risks_and_technical_debt.md)); decided in the
[ADR-0010](../docs/09_architecture_decisions/0010-app-settings-storage.md)
later change of 2026-10-18. The rule from now on: **a plugin's settings
live in the plugin's own config** (`ctx.config` / `api.settings`). The
actions slice — prompt templates, triggers and the built-in prompt
texts — moved from `app-config.json` into the assistant plugin's own
config:

- **Ownership.** The action engine reads `ctx.config.get('actions')`,
  the Actions settings page edits `api.settings` — adding an action
  feature no longer touches a base file. The slice normalizes through
  the new shared `normalizeActionsConfig` (built-ins re-inject, the
  retired built-in stays retired, legacy prompts refresh — all as
  before).
- **Migration.** A one-time step before plugin activation copies a
  stored `app-config.json` `actions` key into the plugin config
  (idempotent: the plugin copy wins once it exists; a missing key is a
  fresh default). The stale key stays in the base file as documented
  dead data.
- **The base seams stayed narrow.** The editor's "Suggest tags" autotag
  reads the assistant config through the plugin host; the confirmation
  dialog's "don't ask again" flips a trigger through the new
  `config:set-trigger-confirm` handler instead of the whole-config
  write; the tags plugin's Summarise takes its prompt from the new
  `ctx.llm.actionPrompt(builtin)` read seam (SDK 1.28).
- **Still app config, deliberately:** the `templates` slice (its `dir`
  is vault layout shared by four consumers) and the `entry` slice
  (all base).

### Milestone 84 — the fleet runner: on-demand agent runs with run control

Item M84 of the ticket system + agent fleet (ADR-0075; the format is
ADR-0076). The workers are external agent CLI sessions in their own
worktrees — **OpenCode first** (driven through its local serve API),
**Claude Code second** (stream-json) — and the owner assigns workers
per task: the ticket's `worker:` pin wins over the phase handover's
`@worker` pin, over the repo default in `_meta/repos.md`, over the
configured default, then the fleet's first worker. **Not yet manually
verified by the owner** — the specs and suites are green; the live
rounds on the real tickets repo are the owner's next step.

- **The fleet runner** is a standalone headless Node process, spawned
  detached by the tickets plugin (`ELECTRON_RUN_AS_NODE`, the sibling
  file of its own bundle), rooted under `<userData>/fleet/` — single
  instance through a descriptor file, idle self-shutdown, and it
  survives Drey closing and restarting. Its control surface is a
  loopback HTTP endpoint with a bearer token
  (`start/stop/send/status/stream` — a terminal with curl reaches it
  too, as the owner asked). It owns what Drey cannot: the worker
  process table, the per-run stream files (`stream.jsonl`, tail-able
  by anyone), the tree-kills with a PID-reuse guard (the recorded
  `started-at`), the per-ticket worktrees on `t/<id>`, and the
  **machine gate** — the ticket's backticked acceptance commands, run
  locally after the worker exits; a green gate moves the ticket to the
  next phase with the board's exact transition semantics (move + stamp
  + log + one commit), a red one parks the failure in the ticket's Log
  and frees the run slot.
- **Two worker adapters behind one steer ladder.** OpenCode drives
  `serve` bound to loopback — pinned live against v2.0.32: the server
  prints its BASIC credential (`server password …` on stdout), a prompt
  POST into the live session is the native injection rung (delivery
  `steer`), `interrupt` is the soft stop, and the session object
  carries the token usage and cost for the footer; progress is polled,
  not streamed, and the message list's `idle` marker ends the turn
  (v1's event stream dropped mid-turn, v2's offset stream is the
  upgrade path). Claude Code drives the CLI over
  stream-json: stdin held open for injection, `--resume <sessionRef>`
  as the stop+resume rung. Every steer and stop lands in the ticket's
  Log with its rung.
- **Run control in the board.** The card menu gains *Run agent* (a
  dialog: worker + permission mode), *Watch run* (tailing the stream),
  *Steer run* and *Stop run*; the board's new footer shows every live
  run with state, age, token usage, cost and steer count — the owner's
  request of 2026-10-17. While a run is live the ticket carries the
  `run` map (at most one), and the dialog's explicit worker choice is
  recorded as the ticket's `worker:` pin.

Verified by: the plugin typechecks (main, renderer, specs), lint,
import cycles, the full unit suites (Node 1,618 — 34 new, among them
the provider adapters against scripted seams, the supervisor's gate
and success-move semantics, the config store's race contract), and the
complete production build incl. the plugin bundle.

Docs: `specs/ticket-schema.md` (the `worker` field, the `run` map's
semantics, the handover `@worker` pin, `repos.md` `worker:`, the
prompts directory), the roadmap's M85 remainder, `docs/05` §5.41 and
`docs/06` §6.65, the manual's fleet section.

### Milestone 83 — the tickets foundation: a kanban board over a dedicated tickets repository

An owner request, outside the list (2026-10-17), with the architecture
settled in a plan review the same day: [ADR-0075](../docs/09_architecture_decisions/0075-agent-fleet-architecture-governance-and-run-control.md)
(the agent fleet to come — milestones 84/85) and
[ADR-0076](../docs/09_architecture_decisions/0076-ticket-repository-format-and-coordination.md)
(the format shipped here). Owner-verified 2026-10-17 (signed off after
the first live board rounds T-0001 – T-0006).

Tickets live in **their own git repository** (GitHub in practice,
Azure DevOps first-class — the system speaks plain git only),
registered as an ordinary vault. One Markdown file per ticket
(`tickets/<phase>/T-00xx.md`, id = filename = immutable identity), the
phase is the directory, and a transition is a move plus **exactly one
commit** (`add -- paths` + `commit -- paths`, never touching unrelated
staged work) — the repo's history is the ticket's timeline. The board
stores nothing: columns, order, claims and ages are derived from the
files on every refresh.

The new `tickets` plugin: the **Tickets** dock panel (columns with WIP
counts, cards with priority dots, repo/claim/parked chips and issue
badges), capture through a small modal (title, priority, repo,
description → next free id in the inbox), drag & drop for transitions
and for order pins (a drag writes `tickets/_meta/order.md`, not the
tickets — sparse sections, union-merge-safe), a card context menu
(open, copy the deterministic branch `t/T-00xx`, take over / release a
claim), and a two-step **Initialize the tickets board** in the empty
state (writes `pipeline.md`, `order.md`, `repos.md`). The pipeline is
configuration in the repo: ordered phases with title, WIP limit, claim
flag and per-handover spec (`manual | agent <prompt-ref> | ci | none`)
— parsed and displayed now, acted on from milestone 84.

Asymmetric tolerance throughout: machine writes are strict
(`specs/ticket-schema.md`), human edits are free, and the reader
normalizes visibly — anything ambiguous becomes a badge on the card
(duplicate ids across phases, a branch field violating the `t/<id>`
rule, an unknown repo), never a guess. **No CI on the tickets repo**
(owner's ruling): the deterministic validator runs where the data is
read — the board on every render, the fleet runner before every action
from M84. A tickets vault without a git repo works, with a warning that
transitions are unversioned.

Verified by: the plugin typechecks (main, renderer, specs), lint,
import cycles, the full unit suites (Node 1,584 — 44 new in
`plugins/tickets/` — and Angular 1,131), and the complete production
build incl. the plugin bundle (`dist-electron/plugins/tickets/`).

Docs: ADR-0075, ADR-0076, `specs/ticket-schema.md` (the complete
machine-facing format spec) + the `frontmatter-schema.md` pointer,
`docs/05` §5.0 (plugins paragraph, diagram, feature row) + §5.41,
`docs/06` §6.64, the manual's new chapter 13 (chapters 13–22 shifted
to 14–23), the roadmap's M84/M85 remainder. Known edge, accepted for
the trial: a ticket file that sits open and dirty in the editor while
the board moves it gets the ordinary "changed on disk" treatment; and
pushing the tickets repo stays manual (Source control panel) until the
fleet runner owns it (M84).

**First board use (2026-10-17, tickets T-0001–T-0004 in the owner's
`drey-tickets` repo):** capture, initialize and drag-pins worked
end-to-end on the owner's machine. Three follow-ups shipped from those
tickets: the board opens as a **centre editor tab** (`tickets://board`
doc kind, the browser-tab pattern — one shared board store serves the
dock panel and the tab; wider columns in the tab), **creating a
ticket opens the pre-filled file** in the editor (`create` returns the
minted id and path), and the card context menu **opens the ticket's
work folder in a terminal** (`repos.md` gains a per-repo local `path:`;
the spawn mirrors the base's `openTerminalIn` — Windows Terminal with
a cmd fallback, detached, outliving the app). On the ticket branches
`t/T-0002` / `t/T-0001` / `t/T-0004`, fast-forwarded onto the
integration branch.

**Second board round (2026-10-17, tickets T-0005/T-0006):** the board's
columns **fold to a narrow strip** (T-0005) — the count and the title
rotated 90°, the head chevron folds, one click on the strip (or a
dragged card hovering it) unfolds, and which columns stay folded
persists as view state in `localStorage['drey.tickets']` (the
tasks-panel pattern; never in the tickets repo — ADR-0076). Folding
`done` and empty phases is how all eight columns fit the dock panel.
The T-0002 centre editor tab was **removed again** (T-0006, the owner's
ruling — the dock panel is the board's home; the shared-store refactor
from T-0002 stays, serving the panel).

**Board UI polish (2026-10-17, owner request, outside the list):**
cards carry a priority edge (urgent/high) and a pin icon instead of the
word "pinned", are keyboard-reachable (Tab, Enter opens); the dragged
card dims and the target column highlights; empty columns read "No
tickets" in a dashed drop zone; the count is a pill; the fold chevron
dims until hover/focus; the card menu has a separator and focuses its
first item; the New-ticket dialog has a heading and visible field
labels. A pinned ticket can be **unpinned** (click the pin icon, or the
card menu's "Unpin from order"): the new `unpin` IPC removes its id from
`order.md` and commits, so it falls back to the derived order. **Not yet
manually verified by the owner.**

### req-44 — CI runs on the Node 24 actions runtime

Owner request, outside the list (2026-10-17): the run annotations warned
that `actions/checkout@v4`, `setup-node@v4` and `cache@v4` (and with them
`upload-artifact@v4` and `action-gh-release@v2`) still target the
deprecated Node 20 action runtime. **Manually verified by the owner
(2026-10-17).**

- `.github/workflows/ci.yml`: the actions move to the current majors —
  `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`,
  `actions/upload-artifact@v7`, `softprops/action-gh-release@v3`; every
  one of them runs on Node 24. No input the workflow uses changed, and
  the job itself already built with Node 24 (`node-version: 24` stays).
- `package.json` declares `"engines": { "node": ">=24" }` — advisory
  (no `engine-strict`), matching the vendored `.tools/node` (24.20.0)
  and the CI job. The runtime is Node 24 for tooling, tests and CI;
  the packaged app keeps Electron's bundled Node as before.
- `@types/node` stays at `^26` (unchanged since the scaffolding): the
  types run ahead of the LTS runtime, and every typecheck is green
  against it.

### Fix — CI: the drawio palette e2e no longer types into a half-open palette (bug-12)

Owner request, outside the list (2026-10-17): the main-branch CI run
behind PR #15 failed both tests that create a diagram through the command
palette. **Manually verified by the owner (2026-10-17).**

They typed "New diagram" immediately after `Ctrl+Shift+P`, before the
Angular overlay had mounted — the dropped keys left a one-letter query
whose best fuzzy match is "Git: Merge a branch…", so Enter opened the
branch picker instead of creating a diagram. That picker was live because
the e2e vaults sit under `test-results/` inside the checkout, where git's
upward discovery resolves every test vault to the Drey sources
themselves — one confirmed dialog away from a real `git merge` in the CI
checkout.

- `e2e/drawio.spec.ts`: a `runCommand` helper waits for the palette and
  the filtered command row before Enter (what `e2e/zen.spec.ts` already
  did).
- `e2e/manual-screenshots.spec.ts`: the file-palette screenshot waits for
  the dialog before typing — same race, dormant.
- `e2e/fixtures/drey.ts`: the launched app gets
  `GIT_CEILING_DIRECTORIES` at the repo root, so a non-git test vault
  stays non-git even inside the checkout (the git specs init their repos
  in the vault, which the ceiling does not touch).

No app code changed; tests only.

### req-45 — the positive update-check answer is inline green text, not a dialog

An owner request, outside the list (2026-10-17, on top of milestone 82).
**Manually verified by the owner (2026-10-17).**

A manual "Check for updates" that finds nothing new no longer opens a
window: main sets the `up-to-date` status only, and the renderer shows
it — green text in the status bar ("The latest version (Drey x.y.z) is
already installed.", six seconds, next to the word count) for a
Help-menu check, and the same line in green in Settings → Updates for a
check from there. The asks (update available, install) and the failure
dialogs are unchanged; the startup check stays silent as before.

Verified by: renderer + main typechecks, lint, the new
`src/app/services/update.service.spec.ts`, the status-bar spec's note
cases, and the reworked state-machine spec case (no dialog on
`up-to-date`). ADR-0074 carries a later-change note.

### Milestone 82 — auto-update from GitHub Releases

The old "Next" item 8, split: the update system ships here, code signing
stays its own item. **Manually verified by the owner (2026-10-17)** — the
full round on a real install: baseline 0.7.0, the startup ask, skip and
later, the manual check, the differential download, the install through
the save-before-exit prompt (dirty tab saved, cancel path included), the
relaunch on 0.7.1, and req-45's green inline confirmation.

Drey can now update itself from the repo's GitHub Releases
([ADR-0074](../docs/09_architecture_decisions/0074-github-releases-auto-update.md)).
electron-updater is the transport (GitHub provider, differential blockmap
downloads, SHA512 verification); every decision stays Drey's —
`autoDownload` / `autoInstallOnAppQuit` off, and each ask a native
English dialog in main: *update available* (Download update / Skip this
version / Remind me later), *downloaded* (Install and restart / Later).
On start — 10 s after the splash handover — the app checks GitHub for a
newer "Latest" release. That check is **on by default**: ADR-0074's
bounded exception to the everything-opt-in rule (the check sends no user
content; everything after it asks), with a Settings switch to turn it
off. "Skip this version" persists `updates.skippedVersion` through the
first main-side config write (`AppConfigStore.patch`). Installing closes
the window through the ordinary save-before-exit prompt; the installer
is armed only once the window really closed, then runs at `will-quit`
(one-shot `quitAndInstall(false, true)`: assisted NSIS, relaunch after
install — the fresh instance takes the single-instance lock cleanly).
The renderer never touches the network: `shared/ipc/updates.ts` +
`electron/ipc/update-handlers.ts` carry the triggers and a status push;
the surfaces are Settings → Updates (status, check now, download
progress, install) and the Help menu's "Check for updates". Dev runs,
other platforms and the portable exe report `unsupported` and get the
releases-page fallback; a failed startup check stays silent (log only),
the manual check shows the error.

Supply side: `electron-builder.yml` declares `publish: github`, so every
pack writes `latest.yml` (the SHA512 manifest), the setup `.blockmap`
and the packaged `app-update.yml` — proven on a real local pack
(`npm run pack`, `verify:pack` all green) — and CI attaches `latest.yml`
+ blockmap to the `v*` release next to the exes. Only releases that
themselves carry the updater can self-update: 0.6.0 installs make the
hop to the first updater release by manual download. Corporate proxies
are noted, not engineered for: the updater rides Electron's `net` stack
(system proxy, Windows certificate store).

Verified by: renderer + main typechecks, lint, import cycles, the unit
suites (new: `shared/updates.spec.ts`, the updates slice in
`shared/app-config.spec.ts`, `electron/updater/update-service.spec.ts` —
the state machine over fakes), the full production build and the
packed-app smoke test. The full installer flow has the manual
verification checklist in
[`docs/07`](../docs/07_deployment_view.md) ("Cutting a release").

Docs: ADR-0074, `docs/05` (component + feature rows), `docs/06` §6.63,
`docs/07` (artifacts, CI, release checklist), the manual (Settings →
Updates, the Help menu). One new runtime dependency: electron-updater
(now in the About page's licence list).

### Architectural cleanup A12 — unit tests for the composition root

Item A12, the last follow-up of the 2026-10-13 architecture review
([`docs/11`](../docs/11_risks_and_technical_debt.md)). No change to what
the app does; 28 new specs cover what only the end-to-end suite reached
before. The Node suite is at 1,519 (was 1,491).

- **`electron/app-services.spec.ts`.** `buildAppServices` runs for real
  against a throwaway user-data dir: all eighteen services construct,
  the config store reads defaults, the vault manager starts without a
  vault, the plugin host's activation promise resolves before
  `discoverAndActivate`, and the history sweep tolerates its missing
  root. `syncMcpHttpTransport` follows the config: the endpoint starts
  on `mcp.enabled` + `mcp.httpEnabled`, stops otherwise, and a taken
  port warns instead of throwing.
- **`electron/main-window.spec.ts`.** The save-before-exit state
  machine (bug-5), driven over a fake `BrowserWindow` whose `close`
  mirrors the real one — the event may be prevented, then the window is
  destroyed and `closed` fires. The first close holds and asks the
  renderer; "save" closes through; an app-level quit runs the same
  prompt and calls `app.quit` only after the window is gone; "cancel"
  keeps the window open and leaves no quit intent behind; a second X
  while the dialog is up waits without asking twice; a fresh window
  prompts again.
- **`electron/plugin-host/plugin-context.spec.ts`.** The plugin's vault
  context was untested beside `buildLlmContext`: writes carry the
  plugin id as the history origin, `writeAnnounced`/`delete` resolve the
  vault and run the external-change announcement, `confirmWrite` marks
  its request as an assistant overwrite (and answers false without a
  bridge), `announceChanges` sends an empty round as a full refresh and
  splits notes from other files, and `assistantVaultOptions` carries
  origin, protection, scope and the per-call files.

  origin, protection, scope and the per-call files.

### Architectural cleanup A10–A11 — the plugin specs typechecked, runtime cycles checked

Items A10 and A11, the follow-ups of the 2026-10-13 architecture review
([`docs/11`](../docs/11_risks_and_technical_debt.md)). No change to what
the app does.

- **A10 — the plugin specs are typechecked in CI.** A new project,
  `tsconfig.plugins.json`, covers `plugins/**/*.spec.ts` (the Node suite
  transpiles them without checking types); the CI step runs
  `tsc --noEmit` over it. It surfaced twelve errors, all in
  `plugins/assistant/main/chat-engine.spec.ts` (older than A1): a fake
  provider id, a tool stub without `parameters.properties` and ten dot
  accesses into the config's index signature, now bracket accesses.
- **A11 — a script fails on runtime import cycles.**
  `scripts/check-cycles.mjs` (`npm run cycles`, CI step after lint)
  builds the import graph over `electron/`, `shared/`, `plugins/` and
  `src/` and fails with the cycle chain. An edge counts only when the
  importing file uses a value of the imported module: `import type`
  never does, and a clause whose every name resolves to an interface or
  type alias is erased by the compilers (tsc elides it in the CJS build,
  esbuild drops the unused specifiers), so it cannot cycle at runtime.
  The classification uses the TypeScript compiler API — no new
  dependency. Today's graph: no runtime cycles across 689 files. (The
  full graph, type-only edges included, has 11 loops that all live in
  type-only imports — legal, and left as they are.)

### Milestone 81 — Zen mode

The roadmap's "Next" item 6: a focused, chrome-free writing/reading view.
**Manually verified by the owner (2026-10-16).**

One command, `view.toggleZen` ("Toggle zen mode", default chord
`Ctrl+Alt+Z`, View menu row with a check mark, listed in the palette and
Settings → Keyboard shortcuts like every command), removes the titlebar
(menu bar and window controls with it), the three docks and the status
bar from the layout; the centre column — tab bar, meta bar, editor —
stays, and OS fullscreen (F11) composes with it. Zen is session-transient
(deliberately not persisted: the app always starts in the full shell) and
it is a pure render gate in the shell — it never mutates `DockService`
state, so leaving zen restores the layout exactly as it was entered. With
the menu bar hidden, the chord and the command palette are the two
always-available exits.

Verified by: renderer typecheck, lint, the shell unit test (`app.spec.ts`
zen gate) and three new e2e tests (`e2e/zen.spec.ts`: hide and restore,
the dock fold state untouched underneath, the palette reachable in zen
and exiting zen from it).

### Fix — a link in a rendered table no longer kills the window (bug-11)

Found by the owner (2026-10-14), outside the list. **Manually verified
by the owner (2026-10-17).**

Clicking a link inside a rendered table (an HTML block, a callout …)
navigated the whole window: those widgets hold markdown-it's HTML, so
the link is a real `<a href>`, and a relative note link resolved against
the app's own origin — the dev server answered "Cannot GET /…", and with
the app gone the window could neither be used nor closed. Main's
`will-navigate` guard let it through because it allowed every path of
that origin.

Now three layers keep the window on the app:

- The editor opens such a link itself: a plain click on a link in a
  rendered widget goes through the same link opening as a `Ctrl`+click on
  a link in the text (a note opens in a tab, a web link in the browser);
  `widgetLinkHref` in `src/app/editor/link-open.ts`. `#anchor` links
  (footnotes) still jump in place.
- A renderer-wide guard (`src/app/services/link-navigation-guard.ts`,
  installed by `App`) cancels any same-origin link that names another
  page, wherever it was drawn.
- Main allows a navigation only to the app's entry page (`/` or
  `/index.html` on the renderer's origin — the dev server's live reload);
  `electron/navigation-guard.ts`.

Specs: `electron/navigation-guard.spec.ts`,
`src/app/services/link-navigation-guard.spec.ts`, `widgetLinkHref` cases
in `link-open.spec.ts`; e2e `e2e/link-navigation.spec.ts` (a link in a
table opens the note, the window stays). The manual says how links open.

### Milestone 75 — Configurable shortcuts

Roadmap "Now" item, decided with the owner on 2026-10-13 and
2026-10-14:
[ADR-0073](../docs/09_architecture_decisions/0073-configurable-shortcuts.md).


**Settings → Keyboard shortcuts** lists every command (base and plugin)
and the system-wide **quick-capture** hotkey, each with its shortcut.
*Change* records the next key press (Esc cancels), *Remove* leaves the
command without a shortcut, *Reset* brings back the default. A chord
needs Ctrl or Alt, or a function key; the chords the editor and Electron
need (undo/redo, clipboard, select all, find, Ctrl Enter, zoom,
Ctrl Space, the line moves, Alt F4) are refused with a message. A chord
another command holds is named with its holder and a **Replace** that
leaves the holder without one; two defaults that collide are marked.
The editor's fixed keys are listed read-only below.

- **Storage:** a new base config slice, `keybindings`
  (`overrides: { commandId: chord | null }`, `capture: chord | null`,
  default `Mod+Alt+N`). `normalizeAppConfig` keeps chords canonical and
  drops one that is no longer assignable, so the command falls back to
  its default.
- **One chord grammar** in `shared/keybindings.ts`: parse, canonical
  spelling, the key-press reader, the validation, the effective chord,
  the Electron accelerator. The renderer's old `parseChord` and the
  palette's `formatChord` now sit on it (`formatChord` moved into
  `src/app/keybindings/`).
- **`KeybindingService`** resolves every chord through the overrides
  (fed by `App` from the persisted config), rebuilds its index on each
  change — which also fixes a stale chord: a disabled plugin's inert
  stand-in used to keep the old chord bound — and offers `hint()` /
  `titled()`, which every menu row, the tab and editor context menus,
  the line-numbers tooltip and the formatting strip now print instead
  of literal "Ctrl …" strings. A plugin menu row that runs a registered
  command shows that command's chord.
- **Quick capture** moved out of `main.ts` into
  `electron/capture-hotkey.ts`: registered from the config at startup,
  re-registered on `config:set` when the chord changed or the last try
  failed; `shortcuts:capture-status` tells the page "In use by another
  program".
- Help → **Keyboard shortcuts** shows the user's capture chord; its fixed
  rows gained *Select line*, the line moves and *Ctrl Space*.
- Specs: `shared/keybindings.spec.ts`, keybinding cases in
  `shared/app-config.spec.ts`, `electron/capture-hotkey.spec.ts`, override /
  pause / stale-chord cases in `keybinding.service.spec.ts`,
  `settings/shortcuts/shortcut-model.spec.ts` and
  `settings-shortcuts.spec.ts` (record, Esc, reserved, Replace, hotkey in
  use), the quick-capture row in `shortcuts-doc.spec.ts`; e2e
  `e2e/shortcuts.spec.ts` (a rebound command runs on its new chord and
  the View menu shows it; Replace). Docs: ADR-0073, `docs/05`, `docs/06`
  §6.62, the manual (§18, §20).

### req-43 — CI stores the exes only for tags and manual runs

Owner request, outside the roadmap list (2026-10-14).

CI had failed on every run since 2026-10-13 although every check passed:
the last step, uploading the setup and portable exe as workflow
artifacts, hit the account's artifact storage quota (`Artifact storage
quota has been hit`). Each push to `main` and each PR stored both exes
for 14 days.

Every run still builds, packs and smoke-tests the exes
(`verify:pack`); `.github/workflows/ci.yml` now uploads them only for a
`v*` tag push or a manual run (`workflow_dispatch` — Actions → CI → Run
workflow, on any branch), kept 3 days. The `v*` Release attachment and
the e2e failure diagnostics are unchanged. `docs/07` (§CI) follows. The
artifacts stored before the change still count against the quota until
they are deleted or expire; GitHub recalculates usage every 6–12 hours.

### Milestone 80 — Vault context by text search; the embedding retrieval is removed

Owner request, outside the roadmap list (2026-10-14):
[ADR-0072](../docs/09_architecture_decisions/0072-vault-context-by-text-search.md),
which supersedes ADR-0055.

The finding that led to it: the semantic search returned sections that
had nothing to do with the question, and did not find a note that
contains the very word searched for ("einstein").

- **The Vault chip's context comes from text search.** With the chip
  on, a question carries up to four note sections that contain its
  words. The question is split into words (no stopwords, nothing under
  three characters, at most eight); each is searched in the tags
  plugin's section index — case-insensitive, inside words too, in
  heading and text; a section scores the sum of the weights of the
  words it contains, a rare word weighing more and a word in the heading
  one and a half times. Chat notes stay out. Nothing has to be switched
  on, downloaded or built. A model that can call tools still searches
  and reads further by itself.
- **Removed:** the embedding worker and the per-vault vector index
  (`plugins/assistant/main/semantic/`); Settings → *Assistant
  retrieval*; the Search panel's **Semantic** toggle and its score
  badges; the tool `vault_retrieve` (assistant and MCP server) and its
  mention in the system prompt; the SDK's semantic seam
  (`registerSemanticSearch`, `searchSemantic`, `SemanticSearchProvider`,
  `SemanticSectionHit`) — **SDK 1.26, the one removal under a minor
  version**, reasoned in the ADR and in `plugins/AUTHORING.md`; the
  dependencies `@huggingface/transformers`, `onnxruntime-web`,
  `onnxruntime-common` and the stub packages for `onnxruntime-node` and
  `sharp` (`tools/stubs/`), with their `asarUnpack` entries and the CI
  junction step.
- **Left-overs are cleaned up once:** when the assistant plugin starts
  it deletes `<userData>/plugins/assistant/semantic-index/` and
  `<userData>/models/`. The `semantic.*` keys in the plugin's config
  file are ignored.
- **Old chat notes still read.** A turn's `drey-context` fence may say
  `disabled` or `empty` with a `floor` (written before this
  milestone); both are still parsed and shown. New turns write `empty`
  (no section contains the words) or `unavailable` (no section index —
  the Tags plugin is disabled).
- **Not covered:** a question finds a section only through its words —
  no synonyms, no paraphrases; the block reads saved text, not an
  unsaved tab; the number of sections is fixed; templates are not in the
  section index.
- Specs: `plugins/assistant/shared/vault-context.spec.ts` (the words,
  the ranking, the scope helpers, the block),
  `plugins/assistant/main/vault-context.spec.ts` (the lookup over a
  fake section index, the "einstein" case, the reasons for an empty
  result), `plugins/assistant/shared/ask-context.spec.ts` (the new and
  the old context statuses), `plugins/assistant/main/engine.spec.ts`,
  `chat-engine.spec.ts` and `system-prompt.spec.ts`,
  `electron/mcp/vault-tools.spec.ts`,
  `plugins/tags/renderer/hit-list.spec.ts`; e2e
  `assistant-tools.spec.ts` (a chip-on question about "Einstein" reaches
  the model with the section that contains the word, and the turn cites
  it). The specs of the removed
  service, the vector index and `vault_retrieve` went with them.

### Milestone 79 — Web search and the Web chip

Owner request, outside the roadmap list; the last step of the assistant
tool rework (a later change to
[ADR-0063](../docs/09_architecture_decisions/0063-mcp-client-and-assistant-tool-groups.md)).

- **A built-in `web_search` tool.** Settings → Assistant tools → *Web
  search*: a switch, a provider and its approval rule (`tools.webSearch`,
  off by default). Four providers, one file each under
  `electron/mcp-client/search-providers/`: **DuckDuckGo** without a key
  (its HTML result page is read — works at once, may change or refuse
  requests; Settings says so), **Brave Search** and **Tavily** with an
  API key, **SearXNG** with the address of an instance of the user's
  own. A search returns title, address and a short excerpt of up to ten
  results; a failure reaches the model as `Error: the web search failed
  (<provider>): …` with what to change. The tool is offered only when
  its provider has what it needs (no key yet = not offered, and
  Settings says so). The key is encrypted in `app-config.json` like the
  LLM key; switching the provider clears it.
- **Asked like the other external calls.** A search under *ask* shows
  the approval dialog with the search words; *Always allow* sets the
  search rule only (source `web_search`, apart from `web_fetch`'s
  `web`).
- **The Web chip.** A globe button in the composer, next to the Vault
  button and remembered the same way (`localStorage`), decides for each
  question whether anything may leave the machine through a tool:
  `web_search`, `web_fetch` and the external MCP servers ride a question
  only while it is on (`AskRequest.web`). It shows only while Settings
  has one of them switched on, and it starts **off** — a change for
  setups that had web fetch or a server enabled: those tools now need
  the chip. Settings stays the permission; the chip is the per-question
  choice.
- **The prompt names what is there.** The external line of the system
  prompt lists exactly the attached kinds (`web_search`, `web_fetch`,
  `mcp__<server>__<tool>`) and, with search and fetch together, says to
  read a page before relying on an excerpt.
- **Not covered:** a key per provider; a guard against private
  addresses; the chip follows a Settings change when the pointer or the
  focus returns to the composer (plugins get no config-change event).
- Specs: `electron/mcp-client/web-search.spec.ts` (each provider's
  request and parsing, the DuckDuckGo page, failures, abort),
  `mcp-client.spec.ts` (offer, approval source, refusal),
  `shared/app-config.spec.ts`, `electron/config-secrets.spec.ts`,
  `plugins/assistant/main/engine.spec.ts` and `system-prompt.spec.ts`,
  `plugins/assistant/renderer/state.spec.ts`,
  `src/app/tool-approval/tool-approval.service.spec.ts`; e2e
  `assistant-tools.spec.ts` (the chip off and on, a search against a
  local SearXNG stand-in).

### Milestone 78 — The open note through the same tools

Owner request, outside the roadmap list; the third step of the
assistant tool rework
([ADR-0071](../docs/09_architecture_decisions/0071-unified-vault-toolset-and-agent-loop.md)).

- **A vault tool sees what the tab shows.** Main asks the renderer about
  open tabs over a new bridge (`OpenDocsBridge` in `electron/ipc/`,
  `OpenDocsBridgeService` in the renderer; channels `open-docs:request`
  / `open-docs:reply`). `vault_read` and the word / regex scan of
  `vault_search` read the buffer of an open file, unsaved text included.
  `vault_edit` and `vault_write` change an open file **in its tab** and
  save it from there (the on-save Actions stay out); the confirmation
  diff is made against the buffer. `vault_move` takes the tab along and
  rewrites links in unsaved notes in their buffers; `vault_delete`
  closes the tab. This holds for programs on the MCP server too. Without
  a window the tools work on the files, as before.
- **The attached note is changed with `vault_edit`.** The assistant puts
  the note of the question into the tools' scope (`vaultToolsFiles`),
  whatever the Vault chip says: with the chip off the model gets
  `vault_read`, `vault_edit` and `vault_write` for that one file. The
  whole-document `document` fence stays the protocol where no tools ride
  (a provider without a tool loop, a model that refused them) and for a
  chat note, a draft or a file opened from outside the vaults. `tools.vault.write:
  off` does not block the attached note — its change is asked in the
  diff, as an ask-mode edit always was.
- **Live edit uses the same tools.** `doc_apply_diff`, `doc_write`,
  `doc_read`, the main-side working copy and the `chat:liveEdit` push
  are gone (`plugins/assistant/main/live-edit.ts` deleted). A live turn
  marks the note `live`: every change lands in the tab at once, without
  the dialog and without saving.
- **A tab that was never saved is edited the same way** — live or after
  the diff. It rides the call as a file without a vault
  (`vaultId: null`); the tools reach it in the editor only, never save
  it and never read a vault file of the same name.
- A turn whose tools changed the note persists the resulting document
  as its applied `edit` entry (live or not). The assistant's
  confirmation dialog no longer times out after two minutes.
- SDK 1.25: `MainChatOptions.vaultToolsFiles`, `onVaultChange`.
  `VaultCallOptions.files` / `onChange`, `VaultToolDeps.openDocs`.
- Prompts: `askToolsSystem`, `liveEditSystem`
  (`specs/classifier-spec.md`).
- Tests: `electron/mcp/vault-tools.spec.ts` (open tabs, files in a
  call's own scope), `plugins/assistant/main/chat-engine.spec.ts`,
  `system-prompt.spec.ts`, `electron/plugin-host/plugin-context.spec.ts`,
  `src/app/services/open-docs-bridge.service.spec.ts`,
  `e2e/assistant-tools.spec.ts` (the open note through its tab; live
  edit unsaved).

### Milestone 77 — One vault toolset for the assistant and the MCP server

Owner request, outside the roadmap list; the second step of the
assistant tool rework
([ADR-0071](../docs/09_architecture_decisions/0071-unified-vault-toolset-and-agent-loop.md)).

Eight tools replace the base `vault_search` / `vault_read` /
`vault_write` and the assistant's own `vault_overview` / `vault_find` /
`vault_section`:

| Tool | Does |
|---|---|
| `vault_list` | what exists: paths, a folder, a name pattern, optionally each note's headings; a long listing comes back as folders with counts |
| `vault_search` | exact search: all words in one section, a quoted phrase, a regular expression, `tags`; `path` narrows to a folder **or one file**; context lines; every hit with its line number |
| `vault_retrieve` | sections by meaning (semantic), offered only while retrieval is enabled |
| `vault_read` | numbered lines; the whole file, a range or one section by heading; 400 lines by default with a line that says how to continue |
| `vault_edit` | replaces exact text — it must occur once (or `replace_all`), several edits apply all or none |
| `vault_write` | `mode` is required: `create` (fails if the file exists), `append`, `overwrite` |
| `vault_move` | rename or move, links rewritten, attachments follow |
| `vault_delete` | one file, to the recycle bin, asked every time |

What changes for the user:

- **The Vault chip decides what the assistant can reach — to read and
  to change.** The tools work in exactly the vaults the chip selects,
  enforced where the tool runs: a call that names another vault is
  refused. With the chip off the assistant has no vault tools and works
  only with what is attached to the question. Before, `vault_write`
  could write into any registered vault whatever the chip said, and the
  read tools reached the active vault with the chip off.
- **Settings → Assistant tools → Vault** is now one choice — may the
  assistant change notes: *not allowed*, *ask first*, *without asking*.
  The former on/off switch became "not allowed": a vault group that was
  off stays unable to write. **Reading no longer needs the switch** — it
  follows the chip. ⚠️ If the group was off, the assistant can now read
  the chip's vaults but not change them until this is set to *ask
  first*. A fresh install starts at *ask first*.
- **The assistant can change part of a note in any file** without
  sending the whole file back, find a word inside one note, read a long
  note in parts, and see what a vault contains.
- **A mistyped write mode can no longer overwrite a file**: before, any
  `mode` other than `append` meant "replace everything".
- **A move or a deletion asks in the approval dialog** (without "Always
  allow"); a deletion asks even when changes are set to *without asking*.
- `chats/` and `.drafts/` are left alone by the assistant: not listed,
  not searched, not changeable.
- A file the assistant changed keeps its `\r\n` line ends, and the local
  history records the write as the assistant's (it said "mcp" before).

⚠️ **For programs connected to Drey's MCP server the tools changed.**
`vault_search` takes `query` (was `text`), `regex` is a switch on it
(was a second pattern, `regexFlags` is gone), `max_results` (was
`maxResults`), and `mode: "semantic"` became the tool `vault_retrieve`;
`vault_write` needs `mode` and knows `create`; `vault_read` returns
numbered lines. Without a `vault` argument a search now covers every
registered vault (was: the active one). `tasks_list` takes `vault`.

How: the set lives in `electron/mcp/tools/` (one concern per file:
`defs.ts` — the descriptions, `scope.ts`, `list.ts`, `search.ts`,
`read.ts`, `write.ts`), `VaultTools` (`electron/mcp/vault-tools.ts`)
decides what a caller is offered and routes a call with its
`VaultCallOptions` (scope, write rule, origin, protected folders). The
edit core is `shared/text-edit.ts` (`applyTextEdits`); `tasks_list` has
one definition and runner for both callers (`shared/tasks-list-tool.ts`).
The search reads the note files themselves — no index of its own. The
assistant's `vault-explore-tools.ts` and `vault-scan.ts` are gone; its
system prompt names the new tools (`specs/classifier-spec.md` quotes
every description).

Plugin SDK **1.24**: `vaultToolsScope` is the scope of every vault tool
of a call, reading and writing (was: a filter on two read tools);
`vaultTools: true` attaches the new set. Config: `tools.vault` is
`{ write: 'off' | 'confirm' | 'auto' }` (`enabled` is read once and
dropped). `ToolApprovalRequest.once`.

Specs: `electron/mcp/vault-tools.spec.ts` (rewritten: offer, scope,
every tool), `shared/text-edit.spec.ts`; changed: the config, host,
prompt and engine specs. End to end (`e2e/assistant-tools.spec.ts`):
`vault_edit` changes a note on disk; chip off → no vault tool offered.

Known limits until milestone 78: a tool reads and writes the file on
disk, so an unsaved change in an open tab is not seen and a write to
that file shows up as "Changed on disk"; a moved note's open tab keeps
its old path. On a live-edit turn the document itself is still changed
with the `doc_*` tools.

Cleanup after it (behaviour-neutral): the semantic service's methods
only the old explore tools used are gone (`resolveTargets`,
`searchScoped`, `outline`, `readSection`, `VectorIndex.outline`,
`locateSemanticSection`), and the semantic index splits notes with
`splitSections` from `shared/note-sections.ts` instead of its own
identical copy — the stored section boundaries are unchanged.

### Milestone 76 — The assistant's tool loop and system prompt

Owner request, outside the roadmap list; the first of four steps of the
assistant tool rework
([ADR-0071](../docs/09_architecture_decisions/0071-unified-vault-toolset-and-agent-loop.md)).
No new tools — the existing ones became dependable.

What changes for the user:

- **A slip by the model no longer loses the turn.** A tool that fails,
  an unknown tool name, broken or incomplete arguments: each comes back
  to the model as an `Error: …` it can correct, instead of ending the
  ask. A number or yes/no sent as text is repaired.
- **The assistant answers when its rounds are used up.** One setting,
  Settings → Assistant tools → *Rounds of tool calls per question*
  (default 12), replaces the fixed 3 / 5 / 6 / 8 / 16. When it is used
  up the model is asked once more for its answer from what it found.
  Where tools ran and the model still says nothing, the turn is kept
  with what the tools did and a line saying so — before, the turn was
  discarded while a write it made stayed on disk.
- **Tool calls show while they run.** The answer card lists each call as
  it starts (`tool · vault_read(path: …) …`) and marks a failed one;
  before, they appeared only after the turn.
- **A tool that was not offered does not run.** A vault tool that the
  group switch or the Vault chip's scope left out used to run anyway
  when the model called it by name. Now only what the request offered
  runs.
- **Local models that write the call into the reply** —
  `<tool_call>{…}</tool_call>`, or a reply that is only a JSON call —
  are understood.
- **A model without tool support is handled once.** When the endpoint
  refuses the tools, the assistant asks again with a prompt that names
  none, and remembers that for the model until the app restarts (before:
  every question paid for a refused request, and the prompt went on
  describing tools the model did not have). Only a refusal of the very
  first request counts — a 400 after tools ran is reported as the error
  it is.
- **Long results of earlier turns are shortened** to 2 000 characters
  when the conversation is sent again; the chat note keeps them whole.

How: `electron/llm/tool-loop.ts` (`runToolLoop`) is the one loop both
HTTP providers run; each provider supplies a single-request function.
`shared/llm/tool-args.ts` checks arguments against the tool's
parameters, `shared/llm/text-tool-calls.ts` reads calls from reply text.
The host dispatcher (`electron/plugin-host/plugin-context.ts`) runs a
name only where it was offered from and no longer hands the base
`tasks_list` to plugin calls. The system prompt is built by
`plugins/assistant/main/system-prompt.ts` from fixed parts — role,
environment, vault context, the tools attached to this call, the rules
for working with tools — and replaces the chain of prompt notes
(`specs/classifier-spec.md`, "The assistant's system prompt").

Plugin SDK **1.23** (additive): `MainChatOptions.onToolEvent`;
`onToolCall` gets checked arguments and may throw; `maxToolRounds`
defaults to the user's setting. Config: `tools.maxRounds`.

Specs: `electron/llm/tool-loop.spec.ts`, `shared/llm/tool-args.spec.ts`,
`shared/llm/text-tool-calls.spec.ts`,
`electron/plugin-host/plugin-context.spec.ts` (the merge and dispatch had
no test), `plugins/assistant/main/system-prompt.spec.ts`; changed:
both provider specs, the assistant's engine, replay and panel-state
specs. End to end: `e2e/assistant-tools.spec.ts` — the first e2e test
against a model that calls tools (a scripted endpoint).

Left for later (roadmap, follow-ups of milestone 76): streaming the
answer of a tool-carrying request; cancelling a plugin or vault tool
call in flight.

### req-42 — Cyberpunk has its own app mark

Owner request, outside the roadmap list.
While the **Cyberpunk** theme is on, Drey shows the neon mark
(`handoff/Designer (10).png`) instead of the default one, in three
places: the titlebar, Settings → About, and the window's **taskbar /
Alt-Tab icon**. Switching the theme swaps all three at once, without a
restart; a start in Cyberpunk shows the neon icon from the first frame
(main reads the stored theme before it creates the window). Every other
theme keeps the default mark.

Fixed when the app is packed, and therefore unchanged: the exe's own
icon in Explorer, the installer, the desktop and Start-menu shortcuts
(and with them, presumably, a taskbar button the user *pinned* — not
verified). The startup splash keeps the default mark too: it is drawn in
the Anthrazit palette for every theme (ADR-0062).

One table decides which mark a theme gets — `shared/app-icon.ts`
(`appIconVariant`), read by main for the window icon
(`windowIconFor` in `electron/app-paths.ts`, re-applied from `config:set`
when `appearance.theme` changed) and by the renderer for the in-app mark
(`ThemeService.markUrl`). No new IPC channel: the theme already lives in
the app config main owns. `scripts/make-icon.mjs` writes the second set
(`build/icon-cyberpunk.ico` / `.png`, `public/icon-cyberpunk.png`) from
`build/logo-source-cyberpunk.png`; the `.ico` ships as an
`extraResources` file. The theme id became a shared constant,
`CYBERPUNK_THEME`. Spec: `shared/app-icon.spec.ts`. The live icon swap
was typechecked and linted but not run in this checkout.

### Architectural cleanup A1–A5 — tests beside their code, linted dependency rules, no import cycles

Items A1–A5 of the 2026-10-13 architecture review
([`docs/11`](../docs/11_risks_and_technical_debt.md)). No change to what
the app does, with one exception named under A4.

- **A1 — tests live next to their code.** 59 spec files moved out of
  `src/app/services/` to the `shared/`, `electron/` or `plugins/<id>/`
  file they test, and from the Angular runner into the plain-Node suite
  (`vitest.plugins.config.mts`). Two more were merged into the spec that
  already existed beside the source (`electron/note-manager.spec.ts`,
  `plugins/git/shared/status.spec.ts`). `src/app/services/` keeps the 14
  specs that test a file in that folder. Four moved specs need a DOM and
  carry `// @vitest-environment jsdom`. The same 2,410 tests run as
  before: 1,334 in the Node suite (was 494), 1,076 in the Angular runner
  (was 1,916).
  - `app-config.spec.ts` was not a duplicate: the one under `electron/`
    tests the config store, the moved one (`shared/app-config.spec.ts`)
    the normalisation. Nothing to merge.
  - `shared/**/*.spec.ts` is now typechecked by
    `electron/tsconfig.spec.json` and excluded from the three projects
    that build `shared/` (before, a spec under `shared/` was compiled
    into `dist-electron/`).
- **A2 — the dependency rules are lint rules.** `eslint.config.mjs` now
  fails on: `shared/` importing `src/`, `electron/` or `plugins/`;
  renderer ↔ main; the base importing a plugin; a plugin importing
  `src/`, `electron/` or another plugin. Type-only imports count. The
  rules run under `@typescript-eslint/no-restricted-imports`, so the
  barrel rule's `off` inside a module does not disable them. No existing
  code had to change.
- **A3 — the two renderer import cycles are gone.**
  - `DailyNoteService` moved from the `vault/` module to
    `src/app/services/` (it opens documents, so it sits above
    `EditorService`).
  - `PluginCatalogService` (new, `src/app/services/`) holds the plugin
    list and installing / removing packages; Settings → Panels & plugins
    uses it instead of `PluginHostService`.
  - `TagVocabularyService` subscribes to `search:changed` itself instead
    of reading a signal on `PluginHostService`.
  - `SettingsCategoryRegistry.registerPluginPage` is handed the host
    component by its caller instead of importing it from `plugin-host/`.
- **A4 — `DailyNoteManager` writes through `VaultManager`.** The daily
  note and the starter `templates/daily.md` are written atomically and
  entered in the own-write ledger like every other app write.
  **Behaviour change:** because the watcher now takes these writes for
  the app's own, the manager announces what it created — the Files
  panel, the calendar dot and the indexes show a hotkey-created daily
  note at once, also with the watcher off (before, only the watcher's
  echo did that). Spec: `electron/daily-note.spec.ts`.
  - The check the roadmap asked for: the fixed `templates/daily.md` is
    **not a defect**. `specs/frontmatter-schema.md` and the manual name
    that literal path, and the indexes exclude the literal `templates/`
    in addition to the configured folder; `templates.dir` is the folder
    of the template *library*. Left as it is; whether the daily template
    should follow the setting is now an owner decision in the roadmap.
- **A5 — the composition root is split.** `electron/main.ts` (1,138
  lines) keeps the order of startup and the app lifecycle (406 lines).
  New beside it: `app-services.ts` (`buildAppServices` builds every
  long-lived object and returns one typed `AppServices`),
  `main-window.ts` (`MainWindowHost`: the window and the save-before-exit
  prompt), `app-protocols.ts` (the three custom schemes),
  `startup-reports.ts` (the native error dialogs) and `app-paths.ts`.
  `PluginHost.buildContext` builds `ctx.vault` and `ctx.llm` through
  `plugin-host/plugin-context.ts`, one function per namespace.

Verified by: all six TypeScript projects, lint, both unit suites, and 44
end-to-end tests (startup, splash, CSP, plugins, daily notes, external
open, images, search) against a fresh build.

### Milestone 74 — Assistant on a selection

Selecting text in a note shows a small assistant button next to the
selection (after the mouse button is released, or on a keyboard
selection). It opens a popover with three things: a one-line question
field, the prompts from the prompts folder, and the manual Actions.

- **A question or a prompt is asked about the selection in the chat.**
  The Assistant panel opens and answers; the composer's chips and the
  live-edit switch apply as set. The selection rides the call as a
  `SELECTED SECTION` block between the question and the document
  (`AskRequest.selection`, `buildAskUserMessage`), and is quoted above
  the question in the chat note, so the transcript reads on its own and
  a follow-up replays it. A proposed edit goes through the usual
  confirmation.
- **A manual Action runs on the selection** — the same run as its `⋯`
  menu row, which already sent the selection.
- **Command** `assistant.askSelection`, `Ctrl+Shift+A`: the same popover
  from the keyboard.
- **Switch:** Settings → Actions → "Show the assistant button at a
  selection" (on by default; stored in the assistant plugin's own
  config). The button also stays away while LLM features are off.
- **The prompts folder follows the templates folder.** The composer's
  Prompts picker and the popover read `<templates.dir>/prompts/`; the
  renderer used the fixed `templates/prompts` before, while the
  assistant's template tools already used the configured folder.
- **Screenshots are English throughout** (`CLAUDE.md`, Language
  Convention; owner request): the manual's demo vault
  (`e2e/manual-screenshots.spec.ts`) is English — notes, file and folder
  names, tags, templates, the prompt, the mocked answer — and all 44
  manual images were re-captured from it. The assistant e2e prompt
  fixtures are English too.
- No SDK change: the button is a CodeMirror tooltip built from the
  host's modules (`plugins/assistant/renderer/selection-button.ts`), the
  popover plain DOM (`selection-popover.ts`).
- Unit: `plugins/assistant/shared/ask.spec.ts` (payload, quote),
  `main/ask-prompts.spec.ts` (block order), `main/chat-engine.spec.ts`
  (message + persisted turn), `renderer/selection-popover.spec.ts`
  (rows, keys, dismiss), the state and prompts specs. E2E:
  `e2e/assistant.spec.ts` (button on a selection, popover content, the
  command, the Settings switch).

### req-41 — the formatting strip: grouped, pinnable, at hand in the right-click menu; one template picker

Owner request, outside the roadmap list. The editor's right-click menu
had grown a text row for every formatting command (Highlight, Subscript,
Superscript, Inline math, Math block, Callout, Footnote, Clear
formatting, Emoji…) next to an icon toolbar offering the same commands.
Now there is **one formatting strip** in two places:

- **Grouped.** Nineteen buttons became ten: template picker · paragraph
  style ▾ · Bold · Italic · more text formats ▾ · list ▾ · Task list ·
  Link · Table ▾ · Insert ▾. Everyday one-click commands stay buttons;
  variants of one thing (heading levels, blockquote, the five callouts;
  bullet / numbered; the table size grid) and the rare commands
  (strikethrough, highlight, sub- and superscript, Clear formatting;
  image, emoji, footnote, math) sit behind five menus. Menu buttons
  carry a small caret; a button without one acts at once and opens
  nothing. The paragraph menu marks the style of the caret's line.
- **In the right-click menu.** On every editable Markdown surface (pane
  notes, the entry drawer, plugin composers) the strip is the head of
  the context menu, a box of its own above the list, and acts on the
  surface that was right-clicked. The list keeps only real text rows --
  clipboard, Export as PDF…, plugin rows -- and is itself the strip's
  **first menu** (*Clipboard and more*): open when the context menu
  opens, and like every other menu it gives way while another one is
  open, so the template picker never sits on half-covered rows. Its
  button brings it back. Read-only views and non-Markdown tabs get no
  strip, just the list.
- **Pinnable.** The strip's pin docks it into the meta bar (the old
  toolbar position) or releases it; released, the bar runs straight into
  the save cluster. The pin replaces the collapse chevron and the `⋯`
  row "Formatting toolbar"; the persisted pref (`drey.editor` →
  `toolbar`) is unchanged, so nobody's setting moves. Also a palette
  command, *Pin formatting toolbar*.
- **One template picker.** The strip's first button opens it: a filter
  field, the library as a folder tree (subfolders nest; folders start
  collapsed once the library holds more than 24 templates; typing
  switches to a flat list of matches with their folder) beside a preview
  of the active row. Keyboard throughout — the field keeps the focus,
  ↑/↓ move, →/← open and close a folder, Page Up/Down jump to the ends,
  Enter inserts, Esc closes. The **`/` menu uses the same picker**: a
  bare `/` shows one *Templates…* row instead of every template by name
  (a typed name still completes directly), and the row floats the picker
  at the caret. The reserved top-level `templates/prompts/` folder (the
  composer's prompts, ADR-0048) is left out of both; the Templates panel
  still lists the whole folder.

Plugin SDK **1.22** (additive): `ToolbarButtonContrib.placement`
(`'insert'`, the default — a row in the strip's Insert menu — or `'bar'`,
an icon at the leading edge) and `popover(mount, close)` (the host owns
the box and its anchoring, the plugin mounts plain DOM). The templates
plugin uses both; the diagrams plugin's button became the Insert menu's
"Insert diagram" row. Two plugin context-menu contributions went with
the rows they duplicated: the templates' recents and the diagrams'
"Insert diagram" ("Edit diagram" stays).

Fixed on the way: a spelling check still in flight when the text
changed painted its underlines at the old offsets -- past the end of
the text when a word had just been deleted -- and the next edit then
threw while mapping them and was lost. The "Templates…" row (delete
`/tem`, insert the template) hit exactly that, about one time in
twenty. An edit now discards the reply of a check that judged the older
text (`spellcheck.ts`, with a regression test).

Considered and not built (recorded in `decisions.md`): a selection
bubble that appears over marked text, and a toolbar row of its own
under the meta bar.

Code: `src/app/editor/markdown-toolbar.ts` (the strip),
`toolbar-dispatch.ts` (the one dispatch path for both placements),
`paragraphStyleOf` in `toolbar-commands.ts`,
`src/app/editor-context-menu/` (`format-strip-target.ts` replaces
`format-menu-rows.ts`), `MarkdownSurface.forView`,
`plugins/templates/renderer/picker.ts`. Specs: `markdown-toolbar.spec.ts`,
`format-strip-target.spec.ts`, `picker.spec.ts`, additions to
`editor.spec.ts`, `library.spec.ts`, `slash.spec.ts`; e2e
`markdown-extended.spec.ts` (strip in the context menu, pin round trip)
and `slash-entry.spec.ts` (picker from `/`: folders, no prompts, arrow
keys). The diagrams e2e was adjusted but not run in this checkout (the
draw.io web app is not fetched there).

### Settings apply at once — no Save, no Discard
- **One model for the whole dialog.** Core pages used a draft with Save /
  Discard and an "unsaved changes" bar; plugin pages saved as you edit;
  the footer changed per page. Now every change applies as it is made.
  The footer shows "Changes are saved automatically" (or "Saving…", or
  the error) and one **Close** button (ADR-0010 later change).
- **Typed values are stored when the field is left** or on Enter, not per
  keystroke — also when the window loses focus or the screen closes. A
  half-typed URL or folder never reaches disk.
- **A save no longer overwrites what a plugin page stored.** It writes
  only the sections that changed, onto a fresh read of the stored
  config. Before, Save sent the whole draft and could undo a change made
  on a plugin page (Actions, Templates) since the screen opened.
- **MCP "YOLO mode" asks before it turns on** — it now takes effect with
  the click. The MCP page's "Listening on …" line follows each change.
- **A new MCP server** shows "Enter a command to connect." until it has
  one; its tool id follows its name while the page that added it is open.
- A failed save keeps the screen open; the button then reads "Close
  without saving".
- No rollback: a theme tried and not liked is picked back by hand.

### Milestone 73 — Lossless Markdown template ("Structure note")

A third built-in Action template, **Structure note (lossless)**
(`builtin:lossless-format`): it restructures a raw note into Markdown
without adding, inferring or interpreting anything, and tags it from the
vault's existing vocabulary only. The reply is free Markdown and goes
through the ADR-0011 whole-document confirmation; an unchanged reply is
a no-op. A fresh install ships one manual trigger for it, so it is a row
in the editor's `⋯` menu out of the box; an existing config's trigger
list is the user's own and stays untouched (add the trigger once in
Settings → Actions).

- **One vocabulary placeholder for every prompt.** `{{AVAILABLE_TAGS}}`
  (`shared/llm/prompt-substitution.ts`, `substituteVocabulary`) is
  replaced with the tag list at call time — in Autotag and in *every*
  Action template the assistant runs, the user's own included. The
  reserved `task` is never offered; an empty vocabulary reads
  `(none yet)`. Autotag's old `{tags}` spelling keeps being substituted,
  and a stored Autotag prompt that still equals the old default is
  refreshed to the new one (a genuine edit keeps its text).
- **Plugin SDK 1.21:** `ctx.search.sectionSearchProvider()` — the read
  side of the section-search seam (mirroring `tasks.queryProvider()`).
  The assistant's `ActionEngine` reads the tags plugin's vocabulary
  through it; with the tags plugin disabled the list is empty.
- **Deviation from the draft** (`classifier-spec.md`, formerly
  "Planned"): no `{{NOTE}}` placeholder — the note rides the user
  message like for every Action, so the built-in needs no special path
  through the engine.
- Not enforced: the prompt instructs the model to stay inside the
  vocabulary, nothing strips an invented tag — the confirmation diff is
  the check (roadmap follow-up).
- Unit: `shared/llm/prompt-substitution.spec.ts` (token, legacy token,
  `task` filter, empty vocabulary), `plugins/assistant/main/action-engine.spec.ts`
  (system prompt assembly for the lossless template, no-op on an
  unchanged reply), `app-config.spec.ts` (the third built-in, the seeded
  trigger on a fresh config only, the legacy Autotag prompt refresh),
  `actions-resolve.spec.ts` (the default resolved action).
- Specs: `classifier-spec.md` (the placeholder section, the template as
  shipped). Manual: the Actions section.


### Manual stamp — the manual's footer states version and content date from the build

The in-app manual's footer was hand-written ("Manual for Drey 0.3.0"
while the app is 0.5.0) and drifted. `docs/manual/manual.md` now
carries `{{MANUAL_VERSION}}` / `{{MANUAL_GENERATED}}` tokens, and
`scripts/sync-manual.mjs` substitutes them while mirroring: the version
comes from `package.json`, the generation date is the day `docs/manual`
last changed in git. A build-time date was rejected on purpose — it
would dirty the committed `public/manual` mirror on every new day's
first build, breaking the script's byte-stability promise; both chosen
values are deterministic, so an unchanged source still re-syncs without
git noise. A missing version token fails the build loudly, so a
hand-edited version cannot come back silently.

### Editor chrome — unsaved is the save button alone; zoom gets its indicator

The meta bar no longer spells out "Unsaved" next to the save cluster:
the dirty state lives in the accent-coloured save button (and the tab's
dot) alone. The editor zoom (`Ctrl +` / `Ctrl -` / `Ctrl 0`,
`Ctrl`+wheel, `editor.fontScale`) gains an indicator: while the scale
differs from 100%, the meta bar shows the percentage in mono (matching
the path), and one click resets it — at 100% the chip is gone, so the
default state stays chrome-free.

- Unit: `editor.spec.ts` ("Editor chrome") — the save button alone
  carries dirty; the chip appears only away from 100% and resets on
  click (a config-serving fake, so the zoom multiplier is real).
- E2e: `editor-chrome.spec.ts` drives the real path — type to dirty,
  `Ctrl +` to zoom, click the chip to reset.
- Manual: one sentence on zooming in the Modes section.

### Fix — Files panel: the inline name fields keep their keys

While one of the Files panel's inline name inputs (rename, new file /
new folder, vault rename) was open, every key but Enter, Escape and blur
reached the tree underneath instead of the field: `onTreeKeydown` is
bound on the tree container and had no guard for events bubbling out of
the input. The cursor keys moved the tree selection — and through the
focus-follow's blur even committed the field outright — while
`preventDefault()` froze the caret inside it. Delete was the dangerous
one: it ran the tree's delete on the selected *file* (confirm dialog
and all) while its *name* was being edited. The handler now returns
early for keydowns from an input/textarea — the same guard the panel's
context-menu openers already use; a target-identity check would have
broken bug-7's roving focus, where focused row buttons bubble there
legitimately.

- Reproduced first, as the roadmap demanded: `e2e/files-rename.spec.ts`
  covers the defect's manifestations (caret, focus, no delete dialog,
  nothing lost on cancel) plus the Enter/Escape happy paths and the
  new-file input — red before the guard, green after.
- Unit regression in `files-panel.spec.ts`: keys dispatched from all
  three inline inputs leave the tree selection alone and never reach
  the delete confirm. (jsdom's `select()` cannot focus, so the
  vault-rename focus check lives in the e2e.)

### Milestone 72 — Extended Markdown: GFM+, callouts, highlight, math (KaTeX), footnotes, emoji

The editor and every Markdown view now render the full markdownguide
basic + extended surface — one dialect across the three engines (Lezer
grammar, markdown-it, PDF export;
[ADR-0070](../docs/09_architecture_decisions/0070-extended-markdown-dialect.md)):
callouts, `==highlight==`, `$…$`/`$$…$$` math through KaTeX, footnotes,
curated `:emoji:` shortcodes, bare-URL autolinking, rendered
sub/superscript — plus the insert affordances (toolbar, `/` menu,
context menu, emoji picker + `:`-completion), the formatting eraser
(`Mod+\`, outermost layer first) and a collapse handle at the toolbar's
left edge (one click folds the buttons away; shares the `⋯`-menu
toggle's persisted pref).

- **Callouts** (`> [!NOTE]`, GitHub alerts + Obsidian's aliases folded
  onto the five palette kinds): tinted container, icon, custom titles;
  the Obsidian `-`/`+` fold suffix parses and normalizes away (static
  boxes by decision). PDF parity: styled boxes with the light palette.
- **Highlight** `==text==` — amber wash, `==` marks conceal/reveal like
  emphasis. PDF: `<mark>`.
- **Math** `$…$` / `$$…$$` typeset through **KaTeX** — editor widgets
  (script lazy on first formula; stylesheet + woff2 fonts as static
  assets, `<link>`-injected then — in the initial CSS they cost ~300 KB
  of budget), PDF via the inlined runtime with fonts as `data:` URLs
  and a synchronous bootstrap. Parse errors show the compact red box /
  keep the LaTeX. Currency guard: "costs $5 and $6" stays prose.
- **Full GFM remainder**: bare-URL **autolinking** everywhere including
  table cells and the PDF (`linkify`); code spans remain the documented
  way to **disable** it. Pandoc **sub/superscript** (`H~2~O`, `X^2^`)
  now render (the grammar already parsed them).
- **Footnotes** (`[^1]` / `[^1]: …`, req-13): superscript numbers in
  document order, definitions as a muted block with `n.` marks; the PDF
  renders a real footnotes section (markdown-it-footnote).
- **Emoji shortcodes** `:joy:` re-enabled — curated gemoji table
  (~1,900 GitHub names, `shared/markdown/emoji-table.ts`, regenerated
  via `npm run emoji:table`), which is what keeps timestamps like
  `00:03:48` plain (the reason the built-in parser was removed).
- **Insert affordances** for the whole dialect, one reducer layer
  (`toolbar-commands.ts`) behind three entries: the formatting toolbar
  (highlight button, sub/sup + callout + math menus, footnote and emoji
  buttons — seven new Lucide glyphs), the `/` menu (Highlight … Footnote
  plus `/emoji`), and the editor's right-click menu
  (`format-menu-rows.ts`, base rows on every Markdown CodeMirror
  surface; the menu now caps at 460 px and scrolls). Callouts toggle
  (marker line on/off, keyword swap on variant change), footnotes plant
  `[^n]` plus the definition in one undo step.
- **The `:emoji:` picker** (`src/app/emoji-picker/`): an App-level
  overlay with search + glyph grid over the curated table (recents
  first, persisted in `drey.emoji.recent`), opened from the toolbar's
  smile button, the context menu's "Emoji…" row and `/emoji`. Typing
  `:jo` in prose additionally completes shortcodes
  (`editor/emoji/emoji-completion.ts`, recents ranked first, silent
  behind word characters so times/URLs/prose colons never fire).
- **The formatting eraser** (`editor/erase-formatting.ts`): with the
  caret, `Mod+\` peels ONE layer -- the outermost inline wrap at the
  position (`**fett ==rot==**` loses the bold first, `***x***` unwraps
  emphasis-then-strong); with a selection, one stroke wipes every wrap
  it overlaps. Markers go, content stays (a link keeps its label, drops
  the URL); block formatting is untouched (its toggles own that). Same
  entries as the dialect: toolbar eraser button, `/clear`, the
  context-menu row, and the `Mod+\` keybinding.
- One implementation site per engine: all Markdown views share
  `MarkdownSurface`; `shared/markdown/` carries the pure halves
  (callout keywords, emoji table, math scanner, the markdown-it rule
  pack). Spellcheck masks math/footnotes/markers/shortcodes.
- New deps: `katex` (+`@types/katex`), `markdown-it-footnote`,
  `gemoji` (dev). The assistant chat card's small subset is unchanged.
- Note: the production build's initial-bundle warning (1.61 MB vs the
  1.35 MB warning budget) predates this milestone by ~230 KB; this adds
  ~30 KB (the emoji table). The 2 MB error budget is not near.

### Embedded pictures survive split-pane focus switches

Owner-reported: with the editor split into two panes, a note in a
subfolder holding embedded draw.io SVG pictures showed "image not found"
for every embed after switching to the other pane and back; one more
click into the editor loaded them again. Owner-verified.

- **The cause was resolution through the focused pane.** Live Preview
  resolved an embed's candidates at decoration-build time through
  `EditorService.openPath`/`openVaultId` -- the facade over the FOCUSED
  pane. A rebuild in a background pane (a focus switch recreates the
  image widgets) resolved the note-relative reference against the other
  document: for a subfolder note the candidate chain fell back to the
  vault root and found nothing; for a vault-root note it coincidentally
  stayed correct -- which is why only some notes broke.
- **The same window fired on a tab switch's first decorations.** The
  shown document's identity reached the surface as a template input,
  one change-detection pass after the content swap, so every embed's
  first candidate resolved against the PREVIOUS note once and 404ed
  (invisible -- a later rebuild healed the widget, but the request had
  already failed).
- **The identity now travels with the content.**
  `MarkdownSurface.setDocumentIdentity` (path, vault id, help asset
  base) is set by `Editor.loadActiveDoc` synchronously before the view
  gets the text, and embed resolution reads exactly that -- never the
  focused pane's facade, never a lagging input. Wikilinks keep the
  `docVaultId` input (completion runs long after the switch).
- New regression spec: `e2e/image-embed-pane-switch.spec.ts` -- the
  subfolder repro plus the vault-root contrast case, also asserting no
  failed `drey-asset://` request anywhere along the flow.

### The assistant answers a scoped ask from the scoped vaults only

Owner-reported: with the docs vault selected in the Vault chip, "what is
this vault about" was answered from the active vault — the chat notes
showed the model quoting `tasks_list` results (active-vault tasks) while
the docs context sat unused in the system prompt.

- **The scope no longer depends on retrieval succeeding.** The chat
  engine resolves the ask's targets from the vault registry
  (`resolveTargetVaultIds`) and arms `vaultToolsScope` on every chip-on
  ask — semantic retrieval off, or a retrieval error, can no longer
  leave the base `vault_search`/`vault_read` tools on their
  active-vault default (ADR-0069 later change).
- **Active-vault-only tools are withheld out of scope.** When the chip's
  selection excludes the active vault, `tasks_list` and the template
  tools (and their notes, and the post-hoc task block) do not ride the
  ask; the tools note lists only in-scope vaults and demands explicit
  vault ids. A new scope note binds "the vault" in the question to the
  selection, and the tasks note restricts the tool to task questions.
- **Explore tools survive semantic-off.** With `semantic.enabled` off,
  `vault_overview`/`vault_find`/`vault_section` degrade to fresh
  filesystem scans (`plugins/assistant/main/vault-scan.ts`, shared
  section splitter/locator, token-coverage ranking, 200-file cap)
  instead of disappearing — a scoped ask keeps in-scope lookups.
- **Replay attachments try the scoped vaults** when the active-vault
  read misses, so a chat bound to a non-active vault keeps its
  attachments on follow-ups.
- New specs: the engine's scope arming and tool gating
  (`chat-engine.spec.ts`), the filesystem scan ports
  (`vault-scan.spec.ts`), the scoped notes (`ask-prompts.spec.ts`).

### A third bespoke theme: Cyberpunk

- **Settings → Appearance → Theme → Cyberpunk**, listed with Anthrazit
  and Drey. Violet-black surfaces, a lavender text ramp, violet lines and
  a neon pink accent; popovers glow instead of casting a shadow. Loosely
  after the Typora "cyberpunk" theme, not a port of it — no grid overlay,
  no flicker, no display fonts, and pink / violet lead where that one
  leads with cyan.
- **Built like Anthrazit:** exact tokens in a
  `:root[data-theme='cyberpunk']` block of `src/styles.css`, so the whole
  shell follows. The editor look is its own highlight style
  (`src/app/editor/themes/cyberpunk-look.ts`, loaded on demand) over the
  token-driven Drey surface: pink / violet / cyan headings (h1 and h2
  with a soft glow), cyan links, a neon code palette. Those colours are
  fixed — they do not follow the highlight colour, which still re-tints
  the chrome.
- Anthrazit stays the default; the splash stays Anthrazit.

### Milestone 71 — Agentic vault exploration (ADR-0069)

Owner request: the fixed top-4 context and the scope leaks of the Vault
chip were not enough for good answers. The chip-on ask is now
**hybrid-agentic**.

- **Baseline stays, tools are added.** The top-k block of semantic
  retrieval still goes into the system prompt; tool-capable providers
  additionally get three scope-safe explore tools, closed over the chip's
  targets: `vault_overview` (files + headings straight from the index),
  `vault_find` (semantic ranking over exactly the chip's subset) and
  `vault_section` (one section, read fresh). Loop cap 6.
- **Scope enforced by the host.** `MainChatOptions.vaultToolsScope`
  (plugin SDK 1.20) makes the plugin host drop `vault_search` /
  `vault_read` from an ask whose scope excludes the active vault — they
  defaulted to it and leaked out-of-scope reads. `vault_write` is never
  filtered.
- **Cold or stale indexes self-heal.** `ensureUsable` starts a
  de-duplicated background rebuild instead of silently skipping;
  `RetrievalOutcome.targets` carries the resolved scope to the engine.
- **Picker semantics.** The first check from a shortcut scope in the
  vault picker replaces the selection instead of carrying the shortcut's
  vaults along (the "docs vault selected, answers from the active vault"
  trap).
- Specs: explore tools, semantic service (scoped search, outline,
  readSection, self-heal), host filter, engine wiring. Docs: ADR-0069,
  `CLAUDE.md`. Follow-up fix the same day: "The assistant answers a scoped
  ask from the scoped vaults only" (above).

### Fix — the image resize grip and the table keys work before the note is fully parsed

Dragging the corner grip of a picture did nothing when the picture sat
beyond what the editor had parsed so far: a freshly opened note is
parsed up to its first 3,000 characters at once and the rest in the
background, and the grip looked the picture up in that unfinished tree
while the picture itself was drawn from a complete one. The drag ended
without a change and without a message. The table keys had the same
flaw: Enter in such a table added a plain line instead of a row, and
the arrow keys did not step into or out of it. Both now read the same
complete tree as the drawing code (`completeSyntaxTree` in
`block-render.ts`).

- Found through a test that failed now and then: on a loaded machine
  even a three-line note can miss the up-front parse budget. A new test
  reproduces it with a picture behind 4,000 characters of text, a
  second one with a table there.
- The same test run exposed a second unreliable test, fixed without a
  change to the app: the checkbox-click test in `editor.spec.ts` waited
  a fixed 10 ms for a save that arrives through a timer; it now waits
  for the save.

### The IPC contract is split by topic behind its barrel

Item 10 of the 2026-10-11 architecture review, sixth and last file. A
restructuring: nothing the user sees or does changes, and no importer
changed.

- **`shared/ipc-api.ts` went from 1,363 to 65 lines.** It is now the
  barrel over `shared/ipc/`: `channels.ts` (`IPC_CHANNELS`), `app.ts`,
  `vault.ts`, `notes.ts`, `llm.ts`, `tags.ts`, `spelling.ts`, `mcp.ts`
  and `plugins.ts`. Each topic file holds its payload types and its slice
  of the bridge (`AppIpc`, `VaultIpc`, ...); `DreyApi` is their sum. The
  same shape as `shared/app-config.ts` over `shared/config/`.
- **The text was moved, not retyped**: a script cut the old file by line
  ranges and checked that every line landed exactly once. The exported
  surface (51 exports, every `DreyApi` member with its signature) was
  printed from the TypeScript checker before and after and is identical.
- One comment moved to where it belongs: the "Session history" note now
  sits above the session-backup methods, not above the note history.

### Anthrazit is the default everywhere; the splash shows the logo as a wordmark

- **Splash in Anthrazit.** `public/splash.html` still carried the Drey
  (terracotta) tokens; it now uses the Anthrazit ones (charcoal ground,
  blue progress bar), and the splash and main windows' background colour
  match. The splash does not follow a user-chosen theme — it is up before
  the config is read (ADR-0062 later change).
- **The logo is the "d".** Instead of the mark above a small "drey", the
  letters "rey" stand after the mark, on its baseline, sized to its bowl
  and in the cream of its outline, so the two read "drey".
- **Drey is an optional theme.** Anthrazit was already what a fresh
  install starts on; it now also leads the theme picker (Drey follows
  it), and is what an unknown stored theme id and the moment before the
  config has loaded resolve to — both used to be Drey. An explicit
  `theme: 'drey'` is untouched. The constant `DEFAULT_THEME` is renamed
  `DREY_THEME`, since it no longer names the default.

### One look and feel for the Settings dialog

A rework of the Settings overlay's styling and structure across all ten
core panes and the six plugin pages. No setting changed its meaning or
its storage.

- **One stylesheet instead of two mirrored ones.**
  `src/app/settings/settings-ui.css` is the whole Settings vocabulary —
  page frame, sections, fields, inputs, checkboxes, buttons, lists,
  cards, chips, status text, callouts, code blocks, focus ring. It is
  global and scoped under the dialog (`.settings-ui`, inside `:where()`
  so page-local rules win). `settings-forms.css` (core) and
  `plugin-settings.css` (plugins), which had drifted apart, are gone, and
  the per-page stylesheets shrank to what is genuinely page-specific.
- **One type scale, all sans.** The serif "Settings" and page titles
  follow ADR-0057 now; five different section-heading styles became one;
  `px` and `rem` sizes are one rem scale (13px labels, 12px hints —
  slightly larger than before); mono is left for code, paths and tool
  names. Hints use one colour that holds AA on both bespoke themes.
- **Every input looks the same.** `number` inputs and inputs without a
  `type` were unstyled; Tags, Entry format and Templates had private
  field styles. All controls share one height, radius, border and focus
  state; checkboxes and radios take the accent colour.
- **One button set.** `ghost` / `primary` in one size (plus `small` in
  rows), `link` / `link-danger` for in-row actions — "Remove" is the same
  control on every page.
- **Plugin pages get the page header.** `PluginSettingsHost` draws the
  title and a description like a core pane; SDK 1.20 adds the optional
  `PluginSettingsPageContrib.description`. Git no longer repeats its
  name as a heading; Tags has two real sections ("Rename and merge",
  "Prefix colors").
- **The footer tells the truth.** On a plugin page — which saves as you
  edit — it reads "Changes on this page are saved immediately" with a
  single Close; Save / Discard appear on core pages, and stay whenever
  the core draft is dirty.
- **Structure.** Vault, MCP and Assistant tools are grouped into titled
  sections; an option that depends on a switch is indented under it.
- **Small fixes on the way.** Errors and the YOLO warning use the status
  red instead of the accent (which is blue in Anthrazit); hard-coded
  colours in the LLM pane are tokens; the MCP note had no style at all;
  a panel with no capabilities no longer shows an empty "Uses:"; buttons,
  links, categories and swatches show keyboard focus.

### The Source control panel is split into state, commands, widget and dialogs

Item 10 of the 2026-10-11 architecture review, fifth file. A
restructuring: nothing the user sees or does changes.

- **`plugins/git/renderer/index.ts` went from 1,370 to 79 lines.** It
  was one `activate` function. Now, in the same folder:
  `repo-session.ts` (the state without DOM: what main reported per
  vault, the shown repository, the command in flight, the message
  drafts), `repo-commands.ts` (commit, merge, abort, resolve, amend,
  stash, fetch / pull / push, discard, compare — each with its checks
  and questions), `panel.ts` (the dock widget), the modals
  `picker-branch.ts`, `menu-actions.ts`, `dialog-stashes.ts`,
  `dialog-file-history.ts` and `dialogs.ts`, `settings-page.ts`, and
  `dom.ts`.
- **The decisions and the wording are pure functions now**
  (`repo-model.ts`): which repository the panel shows, the button
  labels and tooltips, the rows the branch picker offers.
  `repo-model.spec.ts` covers them with 22 tests.
- **A second e2e test** drives what had none: a merge that stops on a
  conflict, *Keep theirs*, completing the merge, amend, stash and apply,
  and the *Git history* dialog. It was written first and passed against
  the old file.
- Not covered by a test: fetch / pull / push (they need a remote),
  aborting a merge, *Keep mine*, deleting a stash, *Restore this
  version*, the repository select with several repositories.

### Fix — the tab bar and the dock icon strips form one line

The centre column's tab bar was 36px (`--bar-h`) while the docks' icon
strips sit on the 32px panel-header height (`--panel-head-h`) — side by
side under the titlebar, their bottom borders stepped by 4px. The tab bar
now shares `--panel-head-h`: the borders read as one continuous line.
Tabs keep their 28px row height with 3px headroom instead of 7px; the
titlebar, the image/PDF meta rows, the browser toolbar and the assistant
head stay on `--bar-h` (none of them touches the window's top line).
The strip itself was in on it: 24px icons + 2 × 4px padding + border
over a 32px *min*-height rendered it 33px — a pixel taller even than the
panel headers below it. Its vertical padding is now 3px, so the box is
exactly 32px. (ADR-0057 later change.)

### The Search panel is split into model, DOM, replace and summary

Item 10 of the 2026-10-11 architecture review, fourth file. A
restructuring: nothing the user sees or does changes.

- **`plugins/tags/renderer/index.ts` went from 1,040 to 60 lines.** It
  was one `activate` function. Now, in the same folder:
  - `search-session.ts` — the model, without DOM: the query, the stored
    choices (`search-prefs.ts`), the hits and the run.
  - `search-panel.ts` — the dock widget: header toggles, the field, the
    replace row, the grouped hits.
  - `search-replace.ts` — the file-scope buffer patch and the bundled
    confirmation. "Replace all" and a hit's own replace button were the
    same preview-and-confirm code twice and now share it.
  - `search-summary.ts` — the Summarize digest into a scratch tab.
  - `hit-list.ts` — folding unsaved buffers into the hits and grouping
    per file, as pure functions; `dom.ts` — the element helpers.
- **Removed: an unused fetch.** The panel loaded the tag vocabulary on
  start, on every vault change and on every index update, stored it and
  never read it. It is gone; the panel still re-renders once the active
  vault is known, which that fetch did as a side effect.
- **Tests.** The eight existing e2e search tests run unchanged.
  `hit-list.spec.ts` adds 11 direct tests.

### The assistant panel is split into thread, composer and pickers

Item 10 of the 2026-10-11 architecture review, third file. A
restructuring: nothing the user sees or does changes.

- **`plugins/assistant/renderer/panel.ts` went from 1,854 to 101
  lines.** It was one function holding every part of the panel as nested
  closures. Now, in the same folder:
  - `thread.ts` — the turn cards, tool chips, the vault-context chip,
    the streaming card and the status lines.
  - `task-block.ts` — the interactive block a `tasks_list` result
    renders as.
  - `composer.ts` — context chips, the CodeMirror input with
    @-completion, the tool buttons; `composer-staging.ts` — files pasted
    or dropped onto it.
  - `picker-chat.ts`, `picker-model.ts`, `picker-prompt.ts`,
    `picker-vault.ts`, `picker-file.ts` — one picker each, over the
    shared `picker-frame.ts`.
  - `tool-format.ts` — how tool calls, results and task filters are
    worded, as pure functions; `dom.ts` — element and icon helpers.
  - `panel.ts` — the head, the assembly and the render loop.
- **Tests.** The panel had almost no coverage of its own, so two e2e
  tests were added first and run against the old file, then the new
  ones: the note chip, the file and prompt pickers feeding the composer,
  and the chat, vault and model pickers applying their choice.
  `tool-format.spec.ts` adds 20 direct tests.
- Expanding a tool chip, confirming a restart or copying a turn now
  re-renders the thread only, not the head and the composer too; the
  result on screen is the same.

### `EditorService` is split into a facade and four collaborators

Item 10 of the 2026-10-11 architecture review, second file. A
restructuring: nothing the user sees or does changes.

- **`editor.service.ts` went from 1,727 to 742 lines.** Its public
  surface is unchanged, so none of the ~50 files that use it changed.
  Behind it, in `src/app/services/`:
  - `open-doc.ts` — the `OpenDoc` record, tab keys, the doc factories
    and the "may this tab be replaced" rule, as plain functions.
  - `open-docs.store.ts` — `OpenDocsStore`: the registry of open
    documents, kept in step with pane placement, plus the loading /
    saving / error state.
  - `doc-open.service.ts` — `DocOpenService`: opening by kind, daily
    notes, scratch and help tabs, tab replacement, pins.
  - `doc-save.service.ts` — `DocSaveService`: the vault save with its
    conflict guard, external files, exit-time drafts, the "Save as…"
    write.
  - `doc-disk-sync.service.ts` — `DocDiskSyncService`: reload after an
    external change and the "Changed on disk" settlement.
  - `caret-memory.ts` — the per-document caret and scroll memory.
- `EditorService` keeps what ties these together: the selectors of the
  active document, closing tabs, the order and route of saves, and
  "Save as…".
- **All existing specs run unchanged.** `open-doc.spec.ts` adds 21 direct
  tests of the model functions and the caret memory.
- The image and PDF tab factories were the same code twice and are now
  one. The save's doc comment described the pre-ADR-0017 tag routing;
  it now describes what the save does.

### The Files panel is split into four files

Item 10 of the 2026-10-11 architecture review, first file. A
restructuring: nothing the user sees or does changes.

- **`files-panel.ts` went from 1,345 to 732 lines.** It was one component
  holding the tree model, the selection, the drag rules and every file
  operation. Now:
  - `files-tree.ts` — the tree as plain functions: visible rows, row
    keys, selection ranges, valid drop targets, name validation.
  - `files-tree-state.ts` — `FilesTreeState`: expanded folders, folded
    vault sections, keyboard cursor, multi-selection.
  - `file-operations.service.ts` — `FileOperationsService`: create,
    rename, move, copy / paste, delete, the vault registry actions, with
    their confirmations and error messages.
  - `files-panel.ts` — the events, the two context menus and the inline
    name inputs.
- **The existing panel spec runs unchanged** against the new structure
  (it found one difference during the work: a third `undefined` argument
  on a plain file open). `files-tree.spec.ts` adds 26 direct tests of the
  tree functions.
- Rename and move now share one code path for the link-aware rename and
  the clipboard follow-up.

### Milestone 70 — Local plugin packages + the sample plugin out of the default scope

([ADR-0068](../docs/09_architecture_decisions/0068-local-plugin-packages.md))

Three owner requests in one milestone: the `sample` plugin leaves the
app's default scope, a plugin-SDK tutorial uses it as the running
example, and plugins become locally installable from a package.

- **The sample plugin is dev/test-only now.** A plain `npm run build` no
  longer emits `dist-electron/plugins/sample/` — `build-plugins.mjs`
  produces it only under `DREY_BUILD_SAMPLE_PLUGINS=1` (the `npm run
  e2e` script sets it; the tsc configs keep compiling / typechecking it, so the reference
  stays type-checked). No dev run, `npm run app` run or package
  discovers it; the installer exclusion and `verify:pack` assertion
  stay as belt-and-braces. Trying to run the plugin e2e against a build
  without it fails fast with the remedy in the message.
- **`plugins/TUTORIAL.md`** — the step-by-step "write your first plugin"
  guide on the sample plugin (manifest → main → renderer → build →
  package → install), linking to `AUTHORING.md`, which stays the
  reference and now documents the package flow.
- **Install from file…** (Settings → Panels & plugins): a `.zip` of a
  built plugin folder — `plugin.json` at the archive root, exactly the
  tree `build-plugins.mjs` emits — is validated (manifest shape,
  `apiVersion` major, referenced entries present, no zip-slip, no
  built-in id collision, size caps; archive junk like `__MACOSX` is
  skipped, PowerShell's backslash entry names normalized) and
  extracted under `<userData>/plugins/<id>/`, preserving an existing
  install's `config.json` (upgrade). No new dependency: the zip reader
  is a TS twin of `fetch-drawio.mjs`'s central-directory reader.
- **Remove** on installed rows deletes the folder (recycle bin first);
  built-in ids are refused (their config lives in the same tree).
- **Applies on restart, offered immediately**: install/remove don't
  touch the running session's discovery snapshot (like
  `plugins.disabled`); the result dialog and a persistent hint row in
  the plugin section offer "Restart now" — `app:relaunch` runs the
  graceful close path (dirty tabs keep their exit prompt) after
  `app.relaunch()`.
- Checked by: e2e (`e2e/plugins.spec.ts` — install, upgrade-keeps-config,
  typed refusals, removal, with a self-contained store-only zip writer
  that doubles as the executable package-format example), both tsc
  typechecks, lint.

### Fix — plugins: stale module-type markers no longer survive in the dist tree

- **The crash:** in a checkout whose `dist-electron/plugins/` was last
  built before the renderer bundling, the old build's module-type
  markers (`{"type":"module"}` at the plugin root, `{"type":"commonjs"}`
  in `main/`) survived every later build — bundling removed the marker
  writing but nothing removed the files. At startup Node resolved the
  now-CommonJS `shared/` output against the stale root marker, parsed
  it as ESM, and every plugin with runtime `shared/` imports failed
  with "exports is not defined in ES module scope" (the assistant
  plugin first).
- **Build:** `build-plugins.mjs` now removes the two stale markers per
  plugin directory on every build, so one build heals an old tree.
  Fresh checkouts never carried markers, which is why the plugin tests
  and e2e stayed green while existing checkouts broke.
- **Installer:** a package zip packed per the older TUTORIAL wording
  (markers included) would install the same crash into
  `<userData>/plugins/<id>/`. The installer now drops `package.json` at
  the archive root and in `main/` as archive junk; deeper ones (bundled
  third-party content) stay untouched.
- **Tutorial:** the standalone-packaging note in `plugins/TUTORIAL.md`
  no longer recommends markers — it now says to ship none, with the
  reason.
- Checked by: `electron/plugin-host/plugin-installer.spec.ts` (marker
  strip incl. backslash names, deeper-marker regression), a new
  `e2e/plugins.spec.ts` package case, both tsc typechecks, lint.

### Fix — settings: scrolled categories no longer show above the headline

- **The sticky headline pins flush again.** The category nav scrolled
  with `padding: 8px`, and a sticky element is never shifted outside its
  containing block — the nav's *content box*, which starts 8px below the
  scrollport top. The `top: 0` pin was therefore clamped at that edge,
  and scrolled category rows stayed visible in the strip between the
  window border and the "Settings" headline. The nav's top padding moved
  into the head's own padding (22px), so the pinned head now covers the
  full top edge with its opaque background; the layout at rest is
  unchanged.

### `npm run dev` rebuilds and restarts Electron on its own

Item 13 of the 2026-10-11 architecture review. Development only; nothing
in a shipped build changes.

- **The stale main process is gone from the dev loop.**
  `scripts/dev-electron.mjs` replaces the one-time build in
  `dev:electron`: it watches `electron/`, `shared/` and `plugins/`,
  rebuilds what the change touches (main process and preload, the
  plugins, or both for `shared/`) and restarts Electron. Spec files and
  the fetched draw.io files are ignored.
- **The restart is an ordinary quit.** The launcher asks the app over the
  child-process channel (a listener in `electron/main.ts` that exists
  only with a dev server URL), so unsaved tabs raise the exit prompt and
  the session comes back afterwards. Cancelling the prompt keeps the old
  process; it is replaced once it closes. A failed build restarts nothing.
- **Unchanged:** closing the window ends the dev session. `npm run app`
  and the VS Code debug configs still build once — the trap remains
  there and stays described in `docs/11`.
- **Deviation from the review's wording:** it named `tsc --watch`. The
  launcher runs the existing build steps instead (about two seconds for
  the main process, four for the plugins): one code path for the first
  build and every later one, and no compiler output to parse.
- `cross-env` is no longer used by any script; the dev dependency is
  still listed.

### Plugin renderers are bundled; the copied helpers are gone (ADR-0044 later change)

Item 11 of the 2026-10-11 architecture review. No change to what the app
does, apart from the one fix below.

- **One file per plugin renderer.** `scripts/build-plugins.mjs` bundles
  each plugin's `renderer/index.ts` with esbuild (the tool that already
  writes the preload); `tsc` typechecks the renderer and still emits the
  main side. A plugin renderer can therefore import the repo's `shared/`
  at runtime, which `plugin://` alone never allowed.
- **The build refuses what must not be bundled.** Any runtime import that
  is not the plugin's own folder or `shared/` fails the build and names
  the file — a package such as `@codemirror/*` (ADR-0044 rule 1), `src/`,
  `electron/`, another plugin.
- **Copies removed.** The plugins now use the base definition of: the tag
  grammar, the wikilink grammar and its resolution, the section splitter
  (now `splitSections` in `shared/note-sections.ts`), the code-blanking
  helper, the tag colour rules and palette, the snippet defaults, the
  `chats/` and auto-save path rules, the default daily folder,
  `resolveActions`, the IPC error text, the placeholder substitution and
  the date / time formatters. The three parity tests that held copies in
  step are gone with them, and so is the tags plugin's `palette` backend
  call, which existed only to carry a constant across.
- **Fix:** Settings → Tags coloured a tag whose first segment contains a
  character outside the Basic Multilingual Plane differently from the
  editor and the panels; the copy of the colour hash had drifted.
- **Simpler output tree.** A plugin's `shared/` is emitted once, as
  CommonJS for its `main/`; the `package.json` module-type markers the
  build wrote into every plugin directory are no longer needed.
- **Still copied** (code outside `shared/`, see `docs/11`): the templates
  plugin's frontmatter strip, the tags plugin's `isAbortError`, and two
  small duplicates between the assistant plugin's own main and renderer.
- **Docs:** ADR-0044 later change, `plugins/AUTHORING.md` (what a
  renderer may import), `docs/05`, `06`, `07`, `11`, `CLAUDE.md`.

### Main-process tests and typed linting

Third package out of the 2026-10-11 architecture review. No change to
what the app does, apart from the fixes listed below.

- **Lint now knows types.** `eslint.config.mjs` runs
  `no-floating-promises` and `no-misused-promises` over every `.ts` file,
  next to the import-boundary rules. The whole codebase had 13 findings;
  all are resolved. Two of them changed behaviour: a startup step that
  throws now shows the "unexpected error" dialog instead of leaving the
  app without a window, and a main-window page load that fails is
  written to the log.
- **The main process has tests of its own** (`npm run test:plugins`, 223
  → 371 tests): both LLM providers against a scripted `fetch` (request
  shapes, tool loop, SSE streaming, error mapping), `VaultManager`
  against real temp folders (registry, path guard, read / write, delete,
  rename and move across vaults, copy), `NoteManager` (conflict guard,
  save hooks, line endings), `LinkRewriter`, `DailyNoteManager`, plugin
  discovery, the git plugin's parsers and `GitRunner` (against the
  installed git), the meeting plugin's decoders. Helpers:
  `electron/testing/fake-fetch.ts`, `electron/testing/temp-vaults.ts`.
- Main-process specs have their own `electron/tsconfig.spec.json`
  (typechecked in CI) and are no longer compiled into `dist-electron/`,
  so they no longer end up in the packed app.
- **Fixed on the way**, each found by a new test or by the lint rule:
  - A v1 `vault-config.json` was migrated again on every start, so the
    vault got a new id each time. The migrated registry is now written
    back once.
  - A streamed LLM reply lost its last piece when the server ended the
    stream without a final line break (both providers).
  - Meeting import: the join link of a known conferencing service was
    only preferred when the text started with it, so a link in a mail
    body lost against any earlier link. An invite without a start time
    failed with an internal error instead of importing.
- Docs: `docs/11` (lint row, test-coverage rows, the v1 row removed),
  `docs/07` (CI order), `CLAUDE.md` (test and lint commands).

### In-app help: the manual and live shortcuts ([ADR-0067](../docs/09_architecture_decisions/0067-in-app-help-documents.md))

Owner-commissioned package after milestone 69, on top of the English
user manual.

- **The manual moved to `docs/manual/`** (`manual.md` + `img/`, 44
  screenshots) and gained sections 19–22 (Getting help, shortcuts — now
  with `F1`, data locations, troubleshooting).
- **The manual ships with the app.** `scripts/sync-manual.mjs` mirrors
  `docs/manual/` → `public/manual/` (committed, byte-stable) in
  `prebuild` and the new `predev` hook; Angular's `public/**` copy and
  the `app://` protocol serve it in dev and packaged with zero
  electron-builder changes; `verify-pack` asserts manual + images in
  the asar.
- **A Help menu** (the titlebar's fifth): *User manual* (`F1`), *Keyboard
  shortcuts*, *About Drey* — the last opens Settings directly on About
  (`SettingsService.openScreen(category?)`). Both help commands are
  registered (`help.manual`, `help.shortcuts`), so the palette lists
  them.
- **Help documents are read-only pinned tabs** — a new base doc flavour
  (`OpenDoc.help { assetBase }`, `EditorService.openHelpDoc`): view
  mode, pinned, clean by construction (save / exit prompts are no-ops
  by the existing rules), `setViewMode`/`updateBuffer` refuse, the `⋯`
  menu hides document actions, the session snapshot skips them. The
  Live Preview resolves their relative image refs against the app
  origin (`resolveHelpImageCandidates`) — `manual/img/…` loads from
  `ng serve` or `app://` alike; explicit schemes and `..` escapes
  render nothing.
- **The shortcuts document is generated at open time** from the live
  `KeybindingService` registry (base + plugin commands, mouse side
  buttons) plus a fixed table of non-registry shortcuts (editing
  chords, `Ctrl F`, `/`, `[[`, `#`, the global capture hotkey) — it can
  never contradict the command palette.
- Fixed on the way: `normalizeTheme` fell back to `'drey'` instead of
  the documented Anthrazit fresh-install default.

### Renderer hardening: sandbox, Content-Security-Policy, encrypted keys

Second package out of the 2026-10-11 architecture review. **Not yet
manually verified by the owner.**

- **The main window is sandboxed.** `sandbox: true`, open since milestone
  1. The preload is bundled into one file by `scripts/bundle-preload.mjs`
  (esbuild, now a declared dev dependency), run by `build:electron` after
  `tsc`.
- **The page has a Content-Security-Policy**
  (`electron/content-security-policy.ts`): scripts only from the app
  bundle and plugin directories, no inline script, no `eval`, no network
  connection from the page, frames only from `plugin:` and `drey-asset:`.
  Sent as a header by the `app://` handler; a dev run adds the same
  policy to `ng serve`'s page. The production build no longer inlines
  critical CSS (that put an inline script into `index.html`).
- **Keys are encrypted in `app-config.json`** — the LLM API key and the
  environment-variable and header values of external MCP servers, stored
  as `enc:v1:…` with the OS user's key (Electron `safeStorage`). The rest
  of the file stays readable and hand-editable; a key typed in plain text
  is accepted and sealed at that start. A file from another machine or
  account loses its keys: the app says once which ones and keeps the file
  as `app-config.json.undecryptable-<timestamp>`. On Linux without a
  secret service values stay plain.
- **Fixed on the way: PDF tabs and PDF embeds did not load.** The tab's
  frame URL was rejected by Angular (`NG0904`), and the embed's probe was
  blocked because `drey-asset:` was not CORS-enabled. Both were broken on
  `main` before this package. The tab now marks its `drey-asset:` URL as
  trusted; `drey-asset:` is CORS-enabled and names the page's origin as
  the only allowed one.
- Tests: `e2e/csp.spec.ts` (a clean page load, blocked inline / remote /
  `eval` script, PDF tab, PDF embed, hostile HTML in a note); the e2e
  fixture fails any test that leaves a policy violation in the console;
  unit tests for the policy, the secret sealing and `AppConfigStore`.
- Docs: ADR-0001 and ADR-0010 later-change sections, `docs/08`
  ("Renderer hardening", "Secrets in the settings file"), `docs/05`
  §5.19, `docs/07`, `docs/11`, `plugins/AUTHORING.md`.

### Data safety: atomic writes, guarded config files, visible main-process errors

First package out of the 2026-10-11 architecture review. **Not yet
manually verified by the owner.**

- **Notes and settings are replaced atomically.** Every vault write
  (`VaultManager.writeFile` / `writeBinaryFile`), `app-config.json`,
  `vault-config.json`, the note history's index files and the session
  backups now go through `electron/safe-file.ts`: temp file beside the
  target, flush, rename. A crash or a sync client mid-write no longer
  leaves a cut-off file. A blocked rename is retried and then falls back
  to the old in-place write, so no save fails that worked before; a
  read-only file still reports its error. External tabs keep the
  in-place write on purpose.
- **A damaged settings file is kept, not overwritten.** Until now an
  unreadable `app-config.json` or `vault-config.json` silently became
  defaults, and the next save wrote those defaults over it — API keys,
  snippets, action templates, MCP servers or the vault list gone. The
  file is now moved to `<name>.corrupt-<timestamp>` and a dialog names
  it after start. A byte-order mark from a hand edit no longer counts
  as damage.
- **An uncaught error in the main process is shown.** The log listener
  had switched off Electron's own dialog; Drey now shows one itself
  (once per session, *Quit Drey* / *Keep running*).
- **One path-escape check for `app://` and `plugin://`**
  (`electron/path-guard.ts`), replacing the `startsWith` test on the
  `app://` side.
- Specs: `electron/safe-file.spec.ts`, `electron/path-guard.spec.ts`.
  Docs: `docs/08` (two new sections), `docs/05` §5.19, `docs/11` (the
  review's remaining findings are recorded there as debt rows).

### Milestone 69 — a dock icon strip replaces collapsed panel headers (ADR-0019 later change)

- **Why.** Ten panels, nine in the left dock, each showing its 32px
  header whether open or collapsed: 288px of headers in the default
  layout, 192px of it for six panels that showed nothing.
- **An icon strip per dock.** A 32px row at the top of each dock with one
  icon toggle per panel of that dock. A panel is open (frame + header) or
  closed (icon only); several can be open at once, stacked and split as
  before. The default left dock now spends 128px on chrome. Open panels
  are marked by a neutral gray fill (`--active-bg`), not the accent.
- **Collapse-to-header is gone.** A header click closes the panel; the
  strip icon opens it again. The stored `open` flag keeps its key, so a
  layout from before the change carries over — what was collapsed is now
  an icon. The View menu rows toggle the same flag; the separate `hidden`
  list (ADR-0034) is dropped, a stored one is re-homed once, closed.
- **Closed panels stay movable and keep their state.** Header and icon
  share one press gesture (click toggles, drag moves, also onto another
  dock's strip). A closed panel stays mounted; its status value shows in
  the icon's tooltip.
- **Closing a side dock's last open panel folds the dock.** Its titlebar
  toggle (`Ctrl+B` / `Ctrl+Alt+B`) brings it back with the strip and a
  one-line hint. The bottom dock shrinks to its strip.
- **SDK 1.19.** `PluginWidgetContrib.icon` (a vendored glyph name; first
  letter of the title as the fallback). All bundled plugins name one; one
  new vendored glyph (`calendar`).
- Deviates from `handoff/DESIGN.md` (every panel always shows a header) —
  recorded in ADR-0019.

### Milestone 68 — semantic search remainder: Search panel + MCP (ADR-0055 later change)

- **A base seam.** SDK 1.18 adds `SemanticSearchProvider` —
  `search(question, scope?, limit?)` → `SemanticSectionHit[]` (path,
  heading, line, snippet, text, vaultId, score) — registered through a
  second, parallel single slot `ctx.search.registerSemanticSearch`
  (same last-wins + unsubscribe discipline as the section-search slot;
  pluralising that registry was rejected as contract churn). The
  renderer facade gains `api.search.searchSemantic` over the reserved
  `drey.search.semantic` host method (non-empty question, validated
  scope, limit clamped 1..20). The assistant plugin registers the
  provider only while `semantic.enabled` is on, so "no provider" is the
  degrade signal everywhere.
- **Semantic mode in the Search panel.** A brain-icon toggle next to
  "Include chats" (vault/all scope only — the renderer cannot embed a
  buffer). On: the text query ranks by similarity over the assistant's
  index — hits grouped per file as usual, each with a percent score
  badge; tag chips stay meaningful as an exact post-filter over the
  hydrated section text (same nested-tag rule as the index search);
  the `Aa`/`ab`/`.*` flags and the replace row disappear (no literal
  match to modify); Export/Summarize work unchanged; unsaved buffer
  edits surface only after save (the index is disk-side). Degradation:
  without the provider the run says so ("the assistant's retrieval is
  disabled — Settings → Assistant retrieval").
- **`vault_search` mode `semantic`.** The MCP tool (and the
  assistant's own tool loop) gains `mode: 'text' | 'semantic'`
  (default `text`, existing clients unchanged): semantic requires a
  non-empty `text` (the question), refuses `tags`/`regex`, honours
  `vault` and `maxResults` (caps at 20), and answers
  `vault · path:line — heading (score 0.87) — snippet` lines. No
  provider → the usual clear error result.
- Pause / resume of large rebuilds was **considered and dropped**: an
  ask queues behind at most one 16-passage embed batch (tens of ms),
  never a whole rebuild; the mid-rebuild index gap is not fixable by
  pausing (ADR-0055 later change, roadmap "Closed").

### Git: merge, stash, amend, commit and push, file history (milestone 67)

- **Merge with a conflict surface.** *More → Merge a branch…* (or
  `git.merge`) merges into the current branch. When it stops on
  conflicts the panel shows a banner ("Merging <branch> · n conflicts
  left", abort icon); each conflicted file has *Keep mine*, *Keep
  theirs*, *Mark as resolved* and *Open file*. The commit icon is
  disabled until none is left, then an empty message completes the merge
  with git's own. A conflicting `git pull` ends in the same state.
- **Commit and push** as a second icon (`Ctrl+Shift+Enter`, command
  `git.commitAndPush`); a failed push keeps the commit and says so.
- **Not pushed.** History rows of commits missing on the upstream carry
  "↑ not pushed"; the Pull / Push icons and the branch tooltip show the
  counts and the time of the last fetch.
- **Git history** of the open file: editor context menu "Git history…"
  and `git.fileHistory` open a dialog (commits left, diff right,
  *Restore this version* puts it into the editor buffer).
- **Stash** (vault files incl. untracked; list, apply, delete) and
  **amend** (refused when the commit is already published — no
  force-push).
- Deviation from ADR-0065 (which excluded stash, merge surfaces and
  amend): recorded as its "Later change"; docs/05 §5.38, docs/06 §6.56
  and the roadmap follow-ups are updated. Five icons were added to the
  vendored set; the unit specs (parsers) ran, the Electron e2e did not.

### Anthrazit: neutral gray palette with AA contrast

- **Less brown, more readable.** The Anthrazit theme moves from the warm
  brownish charcoal to a neutral gray (dock `#222326`, editor `#18191b`,
  fields `#2c2d31`) and every text step, the file-status colors and the
  control borders now meet WCAG AA (4.5:1 text, 3:1 borders). Only the
  `:root[data-theme='anthrazit']` block and the theme seed changed — other
  themes (Drey, published ones) are untouched. Rationale and values:
  ADR-0057 "Later change".

### Assistant Vault chip: pick any subset of vaults

- **The Vault chip is a picker now, not a cycle.** Clicking it opens the
  composer's usual picker (`api.ui.showModal`) with three shortcut rows
  — *Off*, *Active vault*, *All vaults* — and one checkbox row per
  registered vault. Checking a subset (e.g. a non-active Git vault)
  sends `vaultScope: 'custom'` + the selected `vaultIds`, so questions
  can run against that vault without activating it (activating would
  also retarget daily notes, capture and chats, ADR-0051). Every
  registered vault is indexed and kept fresh regardless of scope, so
  the selection is purely an ask-time filter. The derivation is
  canonical (`deriveVaultScope`): none → off, exactly the active vault
  → vault, every registered vault → all (a static list would not
  auto-include a later-added vault), anything else → custom.
- **Robust against stale selections.** The custom selection persists
  beside the scope (`drey.assistant.vaultScopeVaults`); registry rounds
  prune ids of removed vaults (a rename keeps its id) and an emptied
  selection degrades to off visibly. At ask time main intersects the
  selection with the registry (`resolveTargetVaultIds`) — a custom
  scope resolving to nothing persists a new `unregistered` context
  status ("the selected vaults are no longer registered"), never a
  silent fallback to the active vault.
- **Citations name the vault.** `RetrievedSection`, the `drey-context`
  fence entries and the system-prompt block carry the vault's display
  name (`vault · path:line`), so equal paths across vaults stay
  distinguishable; the fence field is optional and tolerantly parsed,
  so older chat notes keep reading.

### Dev escape hatch: parallel instances share one userData

- **`DREY_MULTI_INSTANCE=1` opts an instance out of the
  single-instance lock** (`electron/main.ts`): parallel checkouts —
  e.g. checking several agent worktree outputs at once — now run side
  by side. They deliberately share the one userData (one set of
  settings, one vault registry; app config and the session snapshot
  are last-writer-wins), while the lock holder alone keeps the
  quick-capture hotkey and the Explorer file-open pushes; a
  hotkey-less second instance logs the usual registration warning.
  `dev.ps1 -Multi` (combinable with `-Built`) exports the variable —
  accidental double launches without it still focus the running
  instance as before.

### Build origin: branch + checkout in the About pane and the window title

- **The app can tell which checkout/worktree it was built from.**
  `scripts/stamp-build.mjs` now also records `branch`
  (`git rev-parse --abbrev-ref HEAD` — `worktree/<name>` in a linked
  worktree) and `checkoutPath` into `src/assets/build-info.json`, with
  the usual `unknown` fallback when git is unavailable. The About pane
  shows both as new fact rows, and `AboutService.applyWindowTitle()`
  (called once from the `App` bootstrap) suffixes the native window
  title — `Drey — silver-forest-0d1f` — so the taskbar / Alt-Tab tell
  apart concurrent dev instances from different worktrees. The custom
  titlebar never shows it; `BuildInfo.branch`/`checkoutPath` are
  optional so older stamped files keep parsing.

### Mouse side buttons navigate the document history

- **The mouse back/forward side buttons (XButton1/2) now step through
  the session's document history** (milestone 55's `DocHistoryService`),
  VS Code-style: `Command` gained an optional `mouseButton`
  (`MouseEvent.button`), and `KeybindingService` matches it with a
  second capture-phase `mouseup` listener next to its `keydown` one —
  `doc.back` is bound to button 3, `doc.forward` to button 4,
  window-wide (editor, docks, palette). The `mouseup` is swallowed
  (`preventDefault`) so Chromium's own back/forward default action
  never fires; `mouseup` rather than `mousedown` so a press in the
  middle of a drag never triggers mid-gesture. The matching `mousedown`
  is swallowed too (`preventDefault` + `stopPropagation`, no command):
  CodeMirror places the caret in its own mousedown listener — a regular
  listener, not a default action — so only stopping the propagation in
  the capture phase keeps the press away from the editor DOM and the
  caret in place. Always on, no setting —
  parity with the `Alt+ArrowLeft` / `Alt+ArrowRight` chords, which
  stay unchanged.
### Milestone 66 — Office documents open in their own program (Req-2 remainder)

([ADR-0066](../docs/09_architecture_decisions/0066-office-documents-open-in-their-own-program.md))

Req-2 asked for Office documents rendered inline. After the rendering
strategy discussion the owner decided against rendering: the files open
in the program the OS associates with them.

- **Word, Excel, PowerPoint and similar files open in their own
  program.** Click one in the Files panel, pick it in the quick switcher
  or Ctrl-click a link to it in a note — the OS opens it. Before, such a
  file opened in Drey as an unreadable text tab. The list of types is
  fixed (`shared/external-document.ts`): Office in all its forms,
  OpenDocument, RTF, Visio, Project, Publisher, OneNote, Loop, `.msg` /
  `.eml`. Executables, scripts and shortcuts are never opened this way.
- **Drop an Office file on a note** — as before, it is copied into the
  note's `attachments/` and linked. New: hold **Alt** while dropping and
  nothing is copied; the note gets a link to the file where it lives
  (`file:///C:/…`). Such a link works only on this machine and breaks
  when the file moves.
- **Drag an Office file from the Files panel onto a note** to link it
  in place (before, nothing happened).
- A link to a file on a network share (`file://server/…`) is refused,
  with a message.

### Milestone 65 — Git vaults: file status and a Source control panel (req-40)

([ADR-0065](../docs/09_architecture_decisions/0065-git-vaults-source-control-plugin.md))

- **A vault can be a Git repository.** Add a checked-out repository — or
  a folder inside one, such as its `docs/` — with "Add vault". Nothing
  else to set up; Drey uses the installed `git`, so your credential
  manager, SSH keys and `.gitconfig` apply. Settings → **Git** takes a
  path when git is not on PATH.
- **The Files panel shows each file's status.** Changed, added and new
  files are coloured and carry a badge (`M`, `A`, `U`, `R`, `!` for a
  merge conflict); a folder takes the colour of what changed inside it.
  A deleted file has no row — its folder is marked and the file is
  listed in the panel.
- **New dock panel "Source control"** (left, collapsed by default): the
  branch with ahead / behind, a commit message field, and the lists
  *Staged changes* and *Changes*. Stage and unstage single files or all,
  commit (`Ctrl+Enter`), Fetch · Pull · Push · Refresh in the header. A
  first push of a new branch publishes it. Fetch, pull and push can be
  cancelled.
- **Branches.** The branch button opens a picker: filter, switch to a
  local or remote branch, or type a new name to create one. Open tabs
  of files the switch changed reload.
- **Compare.** Clicking a changed file shows it against the last commit
  (staged files: last commit ↔ staged) in the diff view the file history
  uses.
- **Discard changes** per file, after a question. A file that is not in
  the repository yet goes to the recycle bin.
- **History.** The last 50 commits of the branch, read-only.
- **Asked first:** a commit while tabs of the vault are unsaved (commit
  anyway / save all and commit); a commit that would include staged
  files outside the vault folder. Switching the branch and pulling are
  refused while the vault has unsaved tabs.
- **Changed — frontmatter on save:** a save now updates `updated:` only
  in a note that already has it and never adds a field (it used to add
  `updated:` and a missing `created:` to every note with a frontmatter
  block). Pages of another tool — mkdocs, Obsidian — are saved as they
  are. New daily and chat notes still get their dates when created.
- Plugin SDK 1.17: `api.ui.setFileDecorations`, `api.ui.showDiff`,
  `ctx.vault.announceChanges`.
- Not in this version: clone, stash, merge / rebase surfaces, staging
  parts of a file, amend. `chats/`, `.drafts/` and daily notes are
  created in the active vault only — keep a documentation repository
  from being the active vault.
- Checked by: parser spec (`plugin-git-status.spec.ts`), decoration
  service and Files-panel specs, note-manager / frontmatter specs, and
  a run of the built plugin against real temporary repositories (status
  in a root and a subfolder vault, stage / unstage, discard, commit,
  push, branch create / switch, fetch, pull), and `e2e/git.spec.ts` in
  the built app (status in panel and tree, compare, stage all, commit,
  history, create a branch). Push / pull against a real remote and the
  branch switch with open tabs were not driven through the UI.

### Files panel — "Open in new tab" pins the tab

- **The row context menu gained "Open in new tab"** (files only). It
  opens the file and pins it in the same step (`openFile`'s new
  `pinned` option, all three open paths: text, image, PDF) — a pinned
  tab is never the tab the next plain file-open replaces, so a
  reference note you right-clicked open *stays*. On an already-open
  file the row reveals it and pins it. The pin is the tab bar's own
  (milestone 35): shown as the pin glyph, removable via "Unpin tab",
  and it rides the session snapshot across restarts.

### Milestone 64 — draw.io diagrams (req-19)

([ADR-0064](../docs/09_architecture_decisions/0064-drawio-diagrams.md))

- **Diagrams open and are edited in Drey.** A `.drawio.svg`,
  `.drawio.png` or `.drawio` file opens in a tab with the full draw.io
  editor. The editor ships with Drey and runs offline; it follows the
  app's dark or light theme.
- **A diagram file is a picture.** `.drawio.svg` and `.drawio.png` are an
  ordinary SVG / PNG with the diagram inside. A note embeds one like any
  image (`![diagram](attachments/x.drawio.svg)`), and it shows in Live
  Preview, the PDF export, on GitHub and in Obsidian without a viewer.
- **Ways in.** Right-click an embedded diagram → **Edit diagram**.
  **Insert diagram** (creates the file in `attachments/` beside the
  note, inserts the embed, opens the editor): the shapes button in the
  formatting bar, `/diagram` in the slash menu, or right-click in a
  note. File menu / command palette → **New diagram**. A diagram file
  dragged from the Files panel into a note is embedded like any image.
- **A new diagram is a visible placeholder** (a dashed frame, "Empty
  diagram") until it is first drawn. The first build wrote a 1 px
  picture, which was invisible in a note; such files, and any other
  picture of a few pixels, now get a box with room for the hover
  buttons.
- **The format of new diagrams is a setting** (Settings → Diagrams): SVG
  (default) or PNG. Existing diagrams keep their format.
- **Saved automatically** — about a second after the last change and
  when the tab closes. There is no "Unsaved" state and no exit prompt
  for diagrams.
- **The picture in the note follows.** After a save, every open note
  that shows the diagram reloads it. (This also covers any image changed
  on disk while the app knows about the change.)
- **Plugin** `drawio` ("Diagrams" in Settings → Panels & plugins). With
  it disabled the picture formats open in the image tab and `.drawio` as
  text, as before.
- **SDK 1.16**: `documents.registerFileOpener` (a plugin opens files by
  name suffix), `vault.readBinary` / `vault.writeBinary`, `announce` on
  vault writes, and `editor.registerToolbarButtons` (plugin buttons in
  the formatting bar). New icon `shapes`.
- **Build**: `npm run fetch:drawio` downloads the pinned draw.io release
  (checksum-verified, trimmed from 118 MB to 55 MB); `npm run pack` runs
  it. The web app is not in git.
- Deviation from the plan agreed for this milestone: PNG as a second
  picture format and the format setting were added on request during the
  work; binary read / write and announced writes joined the SDK because
  of them and because a plugin's write did not reach the file tree.
- Limits: keys pressed in the editor frame go to draw.io, not to Drey's
  shortcuts; no conversion between formats; a plain `.drawio` cannot be
  embedded; a diagram renamed while open shows "Diagram not found" until
  reopened; no local history for diagrams.

### Milestone 63 — MCP client, web fetch, assistant tool groups (Req-31)

([ADR-0063](../docs/09_architecture_decisions/0063-mcp-client-and-assistant-tool-groups.md))

- **The assistant can use external tools.** Settings → **Assistant
  tools** lists MCP servers you add: a local command (stdio) or a web
  address (Streamable HTTP, with headers for a key). Their tools reach
  the model as `mcp__<id>__<tool>`; a web search is any search server
  you connect. Built on the official `@modelcontextprotocol/sdk`; tools
  only (no resources, prompts, OAuth). The page shows each server's
  state, its tools, and a Reconnect.
- **Built-in `web_fetch`.** Reads one web page by address and returns it
  as Markdown. Off by default; it does not search.
- **Calls that leave the computer are asked for.** Each server — and web
  fetch — is set to *Ask every time* (default) or *Allow without
  asking*. The question shows the service, the tool and exactly what
  would be sent: Allow / Always allow / Deny. The prompt tells the model
  not to put note text into such calls and to treat results as
  untrusted.
- **One switch per tool group.** Vault (`vault_search` / `_read` /
  `_write`), Tasks (`tasks_list`), Templates (`template_*`), Web fetch
  and each server have their own switch. The writing groups have a
  write rule — *show the change and ask first* or *write without
  asking*; defaults as before (notes ask, templates do not).
- **Changed:** the assistant's vault tools no longer hang on Settings →
  MCP. That page now only governs the server Drey offers to other
  programs, and its YOLO switch only affects MCP clients. Existing
  settings carry over: if the MCP server was on, the Vault group is on;
  if YOLO was on, the Vault group writes without asking.
- **Drey's own MCP server now runs on the SDK as well.** Same address,
  same bridge configuration, same tools. The protocol version is
  negotiated with the client instead of fixed, and the localhost
  endpoint no longer answers web pages: it used to accept requests from
  any origin, so with the endpoint on a page in your browser could have
  searched and read the vault. Requests must now come from this
  computer and not from a foreign page.
- **Plugin SDK 1.15:** `ctx.llm.chat({ externalTools })`,
  `ctx.vault.confirmWrite`.
- **Not covered:** OAuth-protected servers; a per-question tools switch;
  external tools in live edit and in Actions; the CLI providers (they
  run no Drey-side tools).
- Specs: config migration + server normalisation, the client manager,
  the toolbox's approval rule, web fetch, the approval queue, the
  engine's group gating, the template confirm rule, the vault write
  rule per caller. Verified once against the real SDK with a stdio test
  server (connect, list, call, dispose).

### Fix — Files panel: "Open in Terminal" now opens a window on Windows

- **The terminal appears.** The row context menu's "Open in Terminal"
  spawned `cmd /K` detached — on Windows that creates the child with
  `DETACHED_PROCESS`, which means *no console of its own*, so cmd ran
  invisibly and nothing happened. Windows now tries **Windows Terminal**
  (`wt.exe -d <folder>`, what the Win11 Explorer entry opens) and falls
  back to `cmd /c start "" cmd`, which gets its window through `start`.
  Everything still spawns by arg array with `cwd` — the path is never
  interpolated into a shell string. macOS and Linux keep their launchers,
  but all platforms now detect a failed spawn (`error` event) instead of
  letting it surface as an unhandled error in main; a failure shows in
  the panel like every other vault error.

### Milestone 62 — splash window with logo + progress

([ADR-0062](../docs/09_architecture_decisions/0062-splash-window.md))

- **A splash window now covers the startup.** A small frameless,
  taskbar-less window (~400×300, dark) appears as the first thing after
  Electron is ready: the About-page logo mark, the "drey" wordmark, the
  version, a thin progress bar and a sentence-case activity line. It is
  dependency-free (`public/splash.html`, inline CSS/JS + a micro-preload
  with `contextIsolation` on) so it paints immediately — no Angular, no
  bundle.
- **The bar states what is happening**: `Starting…` → `Loading settings`
  → `Loading plugin Tags` … (one step per main-side plugin, manifest
  name) → `Starting the interface` (main), then `Preparing workspace` →
  `Restoring session…` (renderer, over the new fire-and-forget
  `startup:progress` channel). Determinate by stages, short CSS
  transition, no fake animation.
- **Hidden-until-ready handover.** The main window is created hidden and
  only shown when the renderer reports ready (`startup:ready`, after
  plugins + first paint + session restore + daily-note fallback): splash
  → painted app, no blank dark frame at any point. The splash closes
  ~120 ms after the show. Warm-measured handover: ~0.6 s after process
  start; a Defender-scanned cold start shows the live splash for as
  long as the scan takes.
- **Fail-opens.** The splash can never trap the app: 30 s absolute and
  15 s after-page-load timers hand over with a log line;
  `render-process-gone` hands over; a closed main window and app quit
  close the splash; macOS `activate` checks `mainWindow` (the splash is
  also a window). Reloads re-send `ready` — ignored (one-shot).
- **E2e.** The Playwright fixtures pick the `app://` window by URL (the
  splash is window #1 now) and wait for shown+focus (input dispatched
  into the visibility-flip-to-mapping gap is dropped by Chromium —
  found by a now-flaky `Ctrl+B` dock-fold test); new `splash.spec.ts`
  asserts splash content and the handover with its own launch. New
  `[startup]` mark: `workspace ready — main window shown, splash
  closing`.

### Milestone 61 — startup analysis + window-first boot

([ADR-0061](../docs/09_architecture_decisions/0061-window-first-startup.md))

- **What was slow.** The boot was fully serial: main activated every
  plugin and synced MCP/watcher **before creating the window** (blank
  taskbar the whole time), the renderer then activated ten plugin
  modules **one protocol round trip each** before Angular painted
  anything, session restore read each tab's file one IPC round trip at
  a time, and the boot ran the full-vault index round **twice** (main's
  own + the renderer's `vault:refresh`), three full vault re-reads
  (tags/tasks/backlinks) contending with the very file serving the boot
  needed. The irreducible floor is process spawn + Defender's scan of a
  freshly built exe (~3–9 s, one 28 s outlier in the measurements).
- **Window-first with a gate.** The window is created right after
  protocols/IPC registration; plugin discovery+activation runs while the
  renderer parses its bundle. The handlers that expose plugin-owned
  state (`plugins:list`, `plugin:invoke`, `search:vocabulary` /
  `tags:suggest`, `vault:refresh`) `await activationDone()` — the
  renderer can never see a half-activated host. `onMainWindowCreated`
  replays the existing window to plugins that activate late.
- **Parallel loads.** All `plugin://` renderer modules are prefetched
  with `Promise.all`, then activated in descriptor order (registration
  order stays deterministic) — measured 66–70 ms total, was the biggest
  renderer-side serial chunk.
- **One boot index round.** Main's own boot `emitVaultChange(refresh)`
  is gone — the renderer's boot refresh (now gated on activation) runs
  the identical announcer round exactly once.
- **Parallel session restore.** All `readVaultFile` / `readSessionBackup`
  calls fire concurrently and apply in order (`openFile` takes a
  `prefetched` result; a failed prefetch falls back to the old path).
- **Instrumentation + tooling.** `[startup]` timing lines in
  `drey.log` (main: ready → window → per-plugin ms → complete; renderer:
  bundle evaluated → plugins loaded → shell painted → session
  restored), `scripts/measure-startup.mjs` (Playwright over the
  packaged exe, wall-clock to titlebar), `favicon.ico` 370 KB → 15 KB.
  Custom-scheme serving centralized in `electron/protocol-cache.ts`
  (streaming + ETag/304 + `codeCache` privilege — measured as a no-op
  on this machine, kept as correct forward-looking plumbing).
- **Warm start, measured**: ~665 ms to titlebar (was ~680–700 ms on the
  same fast dev machine; the structural wins grow with slower disks,
  more plugins/tabs and OneDrive contention). The perceived remainder —
  the Defender-scanned cold start and the sub-second warm blank — is
  milestone 62's splash window with logo + progress.
- **Fix along the way:** `e2e/assistant.spec.ts` asserted the
  frame-header status milestone 57e deliberately removed (pre-existing
  failure, verified against the unmodified tree); it now asserts the
  panel's chat label.

### Milestone 60 — save conflicts are asked; local note history

([ADR-0060](../docs/09_architecture_decisions/0060-save-conflicts-and-local-note-history.md))

- **60a · A dirty tab no longer overwrites an external change silently.**
  Every save tells main which state of the file the tab edited
  (`baseModifiedMs`); when the file on disk is a different one, nothing
  is written and a **merge view** opens: *On disk* | *Result* | *Your
  version*, block by block. Each differing block takes the disk side,
  mine, both (disk's lines, then mine) or neither; "Take all" per
  column; the Result column is editable throughout for own text. Blocks
  only one side changed since the tab read the file are preselected from
  that side, blocks both changed are flagged. Works with the watcher off. A file whose timestamp moved but whose text did not (a
  sync client touching it) is saved without a question. Raised by "Save
  all" on quit, Cancel also keeps the app open.
- **"Changed on disk" with the watcher on.** A dirty tab whose file
  changes is marked in the meta bar; the button opens the same dialog
  before any save. Chat notes keep following the disk.
- **60b · Local note history.** Before a note is overwritten — by a
  save, the assistant (live edit, applied rewrites, template tools), an
  MCP client, replace-all, the tag rename or a link update — its previous
  text is kept under `<userData>/history/`, outside the vault. The
  user's own saves record at most one version per note per five minutes,
  every other writer each time. The version a conflict or a restore
  discards, and the previous text of a tab the watcher reloads, are kept
  too. Chat notes, `.drafts/`, attachments and notes over 2 MB are not
  versioned. A rename or move keeps the history with the note.
- **File history…** in the editor `⋯` menu, the tab context menu and the
  command palette: the versions with what replaced them, the selected one
  diffed against the editor, **Restore this version** (into the editor,
  one undo step — nothing is written until the next save).
- **Settings → Vault:** "Keep a local history of notes" (default on) and
  the retention in days (default 30; at most 50 versions per note).
- **Under the hood:** the line diff of the ADR-0011 dialog is now the
  shared `DiffView`; `VaultManager.writeFile` takes the writer's
  `origin`. Specs: history store, the save guard, the conflict flow,
  the merge model, the history service.
- **Not covered:** external (out-of-vault) tabs; a file changed while the
  app was closed under a tab restored with unsaved edits; browsing the
  history of a deleted note; automatic merging and word-level highlighting
  inside a block.

### Milestone 59 — links survive a rename; quick switcher + command palette

- **59a · Renaming or moving keeps links intact**
  ([ADR-0059](../docs/09_architecture_decisions/0059-link-integrity-on-rename.md)).
  A rename / move in the Files panel (inline rename, drag & drop, folders
  included) now plans what it would break and repairs it: `[[wikilinks]]`
  to a renamed note follow (anchor, alias and embed `!` kept), a moved
  note keeps `[[Note]]` while the name is unique and only path-form links
  change, and references to a renamed attachment follow too. The rule is
  "what did this reference open before, and does the same text still open
  it after" — only references whose answer changes are rewritten; code
  and frontmatter are never touched.
- **Attachments travel with their note.** When a note changes folder, a
  file it references relative to itself (`![](attachments/x.png)`,
  `![[x.png]]`, `[doc](<attachments/a.pdf>)`, `<img src>`) and that no
  other note uses moves along, link text unchanged; an emptied
  `attachments/` folder is removed. A shared file stays and the moved
  note's link is rewritten to a relative path. Across vaults the
  exclusive file moves and a shared one is copied (wikilinks stay
  vault-scoped, ADR-0051). Nothing is overwritten.
- **Ask / always / never** — new `vault.updateLinksOnRename` (Settings →
  Vault, default *ask*): a dialog lists the affected notes with their
  changed lines and the attachments that go along — *Update links*,
  *Rename only*, *Cancel*, "Don't ask again". No dialog when nothing is
  affected. Dirty open notes are patched in the buffer, not on disk.
- **Base-owned, deviating from the roadmap wording** ("through the
  backlinks index"): link integrity must not depend on an optional
  plugin, and the rewrite reads every file fresh anyway. Grammar +
  resolver moved to `shared/wikilinks.ts` (one definition for renderer
  and main); planner `shared/link-rewrite.ts`, executor
  `electron/link-rewriter.ts`, IPC `vault:rename-preview` /
  `vault:rename-with-links`, renderer `src/app/link-update/`.
- **59b · Quick switcher + command palette** (`src/app/palette/`): one
  overlay. `Ctrl+P` lists the files of every vault, fuzzy-matched on
  name then path, the documents visited this session first (so
  `Ctrl+P`, Enter flips back); Enter opens, `Ctrl+Enter` opens beside
  the current tab, and a query without a match offers "Create note".
  A leading `>` — or `Ctrl+Shift+P` — lists every registered command
  with its shortcut (plugin commands included). View menu rows "Go to
  file…" / "Command palette…".
- **New commands** so the palette can reach them: `settings.open`
  (`Ctrl+,` — the File menu printed that hint without a binding
  behind it), `layout.reset`, `vault.refresh`, `daily.today`,
  `editor.toggleSource`, `note.exportPdf`.
- Not covered (ADR-0059): renames made outside the app, links into a
  note moved to another vault, heading-anchor renames.

### Milestone 58 — the assistant manages the template library (SDK 1.14)

- **The agent can create templates.** Four new chat tools —
  `template_list`, `template_read`, `template_write`, `template_delete`
  (`plugins/assistant/main/template-tools.ts`, the `tasks-tool` shape) —
  work directly on the vault's template library (the configured
  `templates.dir`, active vault). `template_write` requires an explicit
  `overwrite` flag (create-only by default), subfolder names become
  Templates-panel categories, and `{{date}}` / `{{time}}` /
  `{{datetime}}` / `{{title}}` placeholders are documented to the model.
  The tools ride every non-live ask, independent of `mcp.enabled`;
  live-edit turns are untouched.
- **Guard rails, deterministic**: `..`/absolute path escapes refused,
  the top-level `prompts/` subfolder reserved (composer prompt picker's
  format), `daily.md` refused on delete (daily-note seed; overwrite
  stays allowed). Errors return as tool-result text, never throw.
- **No confirmation (ADR-0011 later-change):** templates are small
  structural content outside the tag index. Writes ride
  `writeAnnounced`, deletes the milestone-52 recycle-bin path — both
  announced, so the Templates panel, the slash menu and Mod+T update on
  the same `vault:changed` round with zero changes in the templates
  plugin.
- **New base seam** `ctx.vault.delete(path, opts?)` (SDK minor → 14):
  `VaultManager.deleteEntry` (escape guard, own-write ledger, assistant
  sidecar) + the announcer's `deletedPaths` push; resolves whether the
  target landed in the bin.

### Search — "Include chats" toggle

- A speech-bubble button next to the Search panel's scope switch.
  **Behaviour change:** chat notes (`chats/`) are no longer listed in
  vault / all-vault search hits unless it is on (off by default,
  persisted in `localStorage['drey.search']`) — transcripts repeat the
  questions asked of them and crowded almost every query. Export and
  Summarize follow the visible hits; "Replace all" passes
  `excludeChats` to the replace backend so it never rewrites chat notes
  the list did not show. The document scope is unaffected (an open chat
  note stays searchable), and so is the index: MCP `vault_search`, the
  tag vocabulary and tag rename still cover chats. New icon
  `message-circle`.

### Milestone 57 — the assistant as the task & navigation surface (ADR-0058)

- **Task answers become actionable.** The assistant gained a
  `tasks_list` tool over a new base seam (SDK 1.11: `ctx.tasks` +
  `TaskQueryProvider`, single-slot like section search): the tasks plugin
  registers its index and stays the sole owner of the line grammar; the
  tool rides every non-live ask (no MCP gate, tool-capable providers
  only) and answers task questions from real index rows as one JSON line
  per task. The model never quotes task lines from retrieval snippets
  any more.
- **The interactive task block.** A `tasks_list` call/result pair renders
  in the turn card as a task list instead of raw chips: checkbox, text,
  priority glyph, due badge (overdue/today colored), row click opens the
  note at the line. The checkbox completes the task through the
  provider's `setDone` (announced write, staleness-resolved); the fence
  rows hydrate their live done/due state from the index at render time.
- **Clickable wikilinks + rich answers.** New `api.links` SDK surface
  (base-owned grammar + resolver — no third grammar copy): the panel's
  turn text now renders a small Markdown subset (paragraphs, lists,
  bold/italic/code) with `[[wikilinks]]` as buttons; a sync resolve probe
  styles resolved vs. unresolved, a click follows the link — creating a
  missing note, editor semantics. The ask prompt invites the model to
  reference notes as wikilinks from context paths (deviation from the
  M49 no-mint rule for prose, documented in the ADR; the deterministic
  Sources digest rule stands).
- **MCP symmetry:** `tasks_list` joins the vault tool set (read-only,
  clear degradation without a provider). Drive-by: context-cite rows now
  open at their cited line. `PLUGIN_API_VERSION` minor → 11.
- **M57c — deterministic task views, the model demoted to intent:** the
  live runs confirmed the model is a poor list builder (index order, no
  importance) but a fine intent reader. The view moved to the data
  owner: `TaskQueryOptions` gains `sort`/`text`/`tag`/`overdue` (SDK
  1.12), implemented by the tasks plugin over the SAME comparators and
  matchers its panel uses (`shared/tasks.ts`) — the Tasks panel, the
  assistant block and MCP share one view semantics. The `tasks_list`
  tool takes the intent args; the ask prompt tells the model to express
  the question's restriction there; its prose stays a brief highlight.
  `importance` (the assistant's default order) is due-ascending first
  (overdue leads), priority within the undated rest, path/line last.
  The post-hoc block stays the unfiltered importance-sorted safety net.
  The panel renders the filter as head chips and a real empty state for
  a filtered no-hit result; MCP passes the same args through but keeps
  the provider's file-order default when `sort` is absent.
- **M57e — model-named chats + the active chat in the head:** a
  brand-new chat's title comes from a tiny background naming call
  (same model, no tools — question + answer snippet; sanitized, capped
  at 60 chars; failures keep the question placeholder, the ask never
  waits). ChatStore writes are serialized per note so a late title
  write cannot revert a meanwhile-landed turn. The panel head shows the
  active chat's title as a muted label next to the "+" (live from the
  chat list — the old frame `status()` was stale by design).
- **M57c — the implicit chat-follow is gone:** the "a bound note opens
  its newest bound chat" rule silently yanked the panel to the newest
  match when several chats shared a title, and every day/meeting switch
  flapped the panel. The only implicit switch left is a focused chat-note
  tab (opening a chat's Markdown from the vault hydrates the panel);
  every other focus keeps exactly the current chat, app start still
  loads the newest conversation once, and `note:` stays as provenance +
  the picker's "this note" marker only (ADR-0048 later change).
- **M57c — icon-only assistant head:** the chat-title text left the
  panel head (stale on a switch, and the picker it opened lists the
  chats anyway) — the head is now the chat-list button + the "+" new
  chat icon. The frame-header `status()` (the chat title right of
  "Assistant") went with it: it recomputed only on shell change
  detection — late and wrong after a switch — and said nothing the
  picker doesn't.
- **M57c live fix — the block is answer-scoped:** the 9B model called
  `tasks_list` with `{}` on restricted questions, so everything was
  listed. The intent prompt + tool description now carry few-shot
  examples (person → `text`, `#tag` → `tag`, overdue → `overdue`), and
  the engine scopes the persisted result to the answer deterministically:
  the post-hoc pair carries the matched subset, an unrestricted call's
  result is trimmed to it (restricted calls, whole-set and zero-match
  answers untouched).
- **M57c — daily notes never bind:** switching daily notes yanked the
  panel to each day's leftover chat. A note under the configured daily
  root now behaves like a chat-note tab for binding: asks under daily
  focus leave the chat unbound, focusing a daily note never triggers the
  bound-chat follow (ADR-0048 later change; the context chip still
  rides, old daily-bound chats stay picker-reachable).
- **M57b — the answer-anchored task block:** the model's tool call
  proved unreliable (one run called `tasks_list`, the next summarized
  from Vault-chip retrieval with no block), and question keywords were
  rejected as language-dependent. The trigger now lives in the ANSWER:
  the engine matches the settled answer against the live task index
  (normalized word overlap, language-independent — models quote task
  titles verbatim) and, on a match, persists the FULL open task set as a
  synthetic `tasks_list` pair after any real tool-trace entries. The
  interactive block is therefore guaranteed whenever an answer is about
  tasks; model calls remain welcome and suppress the synthetic pair;
  follow-ups replay it as the model's own tool result. The prompt asks
  for a brief highlight instead of a full prose repeat; the paired
  result chip no longer renders under the block.
- **M57a follow-ups from the first live test:** the meeting import's
  text-form metadata (`due: YYYY-MM-DD` / `done: YYYY-MM-DD`) now parses
  into the record like the emoji tokens (read compat — the write format
  stays `📅`), so due badges, overdue coloring and due sorting work for
  the whole existing vault; answer prose linkifies `.md` path mentions
  deterministically (resolved → clickable, unresolved stays text —
  robust against models that ignore the wikilink prompt); the ask prompt
  asks for a one/two-sentence summary after `tasks_list` instead of a
  prose repeat of the list; turn rendering is defensive (a broken turn
  becomes an error card instead of a blank thread) and a skipped
  `tasks_list` result logs its reason to the console.
- Tests: task provider (query scoping, setDone incl. shifted-line
  resolution and the tag-kind toggle), engine tool flow (attach, prompt
  note, fence persistence), MCP `tasks_list`, `api.links` impl via the
  rich-text renderer (formatting parser, lists, link styling + open
  calls), scanner text-metadata cases, path-linkify cases. Docs:
  ADR-0058, AUTHORING (1.11), CLAUDE.md.

- **M57d — done tasks, completion dates, the edit guard:** a beta chat
  asked "which tasks were completed recently", got an answer quoted from
  vault context plus "I would have to query with `includeDone: true`",
  and the follow-up "ja dann mach das" turned into a change proposal for
  the daily note. Fixes: completing a task now stamps an
  Obsidian-Tasks-compatible `✅ YYYY-MM-DD` on the line and reopening
  removes it (panel row, assistant block, `Ctrl+Enter`, Live Preview
  checkbox click — **a format change**, see `specs/frontmatter-schema.md`
  and ADR-0033); `TaskQueryOptions` gains `status` / `completedSince` /
  the `completed` sort (SDK minor → 13) and both `tasks_list` tools take
  them; the ask prompt gets done-task few-shots, today's date and the
  task rule after the vault context; the Change form is limited to an
  explicit edit request and the engine rejects a `document` fence that
  changes nothing or rides a task-lookup turn; short tasks (two or three
  significant words) can match an answer, so they get their block.
  Not done: a file-mtime fallback for tasks completed before this change
  (the index holds no stat data) — those fall back to the date in the
  note's file name, else sort last.

### Milestone 56 — the assistant panel keeps its chat

- **Root cause found (56a):** the chat store consumed the **tree**-shaped
  `ctx.vault.list()` as if flat — top-level filter only, and `chats/`'s
  top level holds only directories. Picker, chat-follow and path-uniquing
  were dead since the ADR-0048 milestone (writes always worked; the spec
  harness fed a flat fake list and masked it). Markdown consumers now use
  the flat `ctx.vault.listMarkdownFiles()` (same as tags/tasks/backlinks);
  `chat:attachExternal` flattens the tree locally; the picker re-renders
  while open, and a failed list reads "Chats could not be listed." rather
  than "No chats yet".
- **The panel no longer resets away.** Beta feedback read as "chats are
  not saved": the chat notes were on disk, but every restart or tab
  switch to a document without an exact `note:` match came back as an
  empty fresh chat, so conversations felt gone and the same question
  produced duplicate chat files. Follow rules revised (ADR-0048 later
  change): a focused **chat-note tab** opens that chat in the panel; a
  note without a bound chat and every non-note focus **keep the current
  chat**; the **first follow at activation continues the newest chat**
  (startup shows the last conversation, a bound chat still wins on its
  restored document). Only the picker and "+ New chat" start fresh.
- **`note:` bindings never point into `chats/`** — asking with a chat
  tab focused continues that chat (or creates an unbound one) instead of
  chaining chat → chat; the note chip still attaches it as context.
- **Visibility hardening:** `listChats` logs skipped (vanished/
  unreadable) chat files via `ctx.log` instead of thinning the picker
  silently; a fenceless (corrupted) chat file still lists, with its path
  as the fallback title.
- Tests: `plugin-assistant-state.spec.ts` (follow semantics, chat-tab
  focus, startup fallback, unbound asks with a focused chat) and
  `plugin-assistant-chat-store.spec.ts` (corrupt-tolerant listing, skip
  logging).

### Milestone 55 — document history back/forward

- **`DocHistoryService`** (`src/app/services/doc-history.service.ts`,
  new): one global, session-scoped history of the viewed documents — the
  VS Code model over any number of panes, browser truncation of the
  forward branch, a circular buffer of 100, purely in-memory (nothing
  rides into the session snapshot).
- **Surfaces:** the titlebar's back/forward arrows (right of the menu
  bar), View-menu rows and `doc.back` / `doc.forward` (`Alt+Left` /
  `Alt+Right`).
- Closed vault/external documents **reopen** (`keepFocused`, never a
  clean-tab replace); unrestorable entries (scratch tabs, plugin doc
  kinds) prune lazily. Recording suspends across the startup restore and
  resuming seeds the landed-on document; caret/scroll restore rides the
  milestone-50 memory.
- Docs: `docs/05` §5.30, `docs/06` §6.47.

### Milestone 54 — the Backlinks panel (req-39)

- **`plugins/backlinks/`** (new): a per-vault **outlink index** — every
  `.md` file's parsed `[[wikilink]]` occurrences — kept fresh through the
  save-hook and vault-change registries exactly like the tags/tasks
  indexes (coalesced boot sweep, incremental re-index per save/write,
  drop per delete, rebuild on renames/registry rounds).
- **The Backlinks dock panel** follows the focused vault note like
  Outline: every note whose wikilink resolves TO it, one row per
  occurrence — file, section heading, the linking line — and a click
  opens the linking note at the line (vault-aware through the document
  API). Lands collapsed at the bottom of the left dock; the header shows
  the count; empty states for notes nobody links to and non-note tabs.
- **Resolution is the parity twin of the base wikilink service**
  (`shared/link-index.ts`): path targets (`/` or extension, `.md`
  appended), bare-name targets by basename, sibling preference and
  shortest-path tie-break on ambiguity — a link counts as a backlink of
  exactly the note the editor's Ctrl-click would open. The link grammar
  (`shared/link-targets.ts`) is a verbatim twin of the base WIKILINK
  regex (alias, `#anchor`, embeds `![[…]]` count; frontmatter, fences
  and inline code never yield links). Resolution happens at query time
  against the current file list, so renames/new files reshape the
  backlinks without re-reading every note.
- Known v1 limits: same-vault only (no cross-vault inlinks), `.md` files
  only (`listMarkdownFiles` — same base the tag index scans), and
  unsaved buffers don't count (a freshly typed link appears after its
  save; a note's own links never affect its backlinks anyway).
- Tests: 12 spec cases (`plugins/backlinks/shared/backlinks.spec.ts` —
  grammar parity, resolution parity incl. ambiguity, query semantics)
  and one e2e (`e2e/backlinks.spec.ts`: rows appear, row click opens at
  the line, empty state).

### Milestone 53 — tag rename / merge (req-38)

- **Settings → Tags gained the tag list with Rename/Merge.** Every
  vault's vocabulary merged into one filterable list (chip in its
  resolved color, section count); "Rename…" opens a modal over the
  same preview/apply discipline the Search panel's vault replace uses:
  bundled per-file-diff confirmation, TOCTOU re-read + re-patch before
  every write, CRLF preserved, announced writes. When several vaults
  carry the tag they are individually selectable (all on by default).
- **A grammar-faithful rename, not a text replace.**
  `plugins/tags/shared/rename.ts` walks the same `extractTagOccurrences`
  the index uses: fenced and inline code, URL fragments and
  `#oldnet`-style near-names are never touched. Nested `#old/…` tags
  come along by default (tails keep their spelling, switchable in the
  modal); renaming INTO the reserved `task` root is rejected.
- **Merge semantics.** When the target tag already exists, the modal
  says "Merge", and a duplicate the merge would create on a line
  (`#old #new` → `#new`) is dropped — pre-existing duplicates stay.
- Backend: `tag-list` (vaults + per-vault vocabularies),
  `rename-preview` / `rename-apply` (`TagIndex.vocabularyFor`,
  `isIndexExcludedPath` now exported and shared with the index itself —
  templates folders are skipped like the index skips them). Both plugin
  modals (replace + rename) share styled action buttons now (the
  confirm dialog's recipe — they were unstyled before).
- The tag-sprawl risk in the roadmap is addressed (consolidation now
  possible); near-duplicate *detection* stays out of scope.
  ADR-0017 gained a "Later change" note; 13 new spec cases in
  `plugins/tags/shared/rename.spec.ts` plus two e2e specs (rename across
  the vault, merge dedupe — `e2e/search.spec.ts`).

### Milestone 52 — deletes go to the OS recycle bin

- **Explicit deletes are undoable.** The Files panel's "Delete" (single
  and multi-select, bug-8) moves the target — and a `.md` note's
  `.{name}.chat.json` sidecar — to the OS recycle bin via
  `shell.trashItem`; the confirm dialog now reads "will be moved to the
  recycle bin" instead of "cannot be undone".
- **Move semantics stay permanent.** A Save-as out of `.drafts/` deletes
  the draft original with `{ trash: false }`, and the cross-vault move's
  delete leg inside `renameEntry` keeps its plain `fsp.rm` — the content
  already lives at the target, a bin copy would only litter.
- **Volumes without a recycle bin** (network shares, some removable
  drives) fall back to the permanent delete instead of failing the delete:
  `vault:delete` / `vault:delete-many` resolve to the fallback paths and
  the Files panel messages the user ("could not be moved to the recycle
  bin and was deleted permanently").
- `electron/trash-delete.ts` holds the disposition (injected
  `trashItem`/`rm` IO — `shell` only exists inside a running Electron),
  covered by `electron/trash-delete.spec.ts`; the out-of-Angular vitest
  config now also runs `electron/**/*.spec.ts`.
- Docs: runtime view §6.20 gained the delete flow; docs/05's IPC table
  and VaultManager block updated.

### Milestone 51 — task due dates + priorities (req-37)

- **Task lines carry inline metadata, Obsidian-Tasks compatible.** A due
  date (`📅 2026-10-09`, ISO) and a priority (`🔺` highest, `⏫` high,
  `🔽` low; none = normal) may sit anywhere on a checkbox or `#task` line.
  The tokens are human-legible annotations, not machine ids (ADR-0033's
  `#task/id:` rejection stands), and they are parsed + stripped by the
  shared scanner (`plugins/tasks/shared/tasks.ts`): `TaskRecord` gains
  `due: string | null` and `priority`, and `text` stays clean — so a
  metadata edit never disturbs `resolveTaskLine`'s text+kind matching, and
  a vault stays readable/writable by Obsidian's Tasks plugin. New pure
  setters `setDueOnLine` / `setPriorityOnLine` (append-or-replace, guarded
  to task lines, indentation-safe) round-trip through the scan.
- **The Tasks panel shows both and can sort by them.** Rows carry a due
  badge (overdue red, today accented, future neutral) and the priority
  glyph; a new sort cycle in the filter row — file order → due date
  (ascending, undated last) → priority (highest > high > normal > low,
  ties by path + line) — persists in `localStorage['drey.tasks']`. The
  file sort keeps the grouped-by-file view; due/priority sorts show a
  flat list (grouping would fight the ordering), in every scope.
- **Editor completion with a date picker.** On a task line (never in
  frontmatter or a fence), typing `due` / `fällig` offers Today /
  Tomorrow / In a week / **Pick a date…** — the last opens a
  caret-anchored popover with a native `<input type="date">` defaulting
  to today that writes the token over the trigger word — plus "Remove
  due date" when one exists; `prio` / `priority` offers the three glyph
  levels and "Normal (remove priority)". The source rides the host's
  markdown language data (the same seam as tag / wikilink / word
  completion, so popups merge) as a plugin editor extension
  (`plugins/tasks/renderer/task-meta.ts`). Completion options ship with
  `filter: false` — CM's label fuzzy-matcher would otherwise drop the
  emoji-prefixed labels ("📅 Today" vs "due"); the whole-word trigger is
  the filter.
- **Click-to-change (req-37 add-on).** The tokens are decorated as chips
  in the editor (`cm-task-due` / `cm-task-prio`, overdue/today colored
  like the panel badges) and a **plain click** on a chip re-opens its
  picker in place — the date picker with the current date prefilled
  (Apply replaces the token, a cleared field removes it) or the glyph
  menu (🔺/⏫/🔽/Normal). The Tasks panel's due/priority badges are
  buttons with the same pickers; both surfaces share one picker
  implementation (anchor + `onCommit`), and panel commits go through the
  shared `applyToTaskLine` routing (open buffer → `setBuffer` + save,
  closed file → read/patch/write + index refresh) — the same path the
  done toggle uses. The row meta moved beside (not inside) the body
  button: a button in a button is invalid HTML and would bubble into the
  open-file action. Click hit-testing is by the token's screen width
  (`coordsAtPos` bounds), not the caret position: a click on the token
  (its right half included) opens the picker, a click beside it — even
  the trailing whitespace behind a line-ending token — places the caret
  normally; the date popover opens the native calendar once on mount
  (one-shot retry on first field interaction), never re-opening by
  itself after a date was chosen.
- Docs: `specs/frontmatter-schema.md` records the line format,
  [ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md)
  gained a "later change" note.

### Milestone 50 — the caret survives a tab switch

- **Switching back to an open tab restores the cursor — the exact
  viewport, and focus.** Every fresh editor state built for a tab switch
  (or a recreated pane) now replays the remembered caret AND the
  remembered scroll offset instead of landing at the top, and entering a
  tab puts the caret INTO the document: typing works immediately,
  without a click into the editor first (a pane's first load — app
  start, session restore — keeps the old no-focus behavior). The exact
  flow the milestone-49 Sources links exposed: follow a link, switch
  away, come back, and the document sits where you left it, ready to
  type.
- **The memory outlives the tab.** Caret and scroll offset are stored
  per doc key for the whole app session — deliberately decoupled from
  the doc records, because a *clean* tab is REPLACED when another file
  opens (milestone 32): reopening such a tab (file tree, Files panel,
  another link) restores its viewport too. Strictly in-memory (nothing
  rides into the session snapshot, a restart starts without carets),
  bounded FIFO past 200 doc keys.
- **The restore applies whenever a memory exists — never gated on the
  caret's offset.** A caret that never left offset 0 (open a document,
  only scroll) used to skip the restore entirely: the `anchor > 0` gate
  confused "no memory" with "memory with head 0", and `loadDocument`'s
  show-the-top reset made it worse. The gate is now "memory exists",
  and the top-reset is skipped (`keepScroll`) whenever a viewport is
  about to be restored — which also fixes the replace/reopen cycle
  (a fresh-opened, never-clicked clean tab replaced by another file
  reopens on its remembered scroll position).
- **Saving keeps the viewport too.** Every save of a frontmattered note
  rewrites the fence (the `updated:` bump) — the renderer adopts the new
  text and reloads the SAME tab in place, and that full replace discards
  CodeMirror's height map: holding the numeric scroll offset alone let
  the browser clamp the scroller (block widgets collapse the height
  estimates) and the view landed at the top. The in-place reload now
  captures the viewport before the swap and replays it through the same
  restore chain a tab switch uses — unless the view is pinned to the
  bottom, where stick-to-bottom stays the destination (the streamed
  search summary keeps following the tail; the same goes for
  non-pinned live-edit pushes, which now hold the position cleanly
  instead of drifting).
- **The scroll restore re-asserts the stored offset.** Two production
  findings shaped it (both invisible in jsdom, both pinned by the new
  Playwright spec `caret-scroll-restore` against the real Electron
  app): focusing the freshly swapped editor makes the BROWSER scroll
  the caret into view — possibly after the restore's first frame — and
  a fresh editor state starts with every block height ESTIMATED
  (CodeMirror's `HeightMap` begins empty), so a raw pixel offset alone
  lands a few lines off in content space. The chain therefore applies
  the raw offset, then RE-ASSERTS it one frame later (the stored value
  is the last word, never a scroll-to-caret), with a strictly gated
  caret-anchored correction on top (capture records the caret's
  viewport-relative position when rendered; the correction only runs
  when the caret is inside `visibleRanges` and the delta is
  sub-viewport — every failure degrades to the raw offset).
- **Explicit jumps still win.** An `openFileAt` reveal (a wikilink's
  heading line, a search hit, a tasks row) runs after the restore,
  CANCELS the scroll restore and moves the caret to its target; a stale
  caret past a shrunken buffer is clamped to the document length. Undo
  history still resets per tab switch (ADR-0003 unchanged);
  multi-cursor selections collapse to the main caret
  (ADR-0037 later-change note).

### Milestone 49 — search summary: Sources links (wikilinks from the digest)

- **The digest ends in a `## Sources` list.** After the model's reply
  settles (or the user stops it), the Search panel appends one line per
  section the prompt actually covered — same order, same whole-section
  budget cut as the material — each carrying a `[[wikilink]]` to that
  section plus the exact `path:line` as plain text (wikilinks have no
  line anchor). Deterministic by design: the model never mints links —
  anchors must match a real heading, and heading-less sections cannot be
  anchored at all. When the hits span several vaults, the label carries
  the vault's name as a prefix.
- **Wikilinks work from vault-less scratch tabs.** A `[[link]]` in the
  `search-summary.md` scratch tab (no vault of its own) previously
  resolved against an empty index — Ctrl-click fell through to "create
  note in the active vault". Vault-less documents now resolve through a
  merged index over every registered vault (the active vault wins path
  collisions and basename ambiguities), open the target in its OWNING
  vault, and never create notes — an unresolved link is reported, like
  the entry drawer's no-mint rule (ADR-0046 addendum). Known limit: the
  link syntax cannot name a vault, so the same relative path in two
  vaults lands in the active one; the label's vault name is the only
  disambiguator.

### Fix — editor: a table-only document can be left again

- **ArrowDown opens the line below a document-ending table.** When the
  table was the note's last block, every caret position sat inside its
  revealed raw source and Enter only ever added rows — the view could not
  be left to type a following paragraph without switching to source mode
  (the extent's end IS the document end, so no position "behind" the table
  existed). ArrowDown on the last real row now appends one blank line and
  parks the caret there; the widget snaps shut. ArrowUp mirrors it when
  the table starts the document at line 1. Everywhere else the arrows keep
  their normal motion, and Enter keeps growing the table.

### Milestone 48 — Full screen (F11)

- **F11 toggles OS fullscreen.** The new `window.toggleFullScreen` command
  carries the keybinding; View → "Full screen" runs the same id and shows a
  check mark that tracks the real window state via the
  `window:fullscreen-changed` push — correct even when fullscreen is left
  by another route (Esc, the OS).
- **The key stays renderer-owned.** The auto-hidden native menu's
  `togglefullscreen` role is gone: its default F11 accelerator swallowed
  the key in main before the renderer's command could see it (the same
  reason the Ctrl +/-/0 zoom items were never menu accelerators).
  Fullscreen rides the `window:toggle-fullscreen` IPC next to
  minimize/maximize/close.

### Milestone 47 — foldable side docks (titlebar toggles)

- **Fold a whole side dock away.** Two icon toggles in the titlebar — the
  left one beside the app mark, the right one before the window controls,
  each above the dock it controls — hide and show the left / right dock as
  a whole (`Ctrl+B` / `Ctrl+Alt+B`, also View → "Left dock" / "Right
  dock"). The editor takes the freed width.
- **Nothing is lost underneath.** A folded dock stays mounted, so its
  panels keep their state (a streaming chat, scroll positions, a docked
  editor); panel order, sizes and collapse state are untouched. The folded
  state persists with the layout (`foldedSides` in
  `localStorage['drey.dock']`); View → Reset layout unfolds both.
- **It opens when it is needed.** Revealing a panel (Search via
  `Ctrl+Shift+F`, a View-menu re-select) unfolds its dock; during a panel
  drag a folded dock shows like an empty one, and a drop into it keeps it
  open.
- Not foldable this way: the bottom dock (it already shrinks to its panel
  headers). An empty dock's toggle is disabled.

### Milestone 46 — Editor snippets: trigger words for Markdown blocks (templates plugin)

Ships the milestone-40 announced follow-up: typing a trigger word —
`tbl`, `code`, `task` or any user-defined one — offers a multi-line
Markdown block; Tab walks its `${n:placeholder}` fields. **Not yet
manually verified by the owner.**

- **Plugin-owned by design**: `plugins/templates/renderer/snippets.ts`
  over the `registerExtension('document', …)` seam and the host's CM
  module instances (`api.editor.cm.autocomplete.snippetCompletion`) —
  `markdownBundle()` stays untouched, and the Tab-precedence question
  that blocked a base-owned source dissolved on inspection: the snippet
  keymap is `Prec.highest` while a snippet is active, so
  `editorIndentation` keeps Tab otherwise (bug-9 untouched). Composers
  are excluded (`document` slot only) — no Enter-submits conflict. The
  built-ins exist as a **parity-tested twin** in the plugin: a plugin
  renderer cannot value-import base `shared/` (the import would resolve
  outside its `plugin://<id>/` root and quarantine the plugin — caught
  by the slash-menu e2e during verification).
- **Fully user-owned library**: `templates.snippets` in app config
  (ADR-0010 — machine-level, not vault data). Seeded with the three
  built-ins on a missing key; Settings → Templates edits, removes and
  adds entries — defaults included — plus a "Restore built-ins" button;
  an explicitly emptied list stays empty. The whole `templates` slice
  travels on every write (`appConfig.patch` merges one level deep).
- **Caret gate**: the slash menu's gate (inline code, links, raw HTML,
  frontmatter) plus every block-level structure — tables, headings,
  list items, blockquotes — since a multi-line block inside one is
  nonsense. Fires on a typed word at a word boundary; `boost: 5` ranks
  it above word completion.
- The renderer keeps one `SnippetStore` snapshot the source reads
  synchronously per keystroke (`appConfig` has no change push) and the
  settings page writes through.

### Milestone 45 — Autotag re-homed into the editor's `⋯` menu (req-36)

The `suggestTags` backend orphaned by the drawer's removal (ADR-0057) has
a new trigger.

- **`⋯` → "Suggest tags"** — sends the **section under the caret** (the
  same heading-delimited unit the tag search reports on; fences hide `#`
  runs) plus the vault vocabulary to the unchanged `tags:suggest`
  backend (`TagSuggester`, the editable `autotag` template). New pure
  helper `shared/note-sections.ts` — a base-side twin of the tags
  plugin's section splitter, since base cannot import plugin modules
  (ADR-0044).
- **Direct apply** — the suggested tags are appended to the section's
  last prose line (fence/table/quote/HTML-safe; a new line when the
  section has no prose), deduplicated against the tags it already
  carries, as one undo step, saved immediately. No chips, no dialog.
- **Failure surface** — LLM off, tags plugin disabled, model failure and
  the every-suggestion-already-present case all show in the editor's
  error row; a small "Suggesting tags…" meta-bar hint shows while the
  model answers (no timeout — cancel stays the escape hatch).
- Caret inside frontmatter asks to be moved into the body first.
  `ctx.llm.suggestTags` for plugins is untouched.

### Milestone 44 — Task Center: implemented, then reverted before release (req-35)

The roadmap's priority-1 "Task Center" item ([ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md),
"considered and rejected") shipped as stable `#task/id:<id>` write-back
addressing and was pulled again the same session, before any release:
minting put a permanent `#task/id:k3f9a2b1` token into every panel-ticked
task line (visible in source mode, exports and every other Markdown
tool), editor-checkbox and external ticks never minted at all, and the
mis-tick scenario it guarded — duplicate task texts *plus* a shift
*plus* a tick inside that unsaved window — is vanishingly rare in a
single-user vault. What survives from the investigation: the write-back's
`resolveTaskLine` now **refuses to guess** — with duplicate task texts
and a shifted recorded line it skips the toggle (safe no-op) instead of
ticking the nearest twin, and follows a *unique* task across any shift.
Single-user vaults lose nothing; nobody's task lines carry machine
tokens.

### Milestone 43 — UI refinement: calmer chrome, Anthrazit, capture through the `/` menu ([ADR-0057](../docs/09_architecture_decisions/0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md))

Implements the "Drey UI Refinement" design mockup.

- **Chrome typography and controls (all themes).** Panel titles, tabs,
  file names, menus and the status bar are sentence-case sans; mono stays
  for code, the meta-bar path and line numbers. One global icon button
  (`.icon-btn`) and one segmented switch (`.seg`) replace the per-panel
  button styles. Bars: titlebar/tab bar 36px, meta bar 40px, status bar
  28px, rows 28px.
- **Anthrazit theme** — a second bespoke theme next to Drey (Settings →
  Appearance): warm charcoal surfaces, solid lines, a blue accent, no
  shadows. Default for a fresh install only; existing configs keep their
  theme. _(This retracts milestone 42's "no Anthrazit tokens" note.)_
- **Icon-only controls on the right-hand panels.** Search and Tasks scope
  switches (document / vault / all vaults), Search's Replace / Export /
  Summarize / Clear, the Tasks view toggles, Outline's fold-all, and the
  assistant composer's Attach / Live edit / Vault context / Prompts are
  icons with tooltips and accessible names. Placeholder texts are gone.
- **One field for text and tags** in Search and Tasks: typing `#name`
  turns into a coloured tag chip (with completion), the rest is the text
  query. The separate tag rows are removed. The summary line reads
  "N sections in M files".
- **Slash menu** — sectioned **Templates** / **Formatting**. New built-in
  **Entry** item (the configured entry format: a heading with the current
  time, caret ready for the topic) and every template from the templates
  folder, each with a **preview card** beside the list. The Templates
  panel shows the same preview on hover.
- **"Add entry" removed** — panel, drawer, draft service and the Autotag
  button's surface (the `suggestTags` backend stays, currently without a
  button). Settings → "Add entry" is now **"Entry format"**. The bottom
  dock has no default panel any more.
- **Formatting buttons in the meta bar** — the toolbar is no longer a
  separate strip; shown by default, still hidden via `⋯` → "Formatting
  toolbar". An "Unsaved" label sits beside Save.
- **Files panel** — create and rename happen **in place** in the tree (a
  new row under the target folder; the name turns into an input), file
  names stay on one line and fade out at the right edge, the open file
  carries an accent edge.
- **Calendar** — the **month/year dropdown is the panel header** (no
  "Calendar" title while expanded; collapsed it shows the title and the
  month as before), with a **Today** button beside the month arrows that
  opens today's daily note and jumps back to the current month.
- **Plugin SDK 1.10** (additive): `api.ui.icon(name, size)`, the
  `freeText` mode of `api.ui.createTagField` (+ `setText`);
  `api.ui.registerComposerContribution` is a deprecated no-op.

### Milestone 42 — the editor round: View mode, formatting toolbar, engine polish (ported from the Lariscus editor)

The Lariscus app took Drey's editor in 2026-09 and evolved it; this
milestone back-ports that evolution (only the new features — Drey's own
extras stay, no Anthrazit tokens, no attachment/link services).

- **View mode** — a third `⋯` mode next to Live Preview and Source:
  read-only rendering through the same Live Preview engine
  (`livePreview(config, { revealSelection: false })` — the selection is
  ignored, so no construct ever flips back to raw Markdown), links and
  *resolved* wikilinks open on a plain click (a read-only state has no
  caret to place; wikilink create stays the explicit Ctrl/Cmd gesture),
  the embed editing chrome (`</>`, zoom lens, resize grip) is hidden and
  task checkboxes are inert. `EditorViewMode` is
  `'live' | 'view' | 'source'`; per-doc like the other modes, the last
  choice persists as the default.
- **Formatting toolbar** (`src/app/editor/markdown-toolbar.ts` +
  the pure `toolbar-commands.ts`, both ported): heading menu (Body/H1–H3),
  list menu (bullet/numbered/task), dedicated **Task list** and
  **Blockquote** buttons, bold/italic/strikethrough, link
  (selects the `https://` placeholder), an image button (native picker →
  the same per-note `attachments/` vault chain a pasted image takes) and
  a Word-style 5×5 table grid picker. All commands are toggles where it
  makes sense and act on every line the selection touches. Rendered by
  the `MarkdownSurface` above the editor via its `toolbar` input; the
  full-page editor toggles it from the `⋯` menu ("Formatting toolbar",
  persisted in `localStorage['drey.editor']`, default off). The **entry
  drawer** shows the same toolbar in its body field, toggled by a `T`
  symbol at the tags row's right edge (own persisted value
  `entryToolbar`, also default off; the band renders as the input box's
  flush top strip). Compact one-line composers stay bare.
- **Slash dialog** (`src/app/editor/slash-commands.ts`): typing `/` at a
  line start or after whitespace opens the completion popup with the
  toolbar's block commands plus **Code block** (` ``` ` fence pair) and
  **Divider** (`---`, blank-line separated so it never parses as a
  Setext heading); picking one removes the slash and runs the same pure
  reducer the toolbar uses — one code path. Silent after a non-space
  character (URLs, paths, `and/or`, dates) and in code/frontmatter/links
  (the shared markdown-context gate); not on the Enter-submits
  composers — the entry drawer's body (multi-line, `submitOnEnter`
  off) has it.
- **Engine polish** (back-ported): a bigger, hover-revealed fold chevron
  and a dark-themed fold placeholder; the **link-target fix** —
  `[url](url)` links (what paste-link inserts) used to render empty
  because the whole Link was hidden, now only the target behind `](`
  conceals; task-checkbox clicks and the image resize grip no longer
  dispatch in a read-only state. `livePreviewConceal` /
  `livePreviewBlocks` became opts-taking factories
  (`revealSelection`), threaded through `block-render` and `conceal`.
- **Fix — req-23:** file dragstarts announced
  `effectAllowed: 'copyLink'` while the Files panel's tree rows negotiate
  `dropEffect: 'move'` — an empty intersection, so Chromium showed
  no-drop and **file drags could never move within/across vaults**
  (folder drags always worked; the spec pins the negotiation now).

### Milestone 41 — semantic vault retrieval: the assistant's Vault chip (ADR-0055)

- **The Vault chip** (assistant composer, next to Live edit): cycles
  `off → Vault (active vault) → Vault: all → off`, remembered in
  `localStorage['drey.assistant.vaultScope']`. Each ask with the chip on
  retrieves the **top-k note sections most similar to the question** from
  the scoped vault(s) and injects them into the system prompt
  (`VAULT CONTEXT` block, section text capped at 1200 chars each, cite
  paths requested). No tool calls, a small fixed context — built for
  small local models, independent of `mcp.enabled`.
- **Embeddings in-app** (`plugins/assistant/main/semantic/`):
  transformers.js **WASM-only in a worker thread** (the main process
  never blocks). The native `onnxruntime-node` and `sharp` requirements
  are satisfied by inert stub packages (`tools/stubs/*`, `file:`
  dependencies with satisfying version numbers) while the WASM backend is
  injected via `globalThis[Symbol.for('onnxruntime')]` before load —
  ADR-0023 keeps "no native modules". The ORT WASM glue + the embed
  worker are `asarUnpack`ed (dynamic `import()` cannot target asar).
  Default model `Xenova/multilingual-e5-small` (q8, 384 dims,
  multilingual — the vault content is German), configurable; e5
  `query:`/`passage:` prefixes applied automatically. One-time model
  download from the HF hub on first build, cached under `<userData>/models`.
- **Index without a database** (deliberate deviation from the roadmap's
  sqlite-vec sketch, see ADR-0055): one JSON file per vault under
  `<userData>/plugins/assistant/semantic-index/` (base64 float32 vectors,
  model id stamped, debounced atomic writes + sync flush on quit),
  brute-force cosine in JS. Section unit = the tags index's
  heading-delimited split (copied pure splitter, fence-aware); a model
  change marks an index stale (search skips it) and the next build
  re-embeds.
- **Freshness + retrieval flow**: the index rides the save-hook /
  vault-change registries like the tags index (incremental per file,
  ~30 ms per section on first build; progress via `semantic:progress`).
  Boot/enabling runs a catch-up build of un-indexed files. Retrieval
  happens main-side in the ask flow: embed the question, top-k over the
  scope, then **hydrate each hit's text fresh from the vault** — a stale
  index degrades rankings, never content.
- **Context stays small on follow-ups**: retrieved text rides only the
  current call's system prompt — never the replay. The chat note persists
  a compact ```drey-context fence (paths + headings + lines, rendered as
  a collapsible chip; a click opens the file); older turns replay it as
  one `[Vault context used …]` line. Live-edit turns ignore the scope.
  A retrieval failure degrades to no context + a quiet notice
  (`contextError`), never a failed ask.
- **Settings → "Assistant retrieval"** (plugin category, saves
  immediately): master switch, embedding model id, k (1–8, default 4),
  minimum similarity (default 0.3), per-vault index status (section
  count / stale badge / build progress) with per-vault Rebuild buttons.
- Tests: `semantic.spec.ts` (splitter, prefixes, vectors, cosine, context
  shaping), `ask-context.spec.ts` (`vaultScope` parsing incl. legacy
  payloads, `drey-context` fence roundtrip incl. hand-mangled lines,
  compact replay line), `vector-index.spec.ts` (ranking, k/threshold,
  vault isolation, staleness, JSON roundtrip, corrupt-file tolerance).

### Milestone 40 — word completion + the shared Markdown context detector

- **Word completion** (`src/app/editor/word-completion/`): a third
  completion source in the Markdown bundle next to `#tag` / `[[wikilink]]`
  — repeats the note's own words. Vocabulary = the current document,
  frequency-ranked; opens at ≥ 3 typed word characters, options capped at
  20 with `boost: -30` so tag/wikilink candidates keep precedence,
  `validFor` lets the popup re-filter synchronously while it stays open.
  The harvest runs only when a popup session opens (cache keyed on the
  `Text` object's identity), not per keystroke. As-you-type via the
  existing global `autocompletion()` from `basicSetup`; deliberately **not
  mounted on the Enter-submits composers** (assistant composer), where an
  active popup would swallow the submit-Enter.
- **Shared Markdown context detector** (`src/app/editor/markdown-context.ts`):
  one `markdownContextAt(state, pos)` answering "what is the caret in?" —
  Lezer tree first (`code-block` / `code-span` / `link` / `html` / `table`
  / `heading` — GFM table nodes included), then the constructs without a
  parser node (`frontmatter`, unclosed `[[…` → `wikilink`, trailing
  `#tag`), then a table fallback for row-shaped lines near a delimiter row
  (a table is only a `Table` node once its delimiter row exists), else
  `prose`. `inCompletableText()` is the shared completion gate.
- **Tag/wikilink completion guarded** by the detector: both sources stay
  silent inside fenced code, inline code, frontmatter, links and raw HTML
  — previously a `#` in a code block or a YAML comment opened the tag
  popup, and `[[` in code opened the wikilink popup (their decorations
  were already guarded; the popups were not). Headings, tables and
  blockquotes still complete. The two duplicated `insideCode()` tree walks
  (tag pills, wikilink decorations) moved onto the shared module's
  decoration twin — same semantics, no behavior change.
- Tests: `markdown-context.spec.ts` (detector + gate),
  `word-completion.spec.ts` (ranking, min length, gates, cap, validFor),
  guard cases in `tag-completion.spec.ts` / `wikilink.spec.ts` (their
  mocked contexts now carry real Markdown states). No settings toggle —
  the behavior follows these fixed rules.

### Milestone 39 — the Outline panel plugin (req-28)

- The **Outline dock panel** (`plugins/outline/`, renderer-only like
  `templates/`): the open note's heading tree — every level with children
  gets a chevron to expand/collapse (per-document session state, keyed by
  stable title-chain keys so the tree keeps its shape across re-scans; a
  `fold` header toggle collapses/expands everything at once), clicking an
  entry opens the section at its heading line, and the row at the caret
  (or, inside a collapsed subtree, its nearest visible ancestor) carries
  a quiet accent highlight. Lands collapsed at the bottom of the left
  dock; movable like every panel.
- Doc scope only, and always fresh: the panel scans the focused pane's
  **live buffer** on every document event (the host's ~150 ms
  `buffer-changed` debounce) — no disk index, no stale-line resolution;
  the click target re-resolves through the row's stable key inside the
  debounce window. Scanner conventions match the tags/tasks section
  scanners (ATX-only, naive fence toggle, closing `#`s stripped) plus
  YAML frontmatter skipping, so a `# comment` in the frontmatter never
  becomes an entry (`plugins/outline/shared/outline.ts`).
- **Reveal through the tracked editor view**: `documents.open` resolves
  paths against the active vault, so for a pinned external tab
  (`external://…`, ADR-0054) or a scratch tab it could only raise an
  error banner. The plugin instead registers a document-slot
  `updateListener` (host CM modules, ADR-0044 rule 1) that tracks the
  last-focused surface's path + view; a click dispatches the caret move
  + scroll straight into that view — works for every doc shape and can
  never open a duplicate tab — and falls back to `documents.open` for
  vault docs when nothing is tracked yet. The same listener feeds the
  caret-line highlight (the document API has no selection event).
- Tests: scanner + tree builder (`plugins/outline/shared/outline.spec.ts`,
  16 cases — nesting, keys stable across line shifts, fences,
  frontmatter). Panel behaviour is manual-verification territory.

### Fix — spellcheck: suggestions for typos inside compounds

A flagged compound got an empty popup: nspell's suggest searches the
dictionary's words, and neither the typo nor its correction is one.
`compoundSuggestions` (`shared/spellcheck.ts`) rebuilds candidates from
the half the dictionary can advise on (`Krankehnhaus` → `kranken` +
`haus`), merged with plain suggestions and ranked by edit distance so
the real fix leads (`Krankenhaus` first, `Arbeitsspeicher` first).
Known limit: boundary-crossing typos without an accepted anchor half
stay suggestionless, and `Testfhal` offers `Testfahl` before `Testfall`
— closing that needs a real Hunspell engine
([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).

### Fix — spellcheck: legitimate German compounds are no longer flagged

nspell never evaluates the Hunspell `COMPOUND*` rules `dictionary-de`
declares, so every closed compound not literally listed came back
flagged (`Testfall`, `Krankenhaus`, `Arbeitsspeicher` — 20 of 22
everyday compounds in a measured sample). A rejected word now falls back
to `compoundAcceptable` (`shared/spellcheck.ts`): it counts as correct
when it decomposes into accepted parts, Fugenelemente (`Arbeit + s +
Speicher`) included. Deliberately errs towards silence — any
concatenation of valid words is accepted too
([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).

### Fix — spellcheck: the bulk check no longer computes suggestions

Measured with the real German dictionary, nspell's `correct()` costs ~5 µs
per word but `suggest()` costs **40–108 ms per misspelled word** — so the
first `spell:check` of a document (open, session restore, after every
`invalidate()`) blocked the main process for seconds. `spell:check` now
returns only the misspelled words; the popup's suggestions are fetched
lazily, one word per click, through the new `spell:suggest` IPC channel
(`suggestSpelling`), with the popup opening on a placeholder row and
filling in place. Renderer-side, `SpellcheckService` caches verdicts as
booleans plus a separate single-flighted suggestion cache
([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).

### Milestone 38 — summary streaming scroll, scratch-tab context, assistant tools across vaults

- **Stick-to-bottom while the summary streams** — the old behaviour
  snapped the `search-summary.md` tab back to the top on every 150 ms
  flush (`setContent`'s `anchor === 0 → scrollTop = 0` branch; the
  scratch tab's caret stays at 0 because nobody clicks into it).
  `setContent` now measures the pin state (≤ 32 px from the bottom)
  before the in-place swap and restores it after: the view follows the
  growing text by default, stays put while the user has scrolled up, and
  resumes following when they return to the bottom. The same rule now
  covers live-edit pushes and re-run summaries; fresh opens still start
  at the top (`loadDocument`).
- **The search summary as assistant context** — the composer's **+**
  picker lists **unsaved scratch tabs** (saved-empty + dirty text docs,
  e.g. `search-summary.md`) above the vault files, labelled "unsaved
  tab". A scratch chip rides as the tab's live buffer; each send
  snapshots the current text to `.drafts/assistant/<vaultId>-<name>.md`
  (hidden scratch area, invisible to tree/index) and that vault path is
  what the turn cites — so follow-up replays re-read it like any
  attachment and the context survives the tab being closed. Attaching
  the focused tab folds into the note chip instead of doubling; files +
  scratch tabs share the 10-chip cap.
- **Assistant vault tools across vaults** (ADR-0051 follow-up) —
  `vault_read`/`vault_write` grew the `vault` argument (id, default
  active; `"all"` is rejected with a clear error), cross-vault writes
  name the vault in the confirmation dialog (`vaultId`/`vaultName` ride
  the existing bridge payload), cross-vault `vault_search` hits are
  labelled `vaultId:path`, and the tools note in the system prompt lists
  the registered vaults (id + name) — until now the model had no way to
  learn vault ids, making even `vault_search`'s `vault`/`"all"` support
  unreachable in practice.
- Tests: scratch-chip send/snapshot/replay flows
  (`plugin-assistant-state.spec.ts`), the vault-argument threading +
  hit labels (`mcp-vault-tools.spec.ts`). Runtime view §6.43 updated;
  ADR-0051's tools bullet resolved.

### Milestone 37 — search summarise: an LLM topic digest from the search results

- **"Summarize" in the Search panel** — next to Export (same visibility:
  visible once a search has hits; it appears only when an LLM is
  configured in Settings → LLM, disabled-state tooltip otherwise). Works
  in every scope (File / Vault / All), including unsaved-buffer hits.
- **How it runs** — the tags plugin's renderer passes its current hit set
  to a new plugin-side `summarise` backend; main loads the **editable**
  `builtin:search-summary` Action template from app config (reworded to a
  comprehensive topic digest: thematic blocks with bold lead-ins, key
  facts, an "Open questions / contradictions" paragraph, path citations,
  in the notes' language — stored-but-never-edited copies refresh to the
  new default), packs the whole matching sections up to a ~60 000
  character budget (`buildSearchSummaryMaterial`, cuts at a whole-section
  boundary and says so), and runs one `ctx.llm.chat` call.
- **Streaming + cancellation** — deltas stream out-of-band (plugin
  `summary:delta` event, ADR-0014/0047 contract: non-streaming providers
  deliver once) into a new unsaved `search-summary.md` scratch tab
  (throttled buffer flushes; the panel header shows "summarizing…"); the
  button becomes **Stop** (`llm:cancel` → the same abort registry as
  chat/OCR). Completed, cancelled and failed runs all leave the partial
  digest in the tab; errors also surface in the panel. Save-as keeps the
  digest as a note.
- Tests: `buildSearchSummaryMaterial` / `formatSearchSummaryHeader` /
  `describeSearchQuery` in `plugins/tags/shared/search.spec.ts`. The
  plugin specs never actually ran (`ng test` ignores the
  `plugins/**/*.spec.ts` entry in angular.json) — they now run via
  `npm run test:plugins` (root `vitest.plugins.config.mts`), and their
  stale never-executed expectations were repaired to the shipped
  behavior (1-based inclusive replace ranges, literal regex replacement —
  no `$1` refs, V8 regex error wording, extensionless `{{title}}`).
- ADR: [0017](../docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md)
  (digest section), runtime view §6.43. No new ADR — the feature follows
  ADR-0044 (feature logic in the plugin), ADR-0047 (base transport) and
  ADR-0014 (cancel, no timeout) as-is.

### Milestone 36 — Drey as an Explorer "Open with" / default program for Markdown and text

- **File associations** — the NSIS installer registers `.md`, `.markdown`,
  `.mdx` and `.txt` (per-user, `fileAssociations` in
  `electron-builder.yml`); Drey shows up under "Open with" and can be made
  the default ("Always use this app"). The portable build registers nothing.
  Caveat: with no explicit user choice a `.txt` starts opening in Drey.
- **A launched file opens in the running app** — the launch argv (cold
  start) or `second-instance` (Drey already open, same window) is filtered
  to existing md/markdown/mdx/txt files. Inside a registered vault → an
  ordinary vault tab. **Outside every vault → a pinned external tab**
  (`external://<path>`, marked "Outside your vaults"): edited normally and
  **Ctrl+S saves back to the original location** (file's own line endings
  kept; no vault pipeline — no frontmatter bump, index or on-save Actions);
  never replaced by the next file, no unpin. "Save as…" still copies it
  into the active vault. External tabs are not restored after a restart.
- **Safety** — main keeps a read/write allowlist of the paths it collected
  from the OS itself (plus extension + 10 MB gate; a write needs the file to
  still exist), so the renderer can neither read nor write arbitrary files. Cold start is a renderer *pull* after session restore
  (a push would race startup); later launches are a push. A launch that
  opened a file skips the startup daily-note fallback.
- Dev: `npm run electron -- C:\path\x.md` forwards arguments.
- ADR: [0054](../docs/09_architecture_decisions/0054-opening-files-from-the-os.md).
  Deferred: PDF/image/code associations, restoring external tabs, live
  reload of a changed external file, drag-in of out-of-vault files.

### Milestone 35 — pinned tabs + a Save / Don't save / Cancel prompt on tab close

- **Pin a tab** — tab context menu → "Pin tab" / "Unpin tab" (text, image
  and pdf tabs; a pin glyph shows on the tab). A pinned tab is never the
  tab that milestone 32's clean-tab replacement closes: the next file
  (Files panel, calendar day, wikilink, search hit) opens in a **new tab
  beside it**. When the pinned tab is the *active* one, the replacement
  goes to the pane's clean **unpinned** tab instead (rightmost one), so
  browsing from a pinned reference note reuses one "preview" tab rather
  than piling up new ones; with no such tab (only pinned or dirty ones
  left) the file opens beside. The pin survives Save-as, renames/moves and a restart
  (`pinned` on the session snapshot's tab). Closing a pinned tab, "Close
  others" and "Close all" are unchanged — a pin only steers replacement.
- **Closing a dirty tab asks Save / Don't save / Cancel** (was a two-button
  "Discard unsaved changes?"). "Save" writes the buffer and closes only if
  nothing is left unsaved — a failed write or a cancelled Save-As dialog
  (a never-saved untitled tab) keeps the tab open; Escape / backdrop count
  as Cancel. New `ConfirmDialogService.decide()` (a third button on the
  shared dialog); `EditorService.saveAs()` now resolves to the key of the
  saved tab so the swapped-in tab can be closed too. The **app-exit**
  prompt (bug-5, Save all / Exit without saving / Cancel) was already
  three-way and is unchanged.

### Milestone 34 — tasks across vaults (M-B complete) + the editor's undo fix

The two leftovers from the tag-system round: the last M-B item (tasks
per-vault + "all vaults") and the editor defect discovered while testing
milestone 33's replace flow.

- **Tasks: per-vault index + all-vaults scope (M-B complete)** — the
  tasks plugin mirrors the tags plugin's milestone-33 shape: one task
  index per registered vault (the mirror-the-active-vault boot guard is
  gone), every record stamped with its `vaultId`, and the panel's scope
  switch grows a third segment — **Doc | Vault | All**. Vault scope
  filters the main-side list to the registry's active vault at pull
  time; the All scope groups per file with a vault-name badge (the
  active vault stays unbadged, like the Search panel). Row toggles and
  row clicks carry the vault: a closed file's toggle writes through
  `readFile`/`writeFile { vaultId }`, an open tab is reached by the
  bare path (active vault first, then a unique open match — the
  `resolveDoc` semantics the Search panel rides). The unsaved-buffer
  fold keys on `(vaultId, path)`, so two vaults holding the same
  relative path no longer clobber each other's rows. With this,
  milestone 28's announced M-B follow-up is fully shipped.
- **Editor: undo can no longer wipe a freshly opened tab** — a first
  load and every tab switch now build a fresh CodeMirror state
  (`MarkdownSurface.loadDocument`, compartment contents carried over via
  `Compartment.get`): the document sits in the state's own doc instead
  of being dispatched in, so the load is not an undo event and every
  tab starts with an empty undo stack. Previously the load was a
  dispatched full-range change sitting at the bottom of the history — a
  second `Ctrl+Z` in a freshly opened tab rolled the LOAD back and
  wiped the document (found while testing milestone 33), and undoing
  across a tab switch could resurrect the *previous* tab's content.
  In-place reloads of the same tab (save pipeline, watcher, live-edit
  buffer pushes per ADR-0049) deliberately stay undoable dispatches;
  the entry drawer's capture box keeps its behavior. The code now
  matches what the Editor's header already documented: "undo history
  does not survive a tab switch" (ADR-0037).

### Milestone 33 — tag system round: prefix colors, central tag completion, search fix + redesign (M-B core)

The tag/search batch: four owner-reported items — configurable tag
prefixes with colors, tag completion as a central component, the broken
text search, and a VS Code-style search redesign — landed as one
coherent evolution of the tag system (ADR-0017 "Later change"; the
multi-vault halves of the announced M-B follow-up ship here).

- **Search fixed at the root** — the index skipped every section
  without an inline `#tag`, so text search *never* found untagged
  notes ("tags work, text doesn't"). The index now covers every
  heading-delimited section; tag-only queries behave exactly as
  before. Errors surface in the panel instead of silently emptying it
  (a missing provider, a broken regex), and `Mod+Shift+F` focuses the
  search field.
- **Per-vault indexes + search scopes (M-B core)** — one tag index per
  registered vault; the SDK's `scope` parameter is honoured at last
  (`{ kind: 'vault' }` / `{ kind: 'all' }`, omitted = the active vault
  resolved at call time — the old boot-race guard is gone). The Search
  panel gets a **File | Vault | All** scope switch, hits carry
  `vaultId` (clicks open the right file in cross-vault results, and
  unsaved-buffer folds key on `(vaultId, path)`), and MCP
  `vault_search` gains an optional `vault` argument (`"all"` or a
  vault id; the regex-only scan follows it). Tasks stay single-vault —
  the remaining M-B item.
- **Search redesign** — the panel (flush layout: inputs pinned, one
  scrolling results list, everything top-left) grows the mockup's
  search row with **Aa** (match case) / **ab** (whole word) / **.\***
  (regex) toggles and a collapsible **replace row**; the tag chips
  remain AND-combinable; results group **per file** (collapsible,
  match counts, vault badge in the all-vaults scope, per-hit replace).
  Scope + toggles persist (`localStorage['drey.search']`). A broken
  regex shows its compile error inline and disables nothing else.
- **Replace with section semantics** — file scope patches the open
  buffer (a normal undoable edit); vault/all scope collects per-file
  patches and shows **one bundled confirmation** (per-file expandable
  diffs) before applying via announced writes. Every file is re-read
  and re-matched right before its write (TOCTOU), CRLF is preserved,
  and only occurrences inside the matching sections change.
- **Tag prefix colors** — Settings → **Tags** (a Tags-plugin page) maps
  `/`-namespaces to colors (`proj` colors `#proj/alpha`; the longest
  prefix wins). Unconfigured tags get a deterministic auto color keyed
  on the first segment from a curated dark-theme palette. The provider
  serves prefix styles; base resolves colors — editor pills, entry
  drawer chips, panel chips and completion options recolor **live**
  (no restart). Stored per-plugin (`plugins/tags/config.json`).
- **Central tag completion (the plugin stays the data owner)** — tag
  pills and `#tag` completion moved from the Tags plugin into base
  (`src/app/editor/tags/`, fed by a base `TagVocabularyService` over a
  new `search:vocabulary` route + `search:changed` push), and a shared
  plain-DOM **tag field** (colored chips + completion dropdown) is
  mounted by the entry drawer and handed to plugins as
  `api.ui.createTagField` — the Tasks filter and the Search panel
  dropped their hand-rolled, completion-less chip rows for it.
  `commands.run(id, payload?)` carries the pill-click handoff
  (`search.open` with `{ tag }`).
- **SDK 1.9 (additive)** — `commands.run` payload,
  `ui.createTagField`, `ctx.search.notifyChanged`,
  `SectionSearchProvider.styles?`, `TagSearchQuery.match?`,
  `TagPrefixStyle`, `TagEntry.color?`. The tag grammar moved to
  `shared/tag-grammar.ts` (plugin-local twins + parity spec — plugin
  renderers cannot load values over `plugin://`); the dead
  `tags:list`/`tags:search` channels are gone. Two pre-existing lint
  errors in `editor-context-menu` (barrel imports from the req-33/34
  commit) fixed in passing.

### Milestone 32 — beta-feedback batch II: daily folder, tab replacement, mermaid export, plugin settings

The second cut from the beta-testing feedback list (five items; the
native-dialog focus fix landed the same week and is recorded as the
bug-6 follow-up below).

- **Configurable daily-note folder** — Settings → Daily notes gains
  "Storage folder" (`daily.dir`, default `daily/`), mirroring
  `templates.dir` exactly: app-level config (ADR-0010), applied to all
  vaults equally; per-vault overlays stay with ADR-0051's announced
  follow-up. Only the root is configurable — year/month nesting and the
  `YYYY-MM-DD.md` name stay fixed (they are the calendar's matching
  grammar). Reads and writes use **only** the configured folder (exact
  `templates.dir` semantics): legacy flat `<dir>/<date>.md` files stay
  readable inside it, an old `daily/` root is never read again once the
  setting changes, and no files are moved. `dailyPathFor`/
  `dailyDateFromPath` take the dir (regex metacharacters escaped, so a
  root like `My.Notes` can't act as a wildcard), and the calendar finds
  note days by walking the whole file tree instead of assuming a
  top-level `daily` folder.
- **Opening a file replaces the focused clean tab** (ADR-0003
  amendment) — clicking a file row or a calendar day reuses the focused
  pane's *clean* tab instead of stacking a new one; a dirty tab stays
  and the new file opens alongside. Plugin doc kinds and the
  already-open reveal path are excluded, and internal flows (session
  restore, `saveAs`, multi-select open) pass `keepFocused`.
- **Mermaid diagrams render in the PDF export** — ADR-0052's scope cut
  is reopened and closed: the hidden export window (already a Chromium
  renderer) inlines the bundled mermaid build and renders ```mermaid
  fences to SVG before `printToPDF` — light theme on purpose (the PDF
  leaves the vault's dark editor), a parse error or the 20 s
  per-diagram cap falls back to the plain code block, a failed bundle
  read exports without diagrams. The runtime is embedded only when the
  note actually contains a mermaid fence, and note markup cannot reach
  the script layer (the HTML strips run first).
- **Editor/PDF parity is a standing rule** — recorded in this file's
  preamble, checklist in docs/06 §6.39: when the editor gains a new
  rendered element it must carry into the export in the same change, or
  its absence there is an explicit decision (current: `[[wikilinks]]`
  stay literal; `![[x.pdf]]` embeds print a visible "not printable" note
  instead of an empty frame — an `<img>` cannot rasterize a PDF; the M31
  gap closed with this milestone's wrap-up).
- **Plugin Settings pages share the core form vocabulary** — a shared
  stylesheet scoped under `.plugin-settings-body`
  (`src/app/plugin-host/plugin-settings.css`, mirroring the Settings
  panes' `settings-forms.css`) replaces the three built-in plugins'
  bespoke settings styling (the assistant's Actions page, templates,
  sample), so a plugin page reads like a built-in category and follows
  the app-wide type size; `plugins/AUTHORING.md` is the practical
  author guide (layout & build, the manifest's `apiVersion` gate, the
  CSS prefix/tokens/rem rules, the vocabulary table, the testing
  convention).

### Milestone 31 — beta-feedback batch I: fixes + small features

The first milestone cut from the beta-testing feedback list (triaged
against the codebase; several items turned out already fixed or
by-design — chat/document binding (M29), `.md`-only tag scanning,
PDF-export image resolution — and the rest split into this batch and an
M32 feature batch).

- **Startup performance** — the tags and tasks indexes no longer block
  activation on a full-vault scan: the window appears first, the boot
  build runs once in the background (the old code scanned the vault
  twice — once awaited, once via the refresh round), and each finished
  sweep pushes `index-updated` over the plugin bridge so the Search panel
  and `#tag` autocomplete populate as soon as the index is ready. This
  also fixes the "tag autocomplete fails on some machines" report: the
  renderer's one-shot vocabulary pull used to swallow errors with no
  retry. Rebuilds coalesce (`requestRebuild`) so watcher bursts and the
  refresh round can never interleave sweeps. Both plugins now walk via
  the new `ctx.vault.listMarkdownFiles` (SDK minor 7) instead of
  filtering the full tree.
- **Ask protocol rework (ADR-0053)** — answers stream as **plain prose**
  (the old "reply ONLY with JSON" envelope accumulated as raw JSON on
  screen), and an edit arrives as the complete document inside a
  four-backtick `document` fence (inner ``` fences survive; longest body
  wins, ties last; a lone ```markdown block heals). No fence → the reply
  IS the answer — a truncated or disobeyed reply can no longer degrade
  into a raw-JSON answer card. Live edit (ADR-0049) and chat replay are
  untouched.
- **LLM "no response"** — providers now throw a clean `bad-reply` (with
  detail) instead of returning empty text when the model never spoke and
  no tool ran, and a non-JSON 200 body surfaces as an error excerpt
  instead of a leaked `SyntaxError`; the chat engine fails a
  tools-ran-but-empty turn with the question kept for a re-send.
- **`![[image]]` / `![[pdf]]` embeds** — Obsidian-style media embeds
  render in both editor modes with the same widgets and reveal mirror as
  `![](path)` (ADR-0046 addendum); note targets still link, never
  transclude. The image candidate chain is single-sourced in
  `shared/asset-refs.ts` — note-relative, vault root, then the
  `attachments/` folders for a bare name — shared by the editor, the PDF
  export, and the export's `rewriteEmbedWikilinks`; the chain also
  decodes percent-encoded destinations, fixing PDF export of file names
  with spaces.
- **Heading hierarchy** — per-level heading typography (all six levels
  distinguishable) lives outside the theme compartment, so every
  published theme keeps it (they style headings identically or not at
  all — the "indistinguishable headings" report); theme colours still
  apply. Even on Drey, h4–h6 are now distinct.
- **Files panel** — folders start **collapsed** each session (a big
  vault no longer opens as a wall of expanded trees); the header button
  toggles Expand all / Collapse all; opening a tab auto-expands the
  active file's ancestors so the row is visible. Row context menus gain
  **Reveal in File Explorer** and **Open in Terminal** (typed IPC
  `vault:reveal-path` / `vault:open-in-terminal`; Windows opens `cmd /K`
  in the folder, macOS Terminal, Linux best effort).
- **Generic file drop** — an OS file that no cascade branch claims is
  staged name-preserving into `attachments/` and inserted as a Markdown
  link (100 MB cap, extension-less files refused) — the drop used to be
  swallowed silently.
- **`created` datetime** — new notes, daily notes and chat notes store
  `created` as date+time (`YYYY-MM-DDTHH:mm:ss`); legacy date-only values
  in existing files remain valid and are never rewritten.
  `specs/frontmatter-schema.md` updated.
- **Assistant catch-up** — switching documents while a generation runs
  now re-follows the new document's chat when the generation finishes
  (the switch used to be lost until the next tab switch).
- Stale "(milestone 26)" notes on the not-yet-wired Copilot presets now
  point at `specs/roadmap.md`.

### Milestone 30 — PDF embeds + a PDF viewer tab (Req-2 PDF slice, ADR-0052)

Dragging a PDF into a note now **reads it where you are** instead of
silently swallowing the drop, and a `.pdf` in the vault opens as a
viewer tab instead of a mojibake text buffer (that buffer's Ctrl+S
writing binary garbage was a real hazard — gone).

- **Drop / paste** — a PDF staged into the note's `attachments/` keeps
  its **original file name** (`Quarterly Report.pdf`, `-2` on a
  collision — a documented deviation from ADR-0024's hash naming: PDFs
  are browsable documents, not paste artifacts) and inserts
  `![Quarterly Report.pdf](attachments/…)`. Blank-MIME Explorer drops
  work by extension, like images; images still win mixed drops;
  clipboard paste works too; a Files-panel drag links in place without
  copying.
- **Inline embed** — the `![](…)` line renders as a Live Preview block
  widget over Chromium's **built-in (PDFium) viewer** (`plugins: true`
  on the main window; no bundled PDF library). The familiar Req-1
  affordances: `</>` reveals the raw line in the rounded container with
  a read-only viewer mirror kept below, the lens opens the **full PDF
  tab**, a dead reference shows a compact `PDF not found: …` box whose
  click drops the caret into the source. The `drey-asset` protocol pins
  `application/pdf` for `.pdf` paths so the viewer accepts the frame.
- **`kind: 'pdf'` tab** — the third base doc kind beside `'text'` and
  `'image'`: no buffer, never dirty, session-restored, opened from the
  Files panel, plain links (Ctrl+click), the embed lens and the pane
  drop. Tab strip and status bar treat it as a base kind.
- Precedence of the drop cascade is now image > PDF > text; `|WxH`
  size suffixes on PDF embeds are parsed but ignored (a page viewer's
  width is the column).

### Milestone 29 — UX batch: icon buttons, tooltips, assistant overhaul, capture fix

Seven owner requests in one pass:

- **Editor meta bar**: the Lines and Save controls are icon-only buttons
  (state stays visible via the on/dirty tints and the title/aria-label
  "Saving…"/"Save"/"Saved"); a Lucide `save` glyph joined the icon map.
- **Files panel**: hovering a file or folder row shows its absolute path
  (vault root + relative path, separator matched to the root).
- **Assistant**: the transcript auto-follows the streamed answer
  (stick-to-bottom, scrolling up unpins); "+ New chat" is an icon button;
  the automatic summary is **removed entirely** (ADR-0012 superseded — no
  summary card/switch/IPC/`note-summary` template/Assistant settings
  page; stale `builtin:note-summary` entries in existing configs are
  dropped, old `.chat.json` sidecars stay on disk untouched); in its place
  a **Prompts picker** reads `templates/prompts/*.md` (`# Titel` /
  `> Beschreibung` / body) and inserts the body into the composer.
- **Chats bind to the active document**: a chat note's `note:` frontmatter
  records the doc key it was started under; switching tabs opens that
  document's newest chat (a non-note focus shows a fresh chat), while the
  picker and "+ New chat" keep manual chats possible.
- **Bug fix — files no longer modified on open**: the editor's per-id
  request signals (quick-capture entry, assistant insert, reveal-at-line)
  were deduplicated per component instance, so every freshly mounted
  editor re-applied the last pending request — one quick capture earlier
  in the session gave *every* later-opened file a `## HH:mm` entry.
  Consumption is now claimed once, globally, in `EditorCommandsService`.

### Milestone 28 — multi-vault registry (ADR-0051)

The app knows **several vaults at once**: the Files panel shows one
section per registered vault (the old vault header row, stacked — name,
active marker, fold chevron) with the documents under each, plus
**"Add vault …"** in the panel header, the empty state and the vault
row's context menu (**Set active / Rename… / Add vault… / Open in File
Explorer / Remove…** — registry-only removal, the folder stays on disk,
open tabs close first with the usual dirty prompts). `<userData>/vault-config.json`
became **version 2**: `{ vaults: [{id, name, path}], activeVaultId }` with a
one-time v1 migration; ids are minted (`v` + hex) and stable across folder
moves, display names are editable. **One vault stays active** — daily
notes, quick capture, the Add entry drawer, chats, calendar and
scratch-tab Save-as keep targeting it.

Files from **any** vault open and edit side by side: a document's tab
identity is now `vaultId::relativePath` (`OpenDoc.vaultId` + `key`), so
the same-named note in two vaults is two independent tabs; pane tabs,
tab drag, the session snapshot (v2, per-tab `vaultId`; a tab whose vault
was removed since is dropped; v1 snapshots still restore) and the
Files panel's selection/drag state all key on it. **Drag & drop now also
moves entries across vaults** (copy + delete in main, EXDEV-safe, the
assistant sidecar travels along; tabs re-target; both indexes rebuild).
`drey-asset://` URLs carry the vault (`drey-asset://<vaultId>/asset/<path>`),
wikilinks resolve and create within the linking note's vault, and Save-as
roots at the tab's own vault.

Every `vault:*` IPC method gained an optional trailing `vaultId`
(default: active); new registry channels `vault:list/add/remove/
rename-vault/set-active/reveal-folder` replace `vault:select`. Registry
mutations run the full all-vaults refresh round — which also fixes the
old gap where a vault switch never pushed `vault:changed` to the
renderer. The watcher (opt-in) now watches **every registered vault**
(one chokidar per vault, reconciled on registry changes; per-vault
announce batches), the own-write ledger keys are vault-scoped, and the
`ctx.vault` plugin facade gained `{vaultId}` options + `listVaults()`
(`PLUGIN_API_VERSION` minor → 6). Tags/tasks indexes stay single-vault
(the active one, guarded against foreign saves) — search scopes
(document / this vault / all vaults), MCP `vault` arguments and per-vault
indexes are the announced follow-up.

### Milestone 27 — OCR via the vision LLM (req-9 desktop half, ADR-0050)

Right-click an image → **"Recognize text"**: the new `ocr` runtime plugin
transcribes it through the **connected vision-capable LLM**
([ADR-0050](../docs/09_architecture_decisions/0050-ocr-via-vision-llm.md) —
a deliberate deviation from req-9's Apple-Vision/Tesseract sketch; VLMs
read handwriting far better and the ADR-0047 transport already existed).
Two surfaces: an **embedded image in a note** (Live Preview widget or the
raw `![…](…)` line — the widget's `drey-asset://` src reverse-maps, the
line regex covers source mode) gets its transcription spliced **below the
image line** through the shared confirmation diff (ADR-0011; confirm
applies and saves); an **image tab** (`kind: 'image'`, right-click there
previously produced no menu at all) gets an unsaved scratch tab
`<image-basename>.md`. While the model streams, a small modal shows the
partial transcription, an elapsed clock and **Cancel** (ADR-0014; the
main-side call rides the renderer-minted `taskId`), and errors render in
the same modal. The row shows on every resolvable image — **enabled** when
the active provider declares `imageAttachments`, **grayed out**
otherwise (never gated on provider ids; a not-loaded plugin contributes
no row). Base grew three feature-agnostic surfaces: the context-menu seam's
provider callback now receives the click target
(`EditorContextMenuTarget`: pane doc path + line, or image-tab path —
the entry drawer's and plugin composers' surfaces carry no doc path), the
renderer menu also opens on image tabs (clipboard rows suppressed), and
every app-config write re-pushes the active provider's capabilities
(`llm:capabilities-changed` via a new `AppConfigStore.onChange`), so the
row flips enabled/disabled on a Settings save without a restart. Two
menu-hygiene rules rode along: `ContextMenuItem.disabled` (grayed,
unclickable) and **a menu with zero rows never opens** (an image tab
without plugin items stays menu-less; a throwing plugin provider is
skipped instead of blanking the menu). The SDK gained
`MainChatOptions.maxOutputTokens` and `api.llm.onCapabilitiesChanged`;
`PLUGIN_API_VERSION` minor → 5. The verbatim-transcription prompt lives
in the plugin (`specs/classifier-spec.md` → "Prompt 3").

Found during manual verification, fixed with it: **embedded images that
reference a vault-relative path never rendered** — assistant chat notes
embed their attachment lines with the `vault:saveAsset` result verbatim
(vault-relative), but image references resolve note-relative, so every
chat-note image showed the `image not found` placeholder (which, for an
empty alt, read as the misleading "no alt text"). Image embeds now walk
**two candidates** on load errors — note-relative first (unchanged
semantics), then the same target read from the vault root — which heals
chat notes and any note moved between folders without touching note
data; the reveal mirror walks them too, and the placeholder now names
the **reference as written** instead of the alt text. The OCR plugin's
line-regex target resolution mirrors the same candidates (picked against
the live vault file list).

### Milestone 26 — live edit mode (Req-32, ADR-0049)

The composer gained a **"Live edit" toggle chip**: for one opted-in ask
turn the model edits the open note **directly and immediately** — no
confirmation dialog, a deliberate per-turn exception to ADR-0011. It
edits through the new `doc_*` tools over the provider tool loop:
**`doc_apply_diff`** carries one or more atomic `{find, replace}` hunks
(each `find` must match exactly once, else nothing applies and the error
names the failing hunk), **`doc_write`** replaces whole documents,
**`doc_read`** verifies with numbered line windows — so large notes are
never rewritten wholesale. A main-side working copy seeds from the live
buffer; every mutating call pushes the whole copy through a new
`chat:liveEdit` plugin event and lands via `documents.setBuffer` as ONE
undo step (Ctrl+Z walks the turn back push by push, Ctrl+S saves —
req-25 unchanged). While the model works, the document is **locked for
user input** ("Assistant is editing…" in the meta bar) — an
`EditorView.editable` compartment, deliberately not `EditorState.readOnly`,
so the model's own pushes keep flowing; the lock releases on success,
error and cancel alike. The applied document persists into the chat
note's `edit` fence entry, so ADR-0048 replay works unchanged. Base
seams: `MainChatOptions.tools`/`onToolCall`/`maxToolRounds` (the
plugin-host facade merges plugin tools with the vault set; the vault
tools stay confirm-gated) and `api.documents.setEditLock`;
`PLUGIN_API_VERSION` minor → 4. Providers without tool support (the CLI
providers) fail with a visible error before anything is persisted.

### Milestone 25 — chats as vault notes (Req-30, resolves bug-10(b))

Conversations with the assistant became **standalone Markdown notes**
under `chats/<yyyy>/<mm>/<yyyy-mm-dd>-<slug>.md`
([ADR-0048](../docs/09_architecture_decisions/0048-chats-as-vault-notes.md),
superseding ADR-0012's per-note sidecars for conversations — the sidecar
stays for the automatic summary). The note is the conversation's source
of truth: one `## User`/`## Assistant` heading per turn with a `drey-tool`
fence persisting every tool call/result and every applied edit **in
full**, so a follow-up **replays the whole persisted history** (or
resumes a Claude Code session via `--resume`) — the ~12-message cap and
the lost-context defect are gone. Chat notes are **auto-saved and
prompt-free**: an open tab follows the disk (an engine append reloads it
even when the tab has unsaved typing), hand edits persist after a short
idle, and dirty temp files (scratch tabs, `.drafts/`) are committed
silently at exit — the save-before-exit prompt stays reserved for the
user's own notes. `kind: chat` is the first new
app-understood frontmatter field; `chats/` is indexed like `daily/`, and
plugin chat-note writes run the same announce round as MCP writes
(new `ctx.vault.writeAnnounced`) so the tree, index and open tabs stay
live. The assistant panel went **chat-first** (picker + new chat, turn
cards with collapsible tool chips, streamed partial answers through the
plugin's own `chat:delta` event, zero-context standalone chats,
restart-from-here over note turns, one-shot non-destructive sidecar
import), the composer grew **image chips** (vault picker or paste/drop
staged via the new `api.vault.saveAsset`, sent as vision parts when the
provider has the capability), and the SDK gained additive surfaces
(`MainChatOptions.attachments`, `ctx.llm.capabilities()`,
`api.llm.capabilities()`, `LlmChatResult.toolTrace`;
`PLUGIN_API_VERSION` minor → 2).

### Milestone 24 — assistant composer rework

The Claude-Code-style composer in the assistant panel: a **model row** that
edits the one global `llm.model` through the new `api.llm.listModels()`
facade (provider label + listing capability + best-effort list; hand-entry
always available, `PLUGIN_API_VERSION` minor → 1), **context chips** (the
open note attached by default and deselectable; extra vault files via
`@`-completion or the "+" picker, read at send time as live buffer/vault
content, capped per file), and an **auto-growing composer** (content height
up to a cap, then it scrolls inside; the drag divider and its persisted
height pref are gone). The ask payload became
`{ question, note | null, extraFiles, history }`
(`plugins/assistant/shared/ask.ts` — `note: null` turns the turn
answer-only via a second system prompt). Plus a global
`::-webkit-scrollbar-corner` fix (styling any scrollbar part switches
Chromium to custom painting, and the unstyled corner rendered solid white)
and a templates-picker modal selector fix in passing.

### Milestone 23 — Claude Code CLI provider + visible ask-history validation

The **Claude Code CLI provider** joined the req-29 abstraction
(`electron/llm/providers/claude-code-cli.ts` on `cli-base.ts`):
`claude -p` headless with stream-json output and provider-side session
continuation via `--resume` (`sessionRef`), opt-in and off by default
(ADR-0047). **bug-10(a)** fixed in the same pass: the ask handler validates
the `history` IPC payload and fails visibly instead of silently degrading
to no context, and the renderer always sends an array.

### Milestone 22 — LLM provider abstraction (Req-29 core, ADR-0047)

One provider-neutral `LlmClient` interface with a per-call `LlmRouter`
over `electron/llm/providers/`: the **local OpenAI-compatible** provider
(LM Studio / Ollama / vLLM / llama.cpp / Unsloth, optional bearer key)
plus hosted presets (**OpenRouter**, **Anthropic API**, **Z.ai GLM** —
opt-in, off by default) on one OpenAI-compat client, and an
**Anthropic-Messages** client. Streaming (`onDelta`), provider-side
session continuation (`sessionRef`), a capability descriptor
(tools / streaming / sessions / model listing / image attachments) and a
canonical `ToolSpec` so MCP tools are provider-neutral. No hardcoded model
id — the model stays hand-enterable; `copilot-cli` / `copilot-web` remain
unrouted until their milestones land (see roadmap).

---

## Requirements & fixes

Moved here from the roadmap's former "Completed" chapter.

req-33 — Settings categories in a predictable order. The core
categories read alphabetically ("Add entry", "Appearance", "Daily
notes", "LLM", "MCP", "Panels & plugins", "Spelling", "Vault"), plugin
pages follow sorted by their label, and "About" stays last. This also
fixes real drift: a plugin page actually rendered *after* "About"
(registration order put it behind the last core category) while the
docs claimed "before". The order is pinned by
`settings-registry.service.spec.ts`.

req-34 — context menus reviewed: typical order, separators, keyboard
hints. The editor's right-click menu now reads as three groups —
clipboard (Cut / Copy / Paste / Select all, with their `Ctrl` hints),
base rows, plugin rows — and the base's "Export as PDF…" row can no
longer land below the templates rows (registration order used to
decide, and plugins activate before App's bootstrap, so it did).
`EditorContextMenuRegistry` gained a `{ head: true }` ordering hint
instead of a privileged path (ADR-0030 "Later change"): same registry,
same item shape — base group first, the templates rows last, as
required. The `⋯` menu shows the Save-as chord, the tab menu shows the
split chords, and the Files panel's file menu groups copy/paste before
duplicate/export and reveal/terminal/rename, with delete last as
before.

Plugin-modal click fix — `ui.showModal`'s backdrop dismissed on **every**
mousedown, and the modal box is the backdrop's child, so pressing any
dead spot inside a picker (the "Attach" label, tab-row padding, the gap
between rows) tore the overlay down mid-press; because that happens
before the browser synthesizes `click`, row presses were swallowed too
and the press landed in the app behind — reading as "the modal is
click-transparent". The backdrop now dismisses only when the press lands
on the backdrop itself (affects the assistant's three pickers and the
templates picker alike).

External files as chat context — the assistant's `+` picker gained
"Add a file from this computer …" (native multi-select) and the
composer's paste/drop now routes by extension instead of images-only:
images stage hash-named via `saveAsset` (ADR-0024), text files copy
name-preserving and uniqued (`report-2.md`) into `attachments/` beside
the reference note (active chat, else the open note, else `chats/`),
everything else is skipped with a notice. Staged copies are ordinary
vault files — the chat note's attachment links resolve and replays
re-read them like any other attachment (ADR-0048 paths-not-bodies).
`ctx.vault.saveAsset` joined the plugin SDK (`PLUGIN_API_VERSION` minor
→ 3).

req-20 — `[[wikilinks]]`
([ADR-0046](../docs/09_architecture_decisions/0046-wikilinks.md)):
`[[target]]`, `[[target#heading]]`, `[[target|alias]]`,
`[[target#heading|alias]]` and same-file `[[#heading]]` render as internal
links in Live Preview *and* source mode (accent; unresolved targets muted
with a dotted underline); Live Preview conceals the brackets — with an
alias, everything but the alias. `Ctrl`/`Cmd`-click resolves by
vault-relative path (`.md` appended, case-insensitive) or note basename
(ambiguous → the linking note's folder first, then the shortest path) and
opens the note at the `#heading` anchor's line (open buffer first).
Ctrl-clicking an unresolved link **creates** the note (parents
auto-created) and opens it. Typing after `[[` autocompletes note names
(basename when unique, else the extension-less path). The "Add entry"
drawer renders, completes and follows wikilinks but never creates files.
Built as a base module `src/app/editor/wikilinks/` — regex mark
decorations + completion over the file-tree-derived index, no Lezer node
(the tag-pill route); the conceal layer and `link-open` skip spans the
regex claimed.

req-23 — drag & drop of files **and folders** within the Files panel
(HTML5 DnD,
[ADR-0039](../docs/09_architecture_decisions/0039-drag-and-drop-chrome.md)
"Later change"): drop on a folder row moves into it, on a file row into
that file's folder, on a vault header row to that vault's root (other
vault → cross-vault move, milestone 28). Same-dir
drops and a folder into its own subtree are no-ops (no-drop cursor;
`VaultManager.renameEntry` now guards the subtree case main-side too).
Valid drops run the rename sequence — `renameEntry` (sidecar moves along)
→ `retargetTabs` (open tabs re-point, unsaved buffers survive) →
clipboard remap → the destination expands — and a name collision alerts
without touching anything. Files keep dragging into the editor
(ADR-0028); a folder carries no vault-path data type, so it can only move
inside the panel. *Fix:* file dragstarts announced
`effectAllowed: 'copyLink'` while the tree rows negotiate `move` — an
empty intersection, so Chromium showed no-drop and file drags could
never move (folder drags always worked). Now `copyMove`, with the
editor's `copy` still covered; the spec pins the negotiation.

req-14 — an **optional** chokidar file watcher (Settings → Vault →
"Watch the vault for external changes", off by default — ADR-0045,
amends ADR-0018's "purely additive" clause). One external-change round
in main, shared by all change sources: `VaultWatcher` (chokidar v3 CJS,
`ignoreInitial` + ready gate, dot-entry ignore, `awaitWriteFinish`,
~300 ms debounce for OneDrive bursts) → `OwnWriteLedger` (every
`VaultManager` mutation records itself: content writes as post-write
mtime, structural ops as path+TTL; a match drops the app's own echo —
a missed match costs one redundant refresh, never corruption) →
`VaultChangeAnnouncer` (per-file `write`/`delete` plugin events for
`.md`, then one `vault:changed` renderer push with the changed paths,
capped at 200). The push is the renamed, payload-carrying
`mcp:vault-changed`; `EditorService` auto-reloads **clean** open tabs
among the changed paths (`modifiedMs` finally earning its keep) and
flips tabs of externally deleted files to draft semantics; dirty tabs
stay last-writer-wins, no conflict dialog. The manual refresh button
now runs the same full round in main (`vault:refresh`) — fixing the old
gap where it re-pulled the tree but left the tag/task indexes stale.
New modules `electron/own-write-ledger.ts`, `electron/vault-watcher.ts`,
`electron/vault-change-announcer.ts`; the tags plugin re-indexes a
single file on scoped `write` events (mirroring tasks).

Req-5 — `Ctrl`/`Cmd`-click a link opens it in the OS browser. Already wired
for the document editor (`link-open.ts` `linkActivation` → `Editor.activateLink`
→ `shell.openExternal`, allow-listed to `http(s):` / `mailto:`); extended to
the "Add entry" capture surface (`EntryDrawer.activateLink`, web/mail only —
the drawer has no note path to resolve a relative link against).

Paste-a-URL → Markdown link. Pasting a bare URL onto an **empty** caret now
inserts `[url](url)` with the label pre-selected (`paste-link.ts`
`pasteUrlAsMarkdownLink`, Markdown-only). `@codemirror/lang-markdown`'s own
`pasteURLAsLink` still handles the wrap-a-selection case (`[selection](url)`);
the new handler only fills the empty-caret gap and stays clear of code /
existing links / frontmatter and image pastes.

bug-1 — a bare timestamp (`2026-09-09T00:03:48`) had its `:03:` slice
coloured. Cause: `markdownLanguage` bundles `@lezer/markdown`'s `Emoji`
inline parser, whose `:name:` rule (`/^[a-zA-Z_0-9]+:/`) accepts digits, so
`:03:` parsed as an `Emoji` node. We never render `:shortcode:` emoji — the
parser is now dropped (`markdown({ extensions: [{ remove: ['Emoji'] }] })`).

bug-2 — the Appearance **Theme** (and Editor font) `<select>` always showed
the first option. `<select [value]>` is set before `@for` renders the
`<option>`s, so the browser can't match it. Fixed with `[selected]` on each
option.

bug-3 — the editor typeface stopped applying under a published `@uiw` theme.
Those themes emit `&.cm-editor .cm-scroller { font-family: <mono> }` — the
exact selector `editorStructure` used for `var(--font-sans)` — and the theme
compartment wins at equal specificity regardless of declaration order. The
app rule is now one class heavier (`&.cm-editor.cm-editor .cm-scroller`) so
it outranks any theme outright.

Req-1 — Live Preview embed affordances. The corner **View source** button is
now `</>` (was a pencil) and shares a `.lp-tools` flex cluster with the zoom
lens, so they no longer stack on top of each other (they did on a mermaid
diagram, making the button unclickable). Images gained the `</>` button too;
revealing an image's source now shows the raw `![alt](path)` line inside a
rounded, bordered container **with the rendered image kept directly below
it**. Every text embed's revealed source (table / mermaid / HTML / image)
gets that same container so the active-line highlight reads as in-scope.
See [ADR-0009](../docs/09_architecture_decisions/0009-live-preview-decorations.md)
"Later change".

req-7 — a dock panel's own control row moved into the shared 32px
`PanelFrame` header instead of a band below it. New leaf module
`src/app/dock/panel-header-actions.ts`: `PanelHeaderActionsStore`
(`Map<widgetId, TemplateRef>` signal) + an `[appPanelHeaderActions]="<id>"`
directive on an `<ng-template>` in the panel body; `PanelFrame` renders the
matching template in a `.head-actions` slot — right-aligned, immediately
left of the drag grip — that swallows `mousedown` / `keydown` so a control
click never collapses/drags the panel. Applied to **Tasks** (scope · hide-done · kind
toggles) and **Files** / **Templates** (refresh; Files also collapse-all).
The `files` / `templates` panels' header status values (vault name /
templates dir) were dropped in the same pass so the header reads as
controls, not chrome. Assistant / Search / Calendar left as-is.
See [ADR-0019](../docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)
"Later change — controls in the panel header".

req-8 — the Tasks panel gained a free-text + multi-tag filter with tag
autocomplete. `TaskRecord` now carries `tags` = the inline `#tags` of the
task's heading-section (`scanTasks` reuses `splitSections` +
`extractInlineTags` from `shared/tags`), so `tasks:list` and the live
document scan both provide it. `TaskService` holds `queryTags` / `queryText`
(persisted in `localStorage['drey.tasks']`); `visible` keeps a task when
every query tag matches its section tags (nested tags included, via the
shared `tagSetMatches`) and every whitespace term is a substring of its
text/heading. `TasksPanel` renders a tag-chip input (`<datalist>`
autocomplete over `TagService.tags()`, mirroring the Search panel) + a
free-text field as the first body row.

req-22 (drag-and-drop half) — Calendar drop: drag an Outlook `.ics` / `.msg`
(from the calendar or the file system) onto the editor to insert a
formatted **meeting section** at the drop point: title, date/time,
participants, invitation body and attachment names, auto-tagged
`#mtg/<kebab-case-title>` so it lands in the tag section index. Also
**File → Import meeting …** (native picker) as the fallback for Outlook
drags that deliver no real file (new Outlook / OWA drags do not — save as
`.ics` first, or use Import meeting). The section is rendered from an
editable `templates/meeting.md` (scaffolded from an English default on
first use) via a tiny `{{#if}}` / `{{#each}}` evaluator; `.ics` / `.msg`
are decoded in the main process (`electron/meeting/`, `ical.js` +
`@kenjiuno/msgreader`, the invite's `VTIMEZONE` resolved to local time).
Decode-only — the invite file itself is not copied into the vault. New
`shared/meeting` / `electron/meeting` / `src/app/meeting` feature modules;
the drop branch lives in `image-paste.ts`. The remaining `req-22` scope
(a context-menu "add meeting log" with a per-day appointment picker) is a
follow-up on top of this.
See [ADR-0041](../docs/09_architecture_decisions/0041-calendar-file-drop-meeting-section.md).

In-editor web browser tab (ADR-0042). `File -> New browser tab` /
`Ctrl+Shift+B` opens a fileless `browser://<n>` tab
(`OpenDoc.kind: 'browser'`) whose page is a main-process `WebContentsView`
(`electron/browser/BrowserViewManager`), floated over the Angular layout by
streaming the chrome placeholder's client rect as bounds. `src/app/browser/`
holds `BrowserTab` (toolbar only) and `BrowserViewService` (state, event
reducer, lifecycle -- destroys a view when its `browser://` key leaves
`editor.openDocs()`). `normalizeAddress` sends non-URL input to DuckDuckGo;
the session is an isolated `persist:webtab` partition; each view's
`webContents` gets its own `will-navigate` / `setWindowOpenHandler` (http(s)
popups reopen as tabs) / `context-menu` (nav, clipboard, open-link/image in
a tab, search selection, inspect) and denies every permission request.
`WebContentsView` paints above all DOM, so `OverlayGuardService` + the
`[appOverlayGuard]` directive (+ a `LayoutGestureService` for splitter /
dock drags) hide every view while an overlay or layout drag is active.
Find-in-page via `webContents.findInPage` (`Ctrl+F`). New IPC channels in
`shared/browser` + `electron/ipc/browser-handlers.ts`. Follow-up: restore
open tabs + layout on restart (session history).

Session history (ADR-0043). `SessionService` (`src/app/session/`) persists
the pane layout + open-tab list to `localStorage['drey.session']` and
restores it once at startup (before the daily-note fallback; skipped if the
vault changed). `PaneService` gained `snapshot()` / `restore(keepPath)` —
reversing ADR-0037's 'not persisted' note — which prunes tabs that no
longer resolve and empty panes. Unsaved buffer text is kept in a
main-process backup store (`electron/session/SessionBackupStore`, one
`<uuid>.txt` per tab under `<userData>/session-backups/`, IPC `session:*`):
a never-saved scratch buffer, or unsaved edits re-applied over the fresh
disk read. Persist runs off one debounced effect + `beforeunload` /
`visibilitychange` flushes; backups are reference-counted and orphans
pruned on launch. Browser tabs restore under their exact `browser://<n>`
key. New feature modules `electron/session/` + `src/app/session/`.

bug-9 — Tab inside the editor moved keyboard focus to the next control
instead of inserting anything: `basicSetup` ships no Tab binding at all
(`indentWithTab` is not part of it), so the unbound key fell through to the
browser's focus navigation. `Tab` is now bound on the shared
`MarkdownSurface` (`src/app/editor/editor-indent.ts`, `Prec.highest` so
plugin-contributed keymaps can't shadow it): an empty caret inserts a
literal tab character, a selection indents the selected lines
(`indentMore`), Shift+Tab outdents (`indentLess`); the indent unit is a
literal tab. The binding is gated on `view.editable`, so the read-only
assistant composer stays inert. Deliberate a11y tradeoff (project owner's
call): Tab no longer leaves the editor — `F6` / `Shift+F6` (pane focus)
remain the way out. Covers the full-page editor and the "Add entry" drawer
body (same surface).

bug-7 — the Files panel's arrow keys moved the highlight, but **Enter did
not open** the highlighted file. The rows are focusable `<button>`s and the
selection was only a visual signal — `select()` never moved DOM focus, so
focus stayed on the originally-clicked row and Enter natively re-activated
*that* one. The selected row now takes DOM focus on every keyboard move
(roving `tabindex`, focus-follow in `select()`), so Enter/Space activate the
highlighted row; as a side effect the tree collapses to a single Tab stop
instead of one per row.

bug-6 — intermittent stuck input in the packaged build (no field accepts
text, the Appearance dropdowns stop changing, mouse still works, only a
restart clears it; the Appearance `<select>` blur that closed an open
dropdown under the user was one visible symptom). **Root cause remains
unconfirmed** — the renderer's DOM was exonerated (the keybinding service is
stateless exact-chord matching and never swallows unmatched keys; no focus
trap exists; `user-select: none` does not block typing) — so this pass is
hardening + diagnosability at every plausible layer:
(1) two pointer gestures that set `body { user-select: none }` without the
`data-drey-gesture` marker and without window-blur cleanup — the pane
splitter and the Live-Preview image resize — now carry the marker and end
themselves on window blur, so an alt-tab mid-drag can no longer leak the
style, and the input-recovery watchdog no longer false-positives mid-gesture
(its `recover()` blurs the active element, which is what could close an open
native dropdown);
(2) native context-menu popups (`electron/menu.ts`) are now tracked per
window, closed on window blur/minimize, and logged — an Electron popup whose
capture loop never unwinds is the leading hypothesis for the full symptom
set (invisible, swallows all keyboard, renderer can neither see nor fix it);
(3) "Recover input focus" (View menu / `Mod+Alt+Shift+R`) now also reaches
main (`window:recover-input`) to force-close such a popup, and every step
logs to `drey.log` so a field occurrence finally leaves a trace;
(4) a dead `.menu-backdrop` selector in `InputRecoveryService` was removed.

bug-6 follow-up (2026-09-18) — a reproducible trigger surfaced: deleting a
file via the Files panel's right-click menu left every input field dead (no
caret, typing ignored, mouse selection and Delete/Entf still worked; an
Alt+Tab round trip cleared it). The flow's synchronous `confirm()` is one of
the native blocking dialogs that break Windows keyboard focus
(electron#41602, electron#19977). All renderer `confirm()`/`alert()` calls
are retired: a new in-renderer confirm/message dialog
(`ConfirmDialogService` + `app-confirm-dialog`, the Exit-prompt pattern)
covers the delete / remove-vault / dirty-tab-close prompts and every
Files-panel error alert. Main-side native dialogs
(`showOpenDialog`/`showSaveDialog`/`showMessageBox`) call
`refocusRenderer()` (`electron/focus.ts`) as they resolve, and the
recover-input handler now refocuses the webContents too. A same-day
follow-up closed the last remainder: the plugin SDK gained
`api.ui.showMessage(message, title?)` (minor 8 — the app's own OK-only
dialog, queuing like the native calls did), and the four `window.alert`
calls in the meeting/templates plugins go through it — no native
`alert()`/`confirm()` call is left in the renderer.

bug-8 — the Files panel gained a **multi-selection** (project request):
Ctrl+click toggles rows into the set, Shift+click / Shift+arrow extend a
range over the visible rows, Ctrl+arrow moves the cursor without changing
the selection, Escape collapses back to the cursor row, and right-clicking
inside a multi-selection makes the context menu act on all of it (outside
one, it collapses to the right-clicked row, so Delete can't surprise).
Enter opens every selected file (folders skipped), Delete removes the whole
selection after one count-aware `confirm` — as a single batched IPC call
(`vault:delete-many`, one vault-change re-index for the whole batch, not
per path). Tab-close and clipboard invalidation run per deleted path; a
selection row that lived under a deleted folder is deselected. Dragging a
row still carries that single row's path (req-23 ships single-entry drag;
a drag of the whole multi-selection is still open).

bug-5 — the app now asks before exiting with unsaved changes. Every close
path (titlebar X, Alt+F4, taskbar close/Quit, macOS role close/quit) funnels
into one `BrowserWindow 'close'` interception (`electron/main.ts`): main
holds the window and asks the renderer — which owns the dirty-document
registry — over the `exit:confirm-request` / `exit:decision` bridge pair
(`ExitBridge`, a `McpWriteBridge` copy **without** the 120 s timeout: a
timeout would auto-decide the user's exit; a hung renderer leaves the
window open, and the session backups have the text regardless). Clean
state answers "proceed" without any dialog. With dirty documents an
in-app dialog offers **Save all / Exit without saving / Cancel**:
*Save all* runs `saveAll({ drafts: true, runOnSaveActions: false })` —
real files save straight through, and untitled scratch tabs commit into a
new hidden `<vault>/.drafts/` folder as `unnamed-N.md` (the Notepad++
model, project owner's call: no Save-As dialogs on exit; an explicit
"Save as…" away from `.drafts/` later **moves** the file and deletes the
draft). On-save Actions are suppressed on the exit path only — no LLM
round trips during shutdown (deviation from `saveAll`'s menu behaviour,
flagged here rather than in an ADR). If anything stays dirty after saving
(a failed write), the answer is "cancel" and the app stays open with the
error visible. "Exit without saving" flushes the session backups
(`SessionService.flushNow()` is now public/awaited) before answering —
ADR-0043 keeps the buffers restorable either way. `before-quit` routes an
app-level quit through the same prompt (`quitIntent` flag; the
`!mainWindow` clause keeps the post-approved quit cascade from
re-intercepting).

---

## Phase 1 — MVP & foundation (milestones 1–21)

Condensed to one line per feature area; the full narrative per milestone
is in [`docs/milestones-done.md`](../docs/milestones-done.md), the
behavioural detail in the linked ADRs and the arc42 docs.

- **Shell & dock system** — frameless window, custom titlebar with an HTML
  menu bar, three docks (left/right/bottom) of draggable/resizable/
  collapsible panels, status bar, persisted layout, content-height
  calendar ([ADR-0019](../docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md),
  [ADR-0034](../docs/09_architecture_decisions/0034-internal-widget-model.md)).
- **Editor** — CodeMirror 6 with in-place Live Preview (decoration-based,
  conceal-around-selection, mermaid, tables/images as widgets,
  clickable task checkboxes, `#tag` pills) plus a source mode
  ([ADR-0008](../docs/09_architecture_decisions/0008-editor-mode-menu-and-rendered-preview.md),
  [ADR-0009](../docs/09_architecture_decisions/0009-live-preview-decorations.md),
  [ADR-0025](../docs/09_architecture_decisions/0025-mermaid-live-preview.md)),
  named themes incl. the published CM6 set
  ([ADR-0035](../docs/09_architecture_decisions/0035-named-ui-themes.md)),
  per-file syntax highlighting for non-Markdown
  ([ADR-0036](../docs/09_architecture_decisions/0036-code-file-editor-mode.md)),
  fold gutter, line-number toggle, Tab handling, spellcheck
  ([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).
- **Split-view panes** — arbitrary row/column split tree, per-pane tabs,
  focused-pane facade, tab drag & drop, editor panes dockable into the
  three docks
  ([ADR-0037](../docs/09_architecture_decisions/0037-split-view-editor-panes.md),
  [ADR-0038](../docs/09_architecture_decisions/0038-editor-panes-in-docks.md),
  [ADR-0039](../docs/09_architecture_decisions/0039-drag-and-drop-chrome.md)).
- **Quick-capture & daily notes** — global hotkey, `daily/<y>/<m>/` paths,
  timed entries, startup draft, configurable entry templates (Classic /
  Ruled / own).
- **Template library** — category folders, Templates panel, insert
  (click/drag/context menu/`Ctrl+T` picker), placeholder substitution
  ([ADR-0029](../docs/09_architecture_decisions/0029-template-library.md)).
- **Tags & section search** — free inline `#tag`s (nested), vocabulary +
  inverted section index, tags-AND + free-text search with open-at-line
  and Markdown Export, Autotag button
  ([ADR-0017](../docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md)).
- **Tasks panel** — GFM checkbox / `#task` lines, document or vault scope,
  hide-done, kind filter, tag+text filter, tick-back writes to the source
  file ([ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md)).
- **Assistant & Actions** — per-note sidecar threads, automatic summary,
  Ask with running history, insert-into-note, no-timeout generation with
  cancel ([ADR-0012](../docs/09_architecture_decisions/0012-note-assistant-sidecar-thread.md)),
  trigger→template Actions with the shared confirmation flow
  (inline/split diff, "don't ask again")
  ([ADR-0011](../docs/09_architecture_decisions/0011-unified-confirmation-flow.md)).
- **Settings** — master-detail screen, draft-until-save, `app-config.json`
  under the OS user-data dir
  ([ADR-0010](../docs/09_architecture_decisions/0010-app-settings-storage.md)).
- **Images & attachments** — paste/drop into `attachments/` beside the
  note, `drey-asset://` serving, size syntax + resize grip, zoom/pan
  lightbox, image tabs
  ([ADR-0024](../docs/09_architecture_decisions/0024-binary-vault-asset-write.md),
  [ADR-0026](../docs/09_architecture_decisions/0026-image-viewer-and-lightbox.md),
  [ADR-0028](../docs/09_architecture_decisions/0028-drag-drop-into-the-editor.md),
  [ADR-0027](../docs/09_architecture_decisions/0027-window-dnd-navigation-guard.md)).
- **Meeting import** — `.ics` / `.msg` drop / File → Import meeting →
  templated `#mtg/…` meeting section
  ([ADR-0041](../docs/09_architecture_decisions/0041-calendar-file-drop-meeting-section.md)).
- **In-editor browser tab** — `browser://<n>` tabs over a main-process
  `WebContentsView`
  ([ADR-0042](../docs/09_architecture_decisions/0042-in-editor-web-browser-tab.md)).
- **Session history & exit guard** — restore panes/tabs/unsaved buffers
  across restarts, `.drafts/` auto-save of untitled tabs, the
  exit-with-unsaved-changes prompt
  ([ADR-0043](../docs/09_architecture_decisions/0043-session-history.md)).
- **Refresh model** — manual refresh round, no watcher by default, opt-in
  chokidar watcher with own-write suppression
  ([ADR-0018](../docs/09_architecture_decisions/0018-manual-refresh-no-file-watcher.md),
  [ADR-0045](../docs/09_architecture_decisions/0045-optional-vault-file-watcher.md)).
- **Vault MCP server** — `vault_search` / `vault_read` / `vault_write`
  over hand-rolled JSON-RPC, stdio bridge + opt-in HTTP transport,
  confirmation dialog or YOLO mode, assistant vault tool use
  ([ADR-0021](../docs/09_architecture_decisions/0021-mcp-vault-server.md)).
- **Runtime plugin system** — base application + in-process plugins under
  `plugins/<id>/`, the SDK contract, registries, two-channel IPC,
  Settings → "Panels & plugins", packaging from inside `app.asar`
  ([ADR-0044](../docs/09_architecture_decisions/0044-runtime-plugin-system.md)).
- **Packaging** — electron-builder for Windows, plugins verified from
  `app.asar` (`docs/07_deployment_view.md`).
