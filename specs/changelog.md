### Milestone 173 — The Crew tab and the Accept verb: wording follows the design canvas

**Not yet manually verified by the owner.** Owner request 2026-11-06, outside the list
(canvas "Drey Tickets — Workflow redesign", decisions 10 and 11).

- **Now.** The area is called **Crew** everywhere a user or reader sees it, never "Team": the
  Mission Control tab, menu row and back link, the desktop Crew tab (Work panel `⋯` menu, command
  *Open the Crew*, tab title, header), the Capacity band's **Open Crew ›**, Settings → Tickets
  (**Crew** section, **Edit crew**, *No crew yet*, the page hint and description), the phone's
  manifest and page description. The decision verb is **Accept** (plans and results), never
  "Approve": the checkpoint button reads **Accept → <next column>** (Work panel, ticket page,
  phone), the plan screen is **Plan to accept** with **Accept and run**, the kind chip *Plan to
  accept*, the shaped-with-you line *plan accepted*, the release-stopped error *Accept again to
  continue*.
- **Docs and specs** carry the same words: the manual (regenerated into `public/manual/`), docs/05
  and docs/06, the ADR prose, `docs/design/**`, `specs/roadmap.md`, `specs/ticket-schema.md`,
  `plugins/tickets/*.md`. The canvas files `*.dc.html` under `docs/design/` are the design source
  and were left to the canvas itself.
- **Deliberately unchanged** (`specs/decisions.md`): every stored or contract identifier (the
  `approve` checkpoint action kind, the `sign-off` stage id and its **Sign Off** default title,
  `team/` folders, the tab id `team`, `tickets-team`, `desk-team` classes, IPC, routes, setting
  keys), the tool-call approval of external tools and MCP writes, and the older entries of this
  changelog. The stored values are a roadmap follow-up with their migration.
- **Tests:** the specs and e2e that assert the strings follow (`approve.spec`, `view.spec`,
  `model.spec`, `end-moves.spec`, `work-groups.spec`, `desk-settings.spec`, `team-view.spec`,
- **Concept aligned with the canvas (version 47, same milestone):** `architecture-concept-v2.md` now says what the canvas decides — no tab bar on phone and iPad (one menu behind a button), Notes on mobile, Crew / Accept wording, the five-step text size slider (15 / 16 / 17 / 19 / 21 px, L default), the Notes · Work · Crew view switch with the Layout menu, the 9a ticket card, the Review header and green checks, Confirm / Dismiss proposals, the Anthrazit tokens. What the canvas leaves open or contradicts is **not** rewritten: `convergence-gaps.md` G-36 to G-41 (iPad menu button vs sidebar, desktop web navigation, a canvas sentence slip, the Sign Off column title, the Notes API, the product name Drey Crew).
- **Concept follows canvas version 58 (docs only, same milestone): [consistency audit 2026-11-06: stale state names, decision numbers, the text-size scale and the hamburger wording fixed, an implementation order added (§8.1), open choices listed in convergence-gaps "Open before implementation"]** one state list (Inbox, Shaping, Prioritized, Building, Review, Ready to try, Done; the engine migration is a roadmap item, G-39 reversed), one decision in one place (the Mission Control decision card), the phone menu as root screen, the desktop-like iPad with per-orientation saved panes, editable Notes (G-40 decided, engine work on the roadmap), the cost-by-phase table, the estimate format, and the i18n requirement (decision entry + roadmap item); the Autopilot switch (On / Paused / Off, §6.1, G-42) was approved the same day and is in the concept; req-95 builds it. No code changed.
  `tickets-remote`, `desk-board-team`).

### Milestone 170 — E13-24: Mission Control phone — one app bar on every page

**Not yet manually verified by the owner.** Owner markup 2026-11-06, roadmap E13-24
(`docs/design/work-panel/mc-phone-appbar-*.jpg`).

- **Before.** The shell put the ☰ alone in a row of its own (`.phonebar`) and every page put its
  own header row (title, "‹ Settings / Appearance", "WORK drey-tickets · 1 active") below it.
- **Now.** One shared component, `<mc-app-bar>` (`libs/mission-ui/src/app-bar/`): the leading
  control, the title (+ optional mono sub line) and the page's own status/action (`bar-end` slot)
  in ONE row. Leading = ☰ on a top-level page, **‹ Parent** (`back="Settings"`, `(backed)`) on a
  sub-page. The ☰ opens the chat's history through the `MC_APP_NAV` token (the shell binds it in
  `app.config.ts`; the chat opens its own history with `ownMenu`). The row carries
  `env(safe-area-inset-top)` itself (status bar / Dynamic Island), is `position: sticky; top: 0`
  in its scroll container (D-5b: only the content scrolls) and sits on the page background. From
  768 px the top tab bar replaces the ☰ and the safe-area padding; a page's back control stays
  where the page has no list beside it (Settings hides it, the list is on the left).
- **Pages:** Work (title, vault sub, "n active" chip; the logo mark is gone), Team, Settings (list
  and every sub-page with ‹ Settings), ticket page (‹ Work, id, edit pencil — E13-23 puts its
  Live/View/Source switch into the same `bar-end` slot), the ticket's proof and thread faces
  (‹ Ticket), persona 1:1 (‹ Team, avatar at the end), chat (☰, title, new chat). The shell's
  `.phonebar` row is deleted.
- **Left as it was:** the plan-to-approve and flow-editor layers and the iPad empty pane keep their
  own headers (they are not phone pages of the list above).
- **Tests:** `app-bar.spec.ts` (one row; ☰ vs ‹ by `back`; ☰ asks the shell; back emits and does not
  open the menu), the scroll-contract spec (bar pinned, safe-area padding, no `.phonebar`),
  chat spec updated to the bar. Checked in a 390 px browser against a scratch gateway with English
  data: Work, Settings → Appearance, Team, ticket; the bar stays at `top: 0` while the ticket
  layer scrolls. **Only the owner's iPhone can confirm the safe-area inset** (a desktop browser
  reports 0).
- **Docs:** manual (Mission Control phone).

### Milestone 168 — D-8: the flaky gate specs fixed at the cause

**Production code changed (shutdown only), test infrastructure mostly; not checked in a running app.** Owner request, roadmap D-8. Measurements, causes and rules: [`docs/testing-flakes.md`](../docs/testing-flakes.md).

- **Dominant cause: oversubscription.** vitest ran one worker per core (32), many of them spawning real git / dk; real-git specs crossed the 5 s default and cleanups raced live children. `vitest.plugins.config.mts` caps the workers (cores / 4, 2-8) and puts the process-spawning specs (`packages/**`, `plugins/git/**`) in their own project with a 60 s budget. Two overlapping suites: 12-13 failed tests each before, 10 of 10 runs green after (97 s instead of 175 s).
- **Shutdown that returned too early (production).** `createEngine` kept no handle on its startup `videos.prepare()`; `Engine` has `ready` and `close()` awaits it, `board.idle()` and `git.idle()`. New `TicketsGit.idle()`, `StoreChangeFeed.idle()` (HEAD reads, ref check, sync rounds tracked), `StoreBoardSource.idle()` (+ shadow run), `BoardService.idle()`, `RunSupervisor.idle()` (persists, worker exits, event queue, soft-pause interrupt tracked). `dispose()`/`stop()` stay synchronous.
- **Specs.** `fleet/run-spec-support.ts` (shared by `runs.spec` / `runs-dk.spec`): `settled()` awaits the `onRunSettled` event instead of polling a clock, `waitFor` uses the test's own timeout as ceiling, supervisors are drained before temp dirs are removed. "defers while a run is in its machine gate" had a lost wake-up (release wired inside `execShell`, which can run after the blocker turned true) — a real hang on a slow machine. `videos.limitMb` spec awaits `engine.ready`; the dk file-store specs await `source.idle()` after `dispose()`.
- **Rule** added to CLAUDE.md (Toolchain): await the shutdown before removing a temp dir.

### Milestone 167 — E10-8: Kimi Code as a selectable worker

**Not yet manually verified by the owner.** Owner request 2026-11-05, roadmap E10-8.
Investigation and the full CLI findings: [`docs/design/kimi-worker.md`](../docs/design/kimi-worker.md).

- **Adapter.** `kimi` (label "Kimi Code") is the third worker next to `opencode` and
  `claude-code`: `packages/tickets-engine/src/fleet/kimi.ts` drives `kimi acp` (Agent Client
  Protocol over stdio, pinned against kimi 2.4.1) — not `kimi -p`, which auto-approves everything
  and reports no usage. It maps thoughts, answer text, tool calls and results to the run stream
  (edit line counts from `Write`/`Edit` arguments), holds ACP approval requests as the run's
  permission wait (`answerPermission`) and Kimi's `AskUserQuestion` as a question wait
  (`answerQuestion`; a free-text reply skips the question and rides the next turn), steers by
  cancelling a running turn and prompting next (`inject`), interrupts with `session/cancel`,
  resumes with `session/load` (a failed load → `onResumeFailed`, the supervisor starts fresh),
  compacts with `/compact` (`COMPACT_CAPABILITY.kimi = native`), maps the permission mode
  (`bypass` → ACP `yolo`, `accept-edits` → `auto`) and the model through
  `session/set_config_option`. The run ends on the prompt's `end_turn`; the process is then
  stopped. A `QUESTION:` / `BLOCKED:` final message works as for the other workers.
- **Tokens and cost.** ACP carries neither: `kimi-usage.ts` reads the `usage.record` lines of the
  session's `wire.jsonl` (`~/.kimi-code`, `KIMI_HOME`) after each turn (per-call `turnUsage`,
  totals; a resumed session's earlier spend is skipped) and the cost is computed from
  `core/model-prices.ts` (rows added for the CLI's `k3*` / `kimi-for-coding*` aliases at the
  Kimi K2 rate).
- **Everywhere workers are listed:** `WorkerProviderId` / `WORKER_PROVIDERS`, pool normalisation,
  the chain and orchestrator pools, the runner's adapter table, Settings → Tickets (Default
  worker, column worker choice, Workers switch with pool size and compact threshold), the
  persona worker validation and the Team worker options, the Mission Control labels, the
  `start run` tool text, the model picker (`worker-models.ts`: the aliases of Kimi's
  `config.toml`; `kimi-probe.ts`: installed? has a provider? — the picker's note says "run
  `kimi login`" when not). The default worker stays `opencode`; nothing changes for existing
  boards.
- **Limitations** (design doc; roadmap follow-ups): no budget cap in the CLI, a question has no
  free-text answer, no quiet start (`holdAtSpawn`) and no re-attach after a runner restart, the
  price table is editorial, no quota/rate-limit signal was provoked (an error text from the CLI
  reaches the existing text-based breaker).
- **Tests:** `kimi.spec.ts` (scripted ACP agent with the shapes recorded from the real CLI:
  handshake and brief, mode/model, resume and failed resume, compact first and usage base,
  approval wait and answer, question by label and by free text, `QUESTION:` / `BLOCKED:`,
  steer/interrupt, hold, failing prompt, unsupported request, stop; `parseKimiWire`),
  `kimi-probe.spec.ts`, plus kimi cases in `settings-workers.spec.ts`, `worker-models.spec.ts`,
  `handover.spec.ts`. **Real smoke:** a scratch run through the adapter against the logged-in
  CLI (model `kimi-code/k3` and the config default) wrote a file, streamed its thoughts and tool
  calls, reported 31.9 k tokens in and a cost of $0.019, and exited 0.
- **Docs:** manual (Workers), docs/05, `docs/design/kimi-worker.md`.

### Milestone 166 — E12-9c: the default pipeline is Inbox · Plan · Build · Review · Sign Off · Done

**Not yet manually verified by the owner.** Owner decision 2026-11-05 (answering E12-9b Q1; outside the
list). Design note: `docs/design/work-panel/default-pipeline.md`.

- **New boards.** "Initialize board" writes six columns: `inbox` **Inbox** (manual, capture target) ·
  `plan` **Plan** (agent `plan-default`, claim) · `build` **Build** (agent `build-default`, claim,
  wip 3; the machine gate and proof stay inside Build) · `review` **Review** (manual) · `sign-off`
  **Sign Off** (manual — where the work is committed; takes the role of `commit` and its checkpoint
  discipline) · `done`. The first column is titled **Inbox** again (reverses E12-9's "Ideas",
  milestone 164; the id and folder were always `inbox`). The phone capture button already follows the
  first column's title (*Create in Inbox*). Existing boards and stores keep their columns — a default is
  only written into an empty repository (test with the old five-column pipeline: untouched, same
  columns, same checkpoints).
- **Manual = the human persona (owner ruling 2026-11-05).** Inbox, Review and Sign Off carry `persona: you`
  (`handover: manual` stays); "Initialize board" also writes `personas/you`. The name is configurable:
  Settings → Tickets → Team → *Your name* (`personas.humanName` + one `personaPatch` of the persona's
  title; engine method `setHumanName`); the flow editor's owner label and the Settings chips read the
  persona title instead of a hard-coded "You". Existing boards keep their pins (none) and get the persona
  on first sight as before.
- **Engine rule widened.** `checkpointPhaseIds`: a manual column that directly follows a checkpoint is
  one too, so Sign Off (behind the manual Review) raises Needs-you cards. No shipped pipeline had two
  manual columns after a worker column; the old default's checkpoints are unchanged (spec).
- **dricket.** `DEFAULT_MIGRATION_CONFIG`: stages `inbox plan build review sign-off done`, new `claim:
  ['plan','build']` (the scratch config no longer hard-codes `build|commit`), new `legacyPhases`
  (`prioritized` → `inbox`, `commit` → `sign-off`; matching ids stay; other phases skip as before).
  `stageOfLegacyPhase`, the shadow diff maps legacy phases the same way; the reverse converter takes
  `--stages a,b,c` (default the new six). `scripts/verify-dricket.ps1` seeds the six stages and a
  matching `pipeline.md`. No `blocked` stage (unchanged). Checked against dk v0.6.2
  (`docs/protocol.md`): the first claim stage is now `plan`; Review/Sign Off stay out of `claim` so
  `dk next` never offers owner work to agents.
- **Docs.** Manual (default pipeline, Inbox wording, Accept → Sign Off), `specs/ticket-schema.md`
  (default, folders, checkpoint rule), ADR-0090, `plugins/tickets/BOARD.md` (Sign Off = the commit
  checkpoint), the E12-9 audit rows. `e2e/manual-screenshots.spec.ts` holds no ticket data, so nothing
  to change there; the e2e specs that spell their own five-column pipeline play an existing board.
- **Tests.** `board-service.spec.ts` (six columns, handovers, claim stages, persona pins, checkpoints; rename
  of the human persona; old default untouched), `flow-model.spec.ts` (configured name), `chain.spec.ts` (checkpoints of the new and the old default, the dispatcher works Plan and
  Build only), `convert.spec.ts` (mapping), `roundtrip.spec.ts` (old vocabulary still round-trips; new
  default: toml, and a real-dk re-run migration landing in the new columns with `dk validate` clean).
- **Left out → roadmap E12-9d.** A checkpoint between Plan and Build, an agent "Merge and push" at Sign
  Off, a reverse converter reading the store's stages, the empty *Prioritized* group, E12-9b Q2/Q3.

### Milestone 165 — D-7: the phone chat about a ticket (named tickets, no id prefix, no view bounce, iOS keyboard)

**Not yet manually verified by the owner.** Owner report 2026-11-05, real vault, iPhone; roadmap D-7.

- **(a) Cause — "not in the current board excerpt".** The mission prompt's board digest
  (`boardDigest` in `chat-service.ts`) lists *open* tickets only — the terminal column is
  skipped — and is capped near 2 KB, so a done ticket and any ticket past the cap are invisible to
  the model, which then reasonably says the ticket is not there. Second cause, found while
  reproducing on both backends: an **accepted ticket leaves the board** (`tickets/archive/` on the
  files backend, the `archived` label on dricket), and `readTicket` — the only per-ticket read —
  finds cards on the board only, so even an on-demand read would have failed for exactly the
  tickets the owner asks about (T-0091 is such a ticket).
- **Fix.** `ticketRefsOf` (`core/chat-ticket-refs.ts`) reads `T-0091`, `t-91`, `#91` as one
  canonical id (a word, `#fff`, `ST-91` are no ids; at most five). Each turn the chat service
  attaches the tickets the owner **named** — in this message, else in the last three owner
  messages, so "and who merged it?" keeps its ticket — as a `## Tickets the owner named`
  block after the digest: the ticket's file (cut at 8,000 characters) and, on dricket, its latest
  20 comments; an unknown id is attached as an error line so the model never guesses. New
  `BoardService.readAnyTicket` = the board card, else the archive (both backends). The digest now
  says it lists open tickets only; the mission prompt's rules were adjusted in step
  (`specs/classifier-spec.md`). The block rides the call only, never the session file.
- **(b) No id prefix.** The ticket thread's composer opened prefilled with `<id>: ` and "Change by
  chat" prefilled the chat with the same prefix. Both are gone: the composer opens empty;
  "Change by chat" calls the new `openChat()` (leave the ticket, show the chat, empty draft). The
  thread lists messages that name its ticket, so `threadSend` puts the id in front of a message
  that does not contain it as it goes out (not in the field); the desk resolves it as in (a).
- **(c) The view bounced back after a send.** The ticket screen's per-ticket reset effect read
  `doc()?.id` — a dependency on the whole `doc` computed, which is a new object on every board /
  ticket reload (a sent message triggers one) — so it reset the face to *Ticket* and cleared the
  draft each time. It now tracks a value-compared `docId` computed: the reset happens when the
  ticket changes, not when it reloads.
- **(d) iOS keyboard.** Safari keeps the layout viewport full-height and shrinks and pans the
  *visual* viewport, which pushed header and thread out of view (D-5's `body { inset: 0 }` followed
  the layout viewport). `apps/mission-control/src/app/viewport.ts` publishes `--mc-vh` (visual
  viewport height) and `--mc-vv-top` (its pan) on `<html>` while the keyboard is up (and removes
  them otherwise); `body` is `top/left/right: 0; height: var(--mc-vh, 100%); transform:
  translateY(var(--mc-vv-top, 0px))`. The transform makes the body the containing block of every
  `position: fixed` layer (ticket screen, sheets, overlays), so their `inset: 0` / `bottom: 0`
  follow the visible area too. `100dvh` sizes of the shell and the ticket fullscreen are now
  `100%` of that body; the document is scrolled back to 0 while the keyboard is up.
- **(e) Ghost text.** The phone composer's placeholder was a sample command; it now shows the
  same text as Drey's desktop Assistant composer, "Ask anything …", from one shared constant
  (`shared/composer-placeholder.ts`) both import. The desktop composer itself is unchanged.
- **(f) D-5b — the chrome stays completely fixed** (owner report: small finger movements still
  wobble the page by a few pixels; folded into this milestone because it owns the same viewport
  code). Sources found, each fixed: (1) a finger starting on a bar (header, tab bar, composer
  row) or on a scroller with nothing to scroll still rubber-bands the whole frame on iOS, and a
  scroller dragged past its end chains into it before iOS 16 — `overscroll-behavior` alone cannot
  stop either. New `app/scroll-lock.ts` judges every one-finger `touchmove` (non-passive, document
  level): it goes through only if the nearest scrolling ancestor can still scroll in the dragged
  direction (dominant axis), otherwise it is cancelled; pinch is never touched; the document is put
  back to scroll 0 on any `scroll`. (2) `.shell` had `overflow-x: hidden` only, which computes
  `overflow-y` to `auto` — a second scroller around the real one; it is now `overflow: hidden`, so
  `.pane` owns the scroll of the phone column. (3) The D-7d keyboard logic followed *any* visual
  viewport difference, so a collapsing browser bar or an inset change moved the frame by a few
  pixels, and pinch zoom shrank it: it now reacts only to a drop of at least 120 px (a keyboard)
  and never while zoomed (`scale > 1`).
  Tests: `scroll-lock.spec.ts` (move judgement, scroll-room lookup, a simulated drag on header /
  content / content end / pinch in jsdom), `viewport.spec.ts` (bar collapse, zoom),
  `mission-control-scroll-contract.spec.ts` (shell is no scroller, `.pane` is; both installed at
  boot). **Chromium cannot prove** the iOS behaviour: neither the rubber band of the standalone
  app, the address-bar collapse of Safari, nor `touchmove` cancellation semantics are reproduced
  by it — the owner confirms on the iPhone in the browser and in the installed home-screen app.
  Not covered: scrollers that are themselves fixed layers (`.ticket-layer`, `.persona-layer`) keep
  their own `overflow-y: auto` with `overscroll-behavior: contain`; the touch guard keeps them from
  chaining, but they were not restructured.
- **(f2) D-5b — the trigger and the suspects.** The owner's trigger: after the chat composer has
  been used once (focus, the field grows, blur) the page wobbles by a few pixels for the rest of
  the session — a persistent state change. Suspects, in order of likelihood, all addressed:
  (1) **iOS focus zoom**: the composer text was 14 px; iOS zooms the page in when a field under
  16 px takes focus and can leave it zoomed (`visualViewport.scale > 1`) and pannable after the
  blur — exactly "small finger movements shift everything afterwards". Every text field is now at
  least `max(16px, 1em)` (`!important`, global in `styles.css`; no loss of pinch zoom), and
  `touch-action: manipulation` on `html`/`body` removes the double-tap zoom. (2) **Stale
  keyboard state**: the D-7d variables could stay at the keyboard's values if iOS closes the
  keyboard without a final `visualViewport` resize (Done key, tap outside); `viewport.ts` now also
  re-reads on `focusin`/`focusout` (again at 120/400/900 ms), `orientationchange`, `pageshow`,
  `resize` and every `touchend`. (3) The earlier items of (f) (touch guard, `.shell` no scroller,
  keyboard threshold, zoom ignored).
  **`?debug=scroll`** (`app/scroll-debug.ts`): opt-in overlay; it samples `scrollY`, the visual
  viewport's `offsetTop`/`pageTop`/`scale`/height, `innerHeight`, the body box and the top/bottom
  of `.shell`, `.hdr`, `.phonebar`, `.tabbar`, `.composer`, `mc-root`, logs every change with a
  timestamp and the running event, shows the last lines on screen and offers "copy log"
  (`window.__mcScrollLog`). Nothing is stored or sent. **Repro attempt in Chromium** (iPhone 14
  emulation, production build, stubbed API; scratch script, not committed): jitter drags of 2–8 px
  on header / thread / composer, pulls at both ends, a two-finger touch, a tiny tap, focus + six
  lines in the composer + a faked keyboard (`--mc-vh`) + blur + clearing the draft — 16 checks,
  **no movement** of any bar, of `scrollY`, `visualViewport.offsetTop/pageTop` or the scale (the
  composer only grows and shrinks with its text, as intended). That is the expected result
  for Chromium and proves only the structure; **it cannot prove** the iOS-specific causes — focus
  zoom, a missing keyboard-close resize, the rubber band of Safari and of the installed app. The
  owner confirms on the iPhone (browser and home-screen app), with `?debug=scroll` if it still
  moves, and sends the copied log.
- **Tests (red first):** `core/chat-ticket-refs.spec.ts`; `chat-service-named.spec.ts` (done,
  beyond-the-cap and archived tickets by `T-0091` / `t-91` / `#91`, comments, unknown id, follow-up,
  huge file cut, no read when nothing is named, digest hint); `chat-llm.spec.ts` (block order);
  `board-service.spec.ts` + `board-service-dricket.spec.ts` (`readAnyTicket` on a done and an
  archived ticket on **both backends**; the dricket one runs against a real `dk`);
  `ticket/view.spec.ts` (empty composer, id added on send, `openChat`, reload keeps face and draft —
  verified to fail without the fix); `state.spec.ts` (`openChat`); `chat.spec.ts` (phone placeholder equals the desktop constant); `viewport.spec.ts`;
  `shared/mission-control-scroll-contract.spec.ts` (body is the visible area; nothing sized by
  `100vh`/`100dvh`).
- **Not checked:** no real iPhone / iPad — Chromium cannot reproduce the iOS keyboard's visual
  viewport pan; the logic and the CSS contract are unit-tested only. The real owner vault (T-0091)
  was not touched: the reproduction is a scratch vault and a scratch dricket store in the specs.

### Milestone 169 — E13-20 / E13-21: a ticket opens on what is true, Ticket | Thread | Review on top, old tickets stay openable

**Not yet manually verified by the owner.** Owner request 2026-11-05, roadmap E13-20 and E13-21.

- **E13-20, what opens.** Selecting a ticket opens **one** face: the ticket document while no run has
  happened yet (and once the run is over), the **run's thread** while the runner is active or waiting
  (on a question, a gate, a permission). Drey's Work panel: `openTicketPage` is now
  `defaultFaceOf(ticketRunActive(snapshot, runs, id))` (`renderer/ticket-faces.ts`, over the Work
  list's own row status: running / waiting / failed gate = active); the Work row click and the row
  menu's *Open ticket* use it. The file + thread pair beside each other (ADR-0087 decision 3, the
  `ticketPagePlan` landing matrix) is gone — `ticket-page.ts` keeps only the thread key. Mission
  Control: the ticket view's face starts on the thread when a live run (`/api/fleet` runs now carry
  `ticketId`) or a run need (question, permission, gate; an accept checkpoint or scout report is
  not one) names the ticket (`defaultFaceOf` / `ticketRunActive` in `ticket.model.ts`); read untracked
  per selection, so a run starting later does not pull the face away.
- **E13-20, the control.** One segmented control **Ticket | Thread | Review** above the text, identical on
  all three faces, only the active button differs. Drey: the global `.seg` + `.icon-btn` strip
  (`ticketFaceSwitch`), on top of the ticket document (ticket header), the thread tab and the Review
  tab; the thread's *Ticket file* link is replaced by it. Mission Control: the persona detail's `.seg`
  tab strip, its rules moved to the shared `libs/mission-ui/src/seg.css` (both components use it); Review is
  the proof face. A per-selection choice: no saved view is touched (D-6 contract unchanged).
- **E13-21, the cause.** `readTicket` looked only at the board's columns, and the archive is no column, so
  every done ticket answered "is not on the board"; on dricket the board also never filled
  `recentDone` (the archive is a label there), so *Done this week* was always empty. Fixed:
  `findArchived` reads `tickets/archive/<id>.md` (files) or the record carrying the `archived` label
  (dricket) and answers like any ticket (card phase `archive`); `assembleBoardFromRecords` derives
  `recentDone` from the archived records' `— archived` Log stamp (`archivedRecordFiles`); new engine method
  `archivedTickets({ query, limit })` (`archivedEntriesOf`, any age, newest first, id/title words) and
  `GET /api/archive`.
- **E13-21, the UI.** Drey: a Done row opens its ticket (document, Thread and Review through the card the
  engine returned); **Show older** at the foot of the group loads the archive once and lists the tail under
  a search field (no placeholder text). Mission Control: a *Done this week* group under the phase groups,
  rows open the ticket screen, **Show older** with the same search.
- **E13-23 (folded into this milestone), Mission Control ticket page.** The line "Chain: standard flow + the
  frontmatter delta · tap to adjust" is gone (the gate strip itself still opens the chain sheet); the
  `phase: <id>` text line under the title is gone (the badge at the top carries the phase, now
  **colour-filled** in the phase's colour); the **Live | View | Source** switch (`mc-ticket-mode`)
  **replaces the edit pencil** at the top right of the header (owner correction): View is where the
  ticket is read (the default), picking **Live** or **Source** opens the editor in that mode — the
  editor overlay (`mc-ticket-edit`) now edits the file in the Markdown surface (`mc-markdown`, `[mode]` /
  `[modeBar]`) instead of a plain textarea, shows the same switch on top, and keeps its footer **Save** /
  **Cancel** (Cancel asks "Discard changes?" when dirty; **View** in the switch means Cancel, so unsaved
  text never vanishes silently). Read-only devices show no switch. Nothing else relied on the pencil
  (`toggleEdit` and its CSS are gone; `vm.editing` / `savedFlash` unchanged). Drey's desktop ticket page
  needed none of it: no chain hint, no phase line, and its editor modes are in the `⋯` menu; the iPad
  layout is the same Mission Control view.
- **Tests:** `ticket-faces.spec.ts` (default face from run state, the strip is the same three buttons with
  one active), `view.spec.ts` (MC default face, run/need rules, switching), `work-panel.spec.ts` (Done row
  click, Show older + search), `work.spec.ts` (MC Done group, Show older, `olderDoneOf`),
  `normalize.spec.ts` (`archivedEntriesOf`), `store-board.spec.ts` (`recentDone` from records),
  `board-service.spec.ts` (files backend) and `board-service-dricket.spec.ts` (real `dk`): an archived
  ticket opens, is listed and counts for this week; `router.spec.ts` (`/api/archive`).
- **Docs:** manual (Work panel, interactive start), docs/05, ADR-0087 later change.

### Milestone 171 — D-9: the Tickets panel footer names the dricket store

**Not yet manually verified by the owner.** Roadmap D-9, found by the verify-round sessions.

- **Behaviour.** On `tickets.backend = dricket` the footer no longer says "The tickets vault is not a git
  repository — transitions are not versioned." It shows where the tickets live: "Ticket store <path> ·
  branch tickets · head <sha> · local store", or "… synced every 30 s" for a remote store (checkout path,
  sync period). The old text stays for a files vault that really is no repository. Not shown: a sync age
  (the engine keeps none); the period stands in for it.
- **Code.** `store/store-footer.ts` (`storeFooterLine`, git probes behind the `GitRun` seam, never throws),
  `BoardSnapshot.storeLine` (optional), set with `isGitRepo: true` by `BoardService.dricketSnapshot`; the
  panel draws `.tickets-store-line` (same style as the warning).
- **Specs.** `store-footer.spec.ts` (local, remote, git unavailable). Seen in the running app on a scratch
  store (local and remote), see the sweep in roadmap D-11 – D-22.

### Milestone 172 — E14-7 rehearsal: BOM-safe reader, `--include-archive`, reverse carries comments

**Not yet manually verified by the owner.** Found by rehearsing the cut-over on a copy of the real vault
([`docs/design/dricket/rehearsal-2026-11-06.md`](../docs/design/dricket/rehearsal-2026-11-06.md)); the
guide `cutover-guide.md` was corrected in the same change.

- **Reader:** a ticket file with a UTF-8 byte order mark (an editor on Windows adds one) was "unreadable —
  no front matter fence" (the real `archive/T-0084.md`); the BOM is stripped.
- **`--include-archive`** (default off, OD-7 stays the default): `archive/` migrates as terminal-stage
  tickets with the label `archived` (off the board, readable through `dk ls` / `show` / search and the
  ticket document; links into done tickets stay valid; numbers stay contiguous). The reverse converter
  writes a ticket with that label back into `tickets/archive/`, and the label is not reported as lost.
- **Reverse:** `x-legacy-blocked-by` / `x-legacy-parent` come back as `blocked-by` / `parent` (a link into
  a ticket outside the set was lost on rollback); the CLI now reads the **comments** of a local store
  (`reverse-comments.ts`, from the ticket branch's `comments/` files — `dk` cannot list them) and appends
  them to the `## Log`; before, every comment written on dricket was silently dropped by a rollback.
- **`--report`** into a drive root (`E:\report.md`) failed with `EPERM, mkdir 'E:\'`.
- **Shadow diff (CLI):** an archived ticket and a shortened title are declared differences, not noise.
- **Tests:** `convert.spec.ts` (BOM + CRLF file, `includeArchive`), `roundtrip.spec.ts` (restored
  blocked-by, archived ticket back into `archive/`, declared archive/title), `reverse-comments.spec.ts`.
- **Not fixed, noted in the rehearsal:** after changing `backend` / `dk.store` the engine's first shadow
  report still describes the previous store (roadmap E14-7a).

### Milestone 163 — D-6: selecting a ticket never changes the view, a view saves only by "Save view"

**Not yet manually verified by the owner.** Owner report 2026-11-05, roadmap D-6.

- **Cause 1.** The tickets plugin registered a home-view rule (ticket files of the board vault →
  `tickets.work`, E13-13) and gave its thread and Flow kinds `homeView: tickets.work`;
  `DocOpenService.openFile` asks `HomeViewRouter`, so every ticket opened from the Tickets panel,
  the Files tree, a link or the switcher switched to Work. **Fix:** the rule and the two `homeView`s
  are gone (`registerWorkView(api)` registers the preset only). The ticket opens as a tab in the
  current view's focused pane — no per-view ticket slot is needed; a view's own design decides
  where its tabs go. Board and Team (opened on purpose) still name Work. Mission Control was
  checked: it has no views, `openTicket` there never changes the tab.
- **Cause 2.** There was no "Save view" at all: `DockService.persist` wrote every resize/move into
  `drey.dock` and the session snapshot every tab change into the view's slot. **Fix:**
  `ViewService` keeps a saved layout per view (`drey.views.saved`: dock layout + pane tree);
  `modified` compares the working layout with it (docks, splits, tab sets — not which tab is
  active); the switcher shows a dot with **Save view** / **Revert view** icons, also *View → Save
  view / Revert view* and commands `view.save` / `view.revert`. Revert restores docks and tabs
  (a tab opened since that no other view shows is closed, asking about unsaved text). An unsaved
  change still rides the session restore across a restart, like open tabs, but is never the saved
  layout; the first start adopts each view's current layout as saved.
- **Tests:** `view.service.spec.ts` (modified after resize / tab change, nothing written to the
  saved store, save, revert, switch keeps the working layout, new view starts unmodified),
  `view-preset.spec.ts` (no home rule, Flow kind without `homeView`).
- **Docs:** manual (Views), docs/05, ADR-0089 "Later change — D-6", AUTHORING.
  Not checked in a running app (unit tests and typecheck only).

### E12-10 — Mask audit 2 (documentation only; no milestone number taken, no code changed)

**Not yet manually verified by the owner.** The owner reported on 2026-11-05 that many screens do not match the design. [`docs/design/work-panel/mask-audit-2.md`](../docs/design/work-panel/mask-audit-2.md) audits 16 screen groups (Work panel, Needs you, thread, ticket document, Shape, plan to approve, Ready/Review, Board, Team/Capacity, Flow, Settings, views/tabs/status bar, Assistant, Mission Control Work, and the superseded boards) against the canvas, **with the app running** on English scratch data: Drey under Playwright with isolated engine homes, Mission Control from a scratch engine at phone and iPad size. 60 sized deviations (38 S, 16 M, 6 L), 31 of them new against `convergence-gaps.md`; ten of its rows verified fixed. 28 screenshots are in `docs/design/work-panel/audit-2-screenshots/`. The result is ordered into proposals E12-11 – E12-20 in `specs/roadmap.md` (proposals, marked as such). Not covered, and said so in the document: a waiting-question and a proof/diff ticket on Mission Control, the MC plan card and shape session, the Views menu (judged from code), and pixel measurements against the live canvas (the canvas is not in the repo).

### Tooling — `scripts/verify-dricket.ps1` (part A of the cut-over guide in one command)

**Not yet manually verified by the owner.** A script plus a doc fix, no app behaviour changed: it seeds a scratch dricket store (`E:\dkv`, six English tickets incl. a comment, a dependency and an expired foreign claim) and starts the built app in an isolated profile (own USERPROFILE/APPDATA/userData, so the real `~/.drey-engine` and settings are never touched; `-Remote`, `-Reset`, a before/after fingerprint of the real locations). `cutover-guide.md` part A corrected: no `-Multi` or closing of the normal Drey needed, the engine still needs a tiny tickets vault.

### Milestone 164 — E12-9: default names follow the canvas

**Not yet manually verified by the owner.** Owner report 2026-11-05: the names in the default
configuration do not match the design canvas. The audit is
`docs/design/work-panel/default-names-audit.md` (26 rows, about 55 names: 5 fixed, 4 owned by
existing items E13-14 / E13-15 / E12-7, 3 questions for the owner).

- **Fixed.** A new board's first column is titled **Ideas** (the canvas never says "Inbox"; capture
  lands in Ideas on every board). Only the title changed: the id and folder stay `inbox`, so the
  dricket stage vocabulary, `10-inbox`, `entered-inbox` and the migration are untouched. The phone
  capture button reads `Create in <first column's title>`; the Pipeline settings hint no longer names
  columns; the manual, the `ticket-schema.md` example and the scratch `pipeline.md` of
  `scripts/verify-dricket.ps1` follow.
- **Existing boards keep their names.** `initialize` refuses a vault that has a `pipeline.md`
  and writes nothing; a spec checks that an existing `Inbox` title survives untouched.
- **Not changed (questions).** Whether the default pipeline gains review / verify / approve (Q1),
  whether "Initialize board" seeds the default team Paul, Ben, Ralf, Tessa (Q2), the default worker
  (Q3). dricket side: no change needed; `[stages]` would change only for Q1 or an id rename
  (see the audit).
- **Tests.** `board-service.spec.ts` "default names (E12-9)": new board → Ideas with id `inbox`;
  existing board → refused, file byte-identical, title Inbox.

### Milestone 162 — E14-9a: decommission inventory — class A is empty

**Not yet manually verified by the owner.** Roadmap E14-9 (split by the owner, 2026-11-05):
part (a) now removes only legacy code that the cut-over (E14-7) demonstrably does not need, part
(b) comes after the cut-over and the owner's round. Part (a) is **documentation only**: the
inventory (`docs/design/dricket/decommission.md`) classifies every legacy ticket write path and
piece of machinery with production callers as evidence, and class A turned out **empty**.

- **Why empty.** `tickets.backend=files` is the default and stays the rollback after the flip (the
  reverse converter writes a legacy vault only the `files` backend can run), so the files backend's
  readers and writers are all needed until the owner's round: folder numbering and the drift pass
  (`phase-dirs`, `normalize`, `transition` IO), run and claim stamps (`runs.ts`), the `.status.log`
  writer (`event-writer`), the ledger writers, `FileTicketStore` and `files-guard` are class B;
  the reverse converter, the migration tool's legacy reader, the shadow diff, `ticket-schema.md`
  and the legacy phone remote are class C (the phone remote touches no ticket file but is the
  fallback "until the owner verifies" Mission Control).
- **What the scan also showed.** `core/ticket-files.ts` / `ticket-board.ts` / `transition.ts`'s
  pure patchers are used by the dricket bridge itself, so they are not legacy and not in (b); the
  migration tool imports none of the legacy core, so it is unaffected by any later removal.
- **Class A** is three orphan helpers (`parkLine`, `phaseIdFromTitle`, `columnWorkerPin`, about 40
  lines, no caller outside their own spec) — not part of the decommission, left for part (b).
- **Specs, docs:** roadmap E14-9 → **E14-9b** with the exact class B/C scope; ADR-0090 "Later
  change — the decommission is split"; migration plan §7/§8 and `docs/05` point at the inventory.
  No code changed, so no test was added or removed; `ticket-schema.md` stays until (b).

### Milestone 161 — E14-8: change detection hardened, checked in a running app

**Not yet manually verified by the owner.** Roadmap E14-8, ADR-0090. The watcher, the
own-write announcements and the periodic `dk sync` of milestones 154/156 were provoked on
Windows and then run **in the built app** against a scratch store. `files` stays the default;
the owner's `~/.drey-engine`, live board and `drey-tickets` repository were not touched
(temp home, temp store, the spawned engine killed after each test).

- **What was provoked** (raw `fs.watch` recursive on a scratch store, foreign `dk`/`git`
  subprocesses): 20 serial `dk add` — all 20 tickets reported; `git reset --hard` over 15
  tickets and back, a branch checkout that rewrites the tree — every changed ticket file reported,
  last event within a few ms of the end. **One real miss:** while the event loop is blocked for
  seconds (a busy process), Windows' change buffer overflows — 6 adds produced one event. Nothing
  was lost in normal operation, so the ref check was built as a safety net, not as the mechanism.
  (`.git` churn is most of all events and cannot be excluded by `fs.watch`; it is filtered
  after the fact.)
- **Debounce** (`store-change-feed.ts`): trailing quiet period (200 ms) with a ceiling
  (`maxWaitMs`, 1 s) instead of a window from the first event — a commit that rewrites many files
  is one announcement of the finished tree, and a burst that never goes quiet still announces.
- **Own-write echo, no longer swallowed blind.** A foreign write that landed inside the 200 ms after
  an own write used to wait for the next event. Now an own write remembers HEAD; events in the echo
  window announce again only when HEAD moved (a foreign commit), else they count as dropped echoes.
- **Ref check** (miss detection): every 10 s the checkout's HEAD (`git rev-parse HEAD`, ~50 ms)
  is compared with the last announced one; a move no watcher event reported announces, is counted
  (`refMisses`) and logged once as a warning. Skipped while a watcher event is pending or fresh.
  `StoreBoardSource.changeStats()` exposes the counters (announcements, watcher events, dropped echoes,
  ref misses, syncs, skipped syncs).
- **Remote store:** the periodic `dk sync` now asks `git ls-remote` first (plain git, no new dk
  feature: dk v0.6.2 has no `changes` verb) and skips the sync while the remote tip is the
  checkout's HEAD — ~150 ms against ~400 ms for a `dk sync` that finds nothing (local remote). The
  upstream is read once; any failure answers "moved" (sync as before). On-demand syncs (refresh,
  board open, before a claim) always run in full.
- **Plugin-managed checkout.** SDK **1.45**: `ctx.vault.markManaged` also takes a list; the tickets
  plugin flags every registered vault that holds the dricket checkout (the checkout vault itself or a
  bigger vault around it), so Source control refuses commit/push/discard there ("Managed by Tickets")
  and the flag clears when the backend is off.
- **Checked in the running app** (`e2e/tickets-dricket-live.spec.ts`, built app, scratch store,
  temp engine home; screenshots in the session notes folder): a foreign `dk add` on the board after
  ~1.0–1.1 s (the `dk` run itself is ~0.6 s); a burst of 8 foreign adds — every row there, the last
  about a second after `dk` returned at worst; a foreign `dk put` rewrite of a title on the board
  after ~1.3–1.6 s; the board's own write (`setPriority` = one `dk put`) followed at once by a
  foreign add — both on the board; a ticket document opened from the row menu, edited and saved with
  Ctrl+S — the store gained `dricket: put t-1`; the git plugin reports the checkout vault as
  "Managed by Tickets". Remote store (bare remote, separate clone as checkout, sync every 2 s): a push
  from elsewhere on the board after ~3.0 s; the board's own write is on the remote at once.
- **Specs:** `store-change-feed.spec.ts` (ceiling, own-write echo with and without HEAD, miss
  detection, no false miss while the watcher is on it, probe-gated sync), `store-git-probe.spec.ts`
  (fake git + real git), `dricket-file-store-dk.spec.ts` (real watcher + real `dk`: burst, foreign
  write right behind an own write, a silent watcher caught by the ref check), `ticket-documents.spec.ts`,
  `managed-vaults.spec.ts`, `e2e/tickets-dricket-live.spec.ts` (skipped without `dk` >= 0.6.2).
- **Not checked / known limits:** no real network remote (a local bare repository stands in; the
  probe's timing over a network is unmeasured); the e2e needs `dist/mission-control` built (the
  engine refuses to start without it); the engine's own log is in the temp home, which the spec
  removes (`DKL_KEEP=1` keeps it); the 10 s ref-check period and the 1 s ceiling are judgement
  values, not tuned against a long real-use log; the managed flag follows the board refresh and the
  ticket-document open (a checkout vault registered later is flagged at the next one); the legacy
  tickets vault is not flagged by the standalone engine (`markManaged` there is a no-op) — unchanged.

### Milestone 160 — E14-5b: the chain on a dricket store, in-claim chapters, wait release, leftover claims

**Not yet manually verified by the owner.** Owner request (roadmap E14-5b, ADR-0090 later
change). With `tickets.backend = dricket` the chain orchestrator now reads its board from the
store's checkout and writes only through `dk`; the `chainRefusal` is lifted (it now only asks for a
checkout). `files` stays the default; nothing in the running system changed. **Checked against a
real `dk` on scratch stores only** — never the owner's board, `drey-tickets` or a live fleet run.

- **The chain on a store** (`fleet/store-chain-board.ts`, new; `orchestrator.ts`): `ChainConfig.store`
  (`ChainStoreConfig`: dk path, store, data dir, checkout, trailers) rides `/chain/config`;
  `ticketsVaultPath` stays the **meta vault** (pipeline, repos, personas, prompts, worktree home).
  The board is `assembleBoardFromRecords` over `FileStoreReader` — the same assembly the engine's
  board uses; a ticket whose lease ran out reads as unclaimed, so the dispatch **is** the takeover. The
  chain's own writes are legacy-shaped text patches turned into a document by `legacy-bridge` and
  written with `dk put --claim --if-version <rev>`: the ci move, the breaker's park to `inbox`, the
  manual-gate park (`awaiting`), the ci Log line. The chain never stamps a claim (dk owns them; the run's
  lease claims). Status verbs are comments: `paused:` for both parks; a settled run's `done:`/`failed:`/
  `blocked:` already came from the run's own release (E14-6), so `noteSettledStatus` is skipped on a
  store, and `working:` is not persisted. The dispatched request carries `dk` (`fleet/dk-target.ts`
  `dkTargetFor`, now shared with the board's owner-started runs) and the stage as the next phase
  (no phase folders).
- **`## Verlauf` inside the claim** (`RunLease.patchInClaim`, `runs.ts` `verlaufInClaim`): the run's
  Verlauf line is one `dk put -F` **without** `--claim`/`--if-version` (`PutOptions.holdsClaim`;
  dk refuses `--claim` on a ticket the writer holds, the claim fences a stale writer with exit 13),
  written just before the release of a green move, a park or a stay-put release. The settle no longer skips it
  on dricket. The persona lesson (`memory.md`) is a meta-vault file, not a ticket write: unchanged.
- **R-31 needed no dricket work.** Test against dk v0.6.2: `put --claim` is refused while the writer
  holds the claim ("--claim is for unclaimed tickets"), `release --stage <same>` is refused for an agent
  claim (exit 14) — but once the ticket is released one stage back, `put --claim --if-version` with
  the stage line set back **does** move it into the claim stage unclaimed (agent actor, validated).
  `RunLease.release(..., { restoreTo })` does exactly that when the same-stage release was refused:
  two commits and a short stop one column left, the card ends where it sat. R-31 stays "Nice" in
  `dricket-requirements.md` (one commit instead of two); not requested.
- **Needs-input = release + re-claim (Q-03)** (`runs.ts` `releaseForWait` / `reclaimAfterWait`): when the
  worker starts waiting for the owner (question or approval) the run comments `needs-decision: [run-<id>-waits]
  <question>`, releases to the store's `needs-input` stage when the pipeline has one (`RunDkTarget.needsInputStage`),
  else keeps the stage, unclaimed; the answer (`answerQuestion` / `answerPermission`, or a `waiting: null`
  event) re-claims **before** the worker is told (a new epoch), then writes `resolved: <key>`. Someone else
  holds the ticket then: the answer is refused and the worker gets nothing. Not done while commit trailers
  are on (the epoch they carry must stand) and not for the owner's own dialog.
- **Leftover claims** (`RunSupervisor.releaseLeftoverClaims`): every ticket owned by an `agent-…@<this host>`
  identity that no starting/running/stopping run of the runner holds is released **as that owner**, back
  where it sat (R-31 write-back) or one stage back. The runner runs it once per store before the chain's first
  dispatch (`OrchestratorDeps.releaseLeftovers`, then re-reads the board) and the owner can ask for it:
  `POST /claims/release-leftovers` on the runner, `FleetPort.releaseLeftoverClaims`, the tickets plugin's
  `chainReleaseLeftovers` invoke method. A boot-adopted run's own claim was already released at `adopt`
  (the same owner id); this covers the rest. Another host's agent claims and humans' claims are left alone.
- **Real checks (scratch stores `E:\dkb3x`, `E:\dkb3y`, 1-minute leases through `dricket.toml`):** a real
  `RunSupervisor` over a real dk claimed a ticket, the process was killed with `Stop-Process -Force` (the
  Windows SIGKILL): the claim stayed (`dk claim` by another owner: exit 11, "claimed by agent-r-…@host"); a fresh
  runner's `releaseLeftoverClaims` freed it at once, the ticket back in `build` unclaimed (epoch kept, validate
  clean). The slow half — a takeover by another actor after lease + the fixed 20 min grace — ran in the background;
  its result is in the hand-over note.
- **Specs:** `runs-dk.spec.ts` (+8: R-31 write-back and its failure, Verlauf inside the claim and not for an empty run,
  the wait release/re-claim, a refused re-claim, trailers keep the claim, leftovers), `run-lease-dk.spec.ts` (+2, real
  dk: write-back with an agent actor, the in-claim write keeps owner and epoch, release for a wait and re-claim = a new
  epoch), `orchestrator-store.spec.ts` (5: dispatch with the dk target and no ticket file, a held ticket, leftovers once,
  the ci move and its red Log line as puts), `chain-store-dk.spec.ts` (real dk: the chain dispatches from a real checkout
  and moves a ci-green ticket with one real put, `dk validate` clean), `board-service-dricket.spec.ts` (the chain
  config names the store, the refusal is only a missing checkout).
- **Not done (roadmap "E14-5c"):** the worker's own ticket chapters (`## Handover`, plan criteria) have **no door**
  on a store yet — the instruction names a ticket path the worker cannot edit there, so a plan column on a store gets its
  acceptance criteria only from the card; a "release leftover claims" **button** in Drey / Mission Control (the invoke
  method and route exist); a re-claim after a wait lands in dk's first claim stage (unchecked for a ticket that waited in
  a later one); the chain on a **remote** store (the runner does not `dk sync`; the engine's feed does); a real run with a
  real worker on a second instance.

### Milestone 159 — E14-6: comments, signals and the ledger on a dricket store

**Not yet manually verified by the owner.** Owner request (roadmap E14-6, ADR-0090 later
change). With `tickets.backend = dricket` the status verbs, the send-back note and the
Needs-you answer are **comments** (`dk comment`), read back from the `comments/` files of the
checkout — no dk feature was missing (dk v0.6.1 has no comment list, R-08; Drey reads the files
itself, owner decision 2026-11-05). `files` stays the default; nothing in the running system
changed. **Not checked in a running app** (see Not done).

- **Status verbs as comments** (`core/status-comment.ts`, new): line one of a comment is the
  status line (`needs-decision: [key] text`, `blocked: [key] text`, `resolved: key`, `done:`,
  `failed:`, `paused:`) parsed by the status log's own parser, the comment's timestamp is its
  `at`; detail may follow a blank line. `working:` is never persisted; a keyless `resolved:`
  (which closes nothing) is refused. `statusOf` — and with it the Needs-you list — reads the
  comments on a store, the `.status.log` on files.
- **Send-back note** (`sendBack`): the move keeps the short `sent back:` Log line the story
  reads, and the whole note is now a comment on the ticket.
- **Needs-you answer** (`answerNeed`, invoke method + `POST /api/tickets/<id>/answer`
  `{ key?, text? }`): writes `resolved: <key>` with the answer as detail; the key defaults to the
  ticket's only open one, an unknown or already closed key is refused. On the files backend it
  writes the `resolved` status line (the text has no home there).
- **A dk run's end is a status comment**: a green move leads `done: handed over on <stage>`,
  a manual-step park `done: ... a manual step waits for <persona>`, a `BLOCKED:` end
  `blocked: [run-<id>] <reason>` (a key the owner's answer can close), a failed run
  `failed: <gate line or error>`; the run's own words follow as detail.
- **The board shows the comments**: `readTicket` carries `comments` (author, time, text, verb,
  key; store only), `ticketComments(id)` is an invoke method, Mission Control's ticket view
  has a Comments section (`TicketDetail.comments`).
- **Ledger**: `tickets/_meta/ledger.jsonl` stays in the meta vault — the vault pipeline, repos
  and personas already live in (E14-2: the board reads them from there on a store, too) — so there was nothing to
  relocate; what changed is that a store board writes no `phase` line (dk's history derives
  it) and that no status file or ledger line goes anywhere near the checkout.
- **Order inside one second:** dk names a comment file `<second>-<author>.md`, so the store has no order
  finer than a second (same second = author-name order). A `resolved:` sorting before the decision it closes
  would leave that decision open, so `statusLinesOfComments` / `commentViewsOf` fold the opening lines of a
  timestamp before its `resolved:` (stable otherwise). Found when the board-service spec compared two
  same-second comments; the spec now treats their relative order as unspecified.
- **Specs:** `status-comment.spec.ts` (6), `board-service-dricket.spec.ts` (real dk: comments,
  send-back, open decision, answer, default key, refusals, no phase line, no status file),
  `runs-dk.spec.ts` (the leading verbs), `router.spec.ts` (answer route), `dto.spec.ts`.
- **Not done (roadmap "E14-6 follow-ups"):** the chain orchestrator's own status events (it is
  refused on dricket until E14-5b); handing an answer to the persona's next run and the
  `needs-input` release/re-claim (Q-03); an answer button in Mission Control / Drey; the story
  builder reading comments; a comment composer; a run on a second instance.

### Milestone 158 — E14-3b: the migration writes the ticket files itself, no placeholders

**Not yet manually verified by the owner.** Owner decision 2026-11-05 (roadmap E14-3b,
ADR-0090, `docs/design/dricket/dricket-requirements.md` decisions): Drey has one user, so
the migration does not wait for dricket's R-28 / R-10. `apply.ts` no longer calls
`dk add` / `dk put`; it writes `tickets/t/<shard>/t-N/ticket.md` (+ `comments/`) in the
exact format of dricket's `docs/protocol.md` and commits them to the scratch store's
`tickets` branch with plain git. Nothing in the running system changed; the owner's
`drey-tickets` repository, live board and `~/.drey-engine` were not touched (a copy of the
vault was read).

- **No placeholder pass:** the legacy number is the ticket number (`t-91`), gaps stay gaps
  (the protocol allows them): the 22 owner-triaged tickets are 22 tickets, not 91 records.
  `ConversionPlan.placeholderNumbers`, the `placeholder` outcome, the dry-run/report lines
  for it and the CLI's reverse skip are gone (the board's and shadow diff's read-side filter
  for old placeholder labels stays, harmlessly, for the old scratch stores).
- **Real creation data:** `created_at` / `created_by` are the legacy creation stamp and
  creator (the fallback is the apply time / the migrating identity, with a warning);
  `x-created-at` / `x-created-by` are no longer written.
- **Git publication:** one `git fast-import` stream into a temporary ref, one commit per
  ticket in ascending number order (the protocol's replay wants one ticket per commit; a
  blocker note rides in its ticket's commit), then one fast-forward-only publication:
  `merge --ff-only` when the branch is checked out (ref, index and tree together), else
  `update-ref old -> new` (compare-and-swap). Linear history, never a force; a pre-flight
  checks id, body size (100 000 bytes) and the `x-` field limits before the first byte is
  written, a store that already holds tickets is refused.
- **Kept:** the dry-run report, the scratch-store guard and Windows path limit, the
  allow list, `--allow-live-runs`, the report file (now with commit count and the
  `dk validate` verdict). The CLI runs `dk validate` after the apply and exits non-zero if
  it fails.
- **Checked:** `dk` v0.6.1 against a copy of the real vault, the 22-id allow list, into the
  fresh store `E:/dkb2/s`: 22 commits (+ the one comment), `dk validate` clean (history
  replay included), the CLI's shadow diff identical (1 declared: T-0017's dangling
  `blocked-by T-0049`), and the board built by the `tickets.backend = shadow` code path
  (`StoreBoardSource.runShadow`) equal to the legacy board for the 22 tickets: 1
  difference (T-0017 `blockedBy`, declared), 2 tickets only in the legacy board (T-0088,
  T-0090 -- created after the allow list was written, not on it).
- **Tests:** `roundtrip.spec.ts` real-dk half now applies 7 fixture tickets incl. the high
  numbers (`validate` clean, creation data, one commit per ticket on a linear branch,
  checkout up to date, comment file, no temp ref left, second apply refused);
  `convert.spec.ts` for the number/creation data.
- **Differences from the old apply:** `rev` of a fresh ticket is 0 (dk's `add` made 0, the
  old `put` 1); commit author is the migrating actor (`<actor>@dricket.invalid`), commit
  time is the apply time.

### Milestone 157 — E14-5: the fleet runner claims through `dk`

**Not yet manually verified by the owner.** Owner request (roadmap E14-5, ADR-0090 later
change). With `tickets.backend = dricket` a fleet run now claims its ticket through `dk`
before anything else, keeps the lease alive, and gives the ticket up through `dk release`
— and writes **no ticket file** (no `run:` stamp, no Log line, no folder move, no
bookkeeping commit). The `files` backend is untouched: a run request without `dk` takes
exactly the old paths. **Scope:** the owner-started run (card ▶, the dialogs, the
Assistant) — the chain orchestrator is E14-5b (roadmap); the chain refuses to switch on
while the board runs on dricket, so it can never dispatch from stale files.

- **`RunLease`** (`fleet/run-lease.ts`, new): one per run, over the `TicketStore` port.
  `claim()` (shows the stage first, then `dk claim --kind agent`, idempotent for the same
  owner), a keep-alive that extends at half the time left (`dk extend`, min 30 s, retried
  after 60 s, ended quietly when dk's extension budget is spent), `release(candidates, note)`
  and `comment()`. **Exit 13 anywhere fences the lease**: the keep-alive stops, nothing is
  written any more, `onLost` fires once. The owner id is `agent-<run id>@<host>` in dk's
  owner grammar — stable per run, so a runner that restarts re-claims its own ticket
  idempotently (`resumeLease` in `adopt`).
- **`RunSupervisor`** (`fleet/runs.ts`): `request.dk` (`RunDkTarget`: bin, store, dataDir,
  checkout, park stage, retreat stage, trailers) switches the run onto dricket. **The claim
  is the first thing `start` does** — a ticket someone else holds (exit 11) refuses the
  start before a worktree is prepared or a worker spawns; a worktree failure gives the
  claim back. Every ticket write funnels through `patchTicket` (now a no-op on dk) and
  the one give-up point `clearRunStamp` (now `releaseDk`). **Green gate + next phase** =
  `release --stage <next phase>` (the release IS the move). **Park** (a manual step
  follows, or the worker ended `BLOCKED:`) = comment + release to the park stage, which is
  `blocked` only when the pipeline has such a phase — the owner's migrated store has no
  `blocked` stage, so the ticket then keeps its stage with the comment. **Failed /
  stopped / done-without-move** = release back to where the ticket sat before the claim
  (dk may have moved it into the claim stage); if dk refuses (an agent may not release
  `build -> build`) the stage before the working one (`retreatStage`). **Exit 13**
  (`onClaimLost`): the worker is stopped, the run fails with "claim lost", no release, no
  comment — takeover by lease is dk's decision (claim after `lease_until` + 20 min grace),
  the stale runner finds out at its next call.
- **The note is a comment, never `release -m`** — dk's `-m` replaces the body chapters
  between `## Result` and `## Log` (dricket R-21, still open in v0.6.1), and Drey's tickets
  keep several there. `TicketStore.comment` is new (`dk comment -m`; `FileTicketStore`
  refuses).
- **Trailers (opt-in, `tickets.dk.trailers`)**: the worker's instruction gets the four
  `Dricket-*` trailers with the claim's epoch (`## Commit trailers`), and the gate runs
  `dk validate --trailers <base>..HEAD` in the worktree after the acceptance commands; a
  commit without them is a red gate. Workers never see `dk` or its identity.
- **Board service**: `startRun` no longer refuses on dricket — it reads the card text from
  the store (`readCardText`), composes the request with `dk` (`runTarget`) and hands it to
  the runner. `setClaim` on dricket is a human's `dk claim` (takeover only after a lease
  ran out — dk's exit 11 is the answer, not a TypeScript rule) / `dk release` at the card's
  stage. `chainRefusal()` + the plugin's chain commands: the chain cannot be switched on
  on dricket (E14-5b), and `syncChainConfig` never points the dispatcher at a vault whose
  tickets live in a store.
- **Specs:** `run-lease.spec.ts` (8: owner grammar, trailer lines, claim + keep-alive
  schedule, exit 13 fence, retry/budget, comment-then-release candidate walk, refused
  claim), `runs-dk.spec.ts` (12: claim before worktree and worker, refused start spawns
  nothing, green move = release with comment and an untouched vault, red gate, retreat
  stage, park with and without a park stage, unknown-stage fallback, `BLOCKED:`, exit 13
  on the extension and on the release, trailers + red gate, no `dk` → no store call),
  `run-lease-dk.spec.ts` (against a real `dk` on a scratch store: claim, foreign claim
  refused, extend, comment, release, epoch kept), `board-service-dricket.spec.ts`
  (takeover/release through dk, `startRun` composes the request with the store, the chain
  refusal). Specs replaced: "refuses the fleet-owned writes until E14-5".
- **Not done (roadmap E14-5b):** the chain orchestrator on a store; `## Verlauf` /
  `## Handover` / `## Verification` written inside the claim (the settle's Verlauf line is
  skipped on dricket — no data is lost, the chapter just stops growing for dk runs);
  workers still read their brief from the request, but a worker that edits the ticket
  chapters has no door yet; needs-input release/re-claim (Q-03); the real takeover run
  (SIGKILL a run, wait out a shortened lease) and a real run on a throw-away ticket were
  not made.

### Milestone 156 — E14-4c: ticket documents of a dricket store in the editor, saved through the engine

**Not yet manually verified by the owner.** Owner request (roadmap E14-4c, ADR-0090
later change). With `tickets.backend = dricket` a ticket opens in an editor tab from
the store's checkout and its save is a `dk put`, never a file write; every other route
that would change those files is refused. `files` stays the default; nothing in the
running system changed. **Not checked in a running app** (see Known limits).

- **A new base seam, SDK 1.44 `ctx.vault.routeDocuments(route)`** (`DocumentRoute`:
  `owns(vaultId, path)`, `save(request)`): a plugin claims documents it writes through
  its own engine. `electron/plugin-host/document-routes.ts` holds the claims (one per
  plugin, dropped on deactivation); `NoteManager.saveNote` hands an owned document to
  `route.save` **before** the mtime guard — nothing is written there, `updated:` is not
  bumped, no save hook fires — and maps the route's answer onto the ordinary
  `NoteSaveResult` (a `conflict` becomes the ADR-0060 merge view). `VaultManager` got a
  mutation guard (`assertMutable`) on `writeFile`, `writeBinaryFile`, `createFile`,
  `createDirectory`, `deleteEntry`, `renameEntry` (both ends) and `copyEntry` (destination):
  the file tree, MCP/assistant vault tools and plugins all meet "… is managed by Tickets
  and cannot be changed here". Reading and opening are never refused. This is the
  roadmap's "`note:save` hook plus read-only guard": a hook after the write could not
  prevent the file write, so the interception sits in front of it.
- **Engine** (`EngineBoardService`, invoke methods `ticketDocument`, `saveDocument`):
  `ticketDocument({id})` → `{ checkout, path }` (`tickets/<prefix>/<shard>/<id>/ticket.md`,
  `store/document-paths.ts`) or null off dricket; `saveDocument({path, text, force})` →
  `put --claim --if-version <rev>` on the **raw dricket document** with the `rev` read
  from the text itself (the tab's), through the same single writer and queue as the board.
  Exit 12 comes back as `{ conflict: { text, rev } }` with the stored document, nothing
  written; `force` (the merge was resolved against the stored document) re-bases on the
  rev dk has now; dk's own refusal is an `error`. Deviation from the roadmap wording:
  the existing `ticketSave` takes the *legacy-shaped* text the phone edits, so the tab —
  which shows the dricket file — gets its own method instead of a second bridge.
- **Plugin** (`plugins/tickets/main/ticket-documents.ts`): the checkout must be (or lie
  inside) a registered vault; `TicketDocuments` owns that vault's `tickets/` tree,
  translates vault paths to checkout paths, and answers the save with the document as
  stored (LF) and its mtime. Opening a ticket (`openTicketPage`, the thread's "Ticket
  file", the Review tab) asks `ticketDocument`; when the checkout is no vault yet the
  user is asked once ("Add the ticket checkout as a vault?") before `ctx.vault.register`.
  The store keys (`backend`, `dk.*`) are pushed to the engine on every board fetch, so a
  changed checkout applies without a restart.
- **Settings → Tickets → Ticket store:** "Checkout" (`tickets.dk.checkout`) and "Sync
  interval — seconds" (`tickets.dk.syncSeconds`, empty = 30, 0 = off).
- **Specs:** `board-service-dricket.spec.ts` (real dk: location, save, stale rev =
  conflict, force, non-document path), `document-paths.spec.ts`, `ticket-documents.spec.ts`
  (ownership, nesting in a bigger vault, register-on-ask, save/force/conflict/refusal),
  `note-manager.spec.ts` (route, conflict, the guard on every route),
  `plugin-context.spec.ts` (`routeDocuments`).
- **Known limits:** a checkout document is a plain tab — the ticket header strip, the
  thread pairing and the Shape marks key on the vault card path; the checkout vault is
  not marked managed in Source control (one claim per plugin); `saveAsset` into the
  checkout's `tickets/` tree is unguarded; after an exit 12 the merge result keeps the
  tab's own `rev:` line, which is why a forced save re-bases on the stored rev instead
  of reading it. The 5 s ref check was not built (the watcher was not seen to miss);
  the live check of watcher, write moves and editor save on a second instance moves to
  E14-8.

### Fix — shadow run of the board on the migrated store (E14-2 follow-up)

**Not yet manually verified by the owner.** `tickets.backend = shadow` driven against a fresh
migration of the legacy vault (25 non-done tickets + 66 placeholders = 91 records, dk v0.6.1;
an isolated engine home, copies of `drey-tickets` and of the store — the owner's
`~/.drey-engine`, the live board and `E:dkbmig` were not touched).

- **Result:** 24 of 25 tickets identical, 1 declared difference (T-0017: the legacy
  `blocked-by T-0049` points at a done ticket outside the migrated set; the migration drops
  it by design), column order identical. The first run against the owner's earlier store
  also showed T-0088..T-0090 as placeholders — created in the legacy vault after that
  apply (data drift, gone after a re-migration).
- **Reader bug fixed:** `assembleBoardFromRecords` showed the 66 import placeholders
  (label `placeholder`, stage `cancelled`, "Unused number T-00xx") as cards in the terminal
  column. They keep a number free and are not tickets: the board now leaves them off, like
  archived records (`PLACEHOLDER_LABEL` in `store/legacy-bridge.ts`). Spec in `store-board.spec.ts`.
- Findings for the cut-over are in the roadmap (E14-2 follow-ups).

### Milestone 155 — E14-4b: the board's write moves on the `dk put` path

**Not yet manually verified by the owner.** Owner request (roadmap E14-4b, ADR-0090
later change). With `tickets.backend = dricket` every ticket write of the board
service goes through the milestone-154 door (`dk put --claim --if-version <rev>`),
never as a file. `files` stays the default; nothing in the running system changed.
**Scope:** everything of E14-4b except the editor save hook and ticket documents
opening from the checkout, which move to **E14-4c** (they live in
`electron/note-manager.ts`, a different surface) — see the roadmap.

- **One bridge, no second write path** (`store/legacy-bridge.ts`, pure): the board
  already folds a record into the legacy ticket shape (`recordToBoardFile`) and every
  mutation is a text patch of that shape. `legacyToDricketDocument(current, patched,
  { stage, archived })` is the inverse fold: header edits become dricket fields
  (`priority`, `repos`, `depends`, `parent`, `x-` keys incl. `x-chain`/`x-entered-*`),
  the body is carried byte for byte, identity / claim / lease / `rev` fields and
  unmanaged `x-` fields stay as dk has them. Decides nothing; `dk put` validates.
- **Board service** (`board-service.ts`): one door — `readCardText` / `writeCardText` /
  `commitCard` — behind refine, `ticketSave` (stale `baseRevision` still refuses; a
  ticket that moved on between read and put, dk exit 12, is a `conflict` reply and
  nothing is written), priority / track / form / plan / chain / blocked-by, parts edit
  and the part flow save. Moves (transition, accept, send back, archive, unarchive) run
  the unchanged transition machine over a store IO adapter (`dricketTransitionIo`): the
  `put` carries the target stage; **archive = stage of the terminal phase + label
  `archived`** (archived records leave the board, like `tickets/archive/`; unarchive
  removes it). **Capture** = `dk add --unclaimed` (dk allocates the number) + one `put`
  of the capture document. **Parts release** = children first (`add` with title,
  parent, depends, then `put` of the part ticket), parent's Log line last; a failure
  names the tickets that exist, and approving again matches them by title, **fills a stub
  left empty** and mints only the rest. `DricketTicketStore.add`,
  `StoreBoardSource.record / writeLegacy / add`, `EngineBoardService.dispose` (stops the
  watcher; the engine calls it on close).
- **Refused on dricket until E14-5** (fleet-owned writes): take over / release a claim,
  start a run (`run:` stamps). The drift pass and phase-folder numbering do not run
  (the store owns the layout).
- **Specs:** `legacy-bridge.spec.ts` (round trip, edits, labels, `x-phase`),
  `board-service-dricket.spec.ts` (real dk, scratch store: capture, edits, stale save,
  exit 12, transition / send back / accept / unarchive, release + resume, refusals).
- **Known limits:** writes carry dk's own identity (the remote's `owner@device` actor
  appears only in the body's Log lines); a dk exit 12 on a move says "changed in the
  meantime" (move failed) rather than offering a merge; the `archived` label is the
  only archive marker (OD-7: nothing migrated into it). **Not checked in a running
  app** (no watcher or sync round observed live); checked through the engine services on
  a scratch store only.

### Milestone 154 — E14-4 (part 1): the file reader, the `dk put` write path, change detection

**Not yet manually verified by the owner.** Owner decision 2026-11-05 (roadmap
E14-4, ADR-0090 later change): Drey works on the files of the store's checkout,
not on an extra `dk` call per read. This part ships reads, the write door and
change detection behind `tickets.backend = dricket`; the UI moves of E14-4
(capture, refine, header edits, moves, accept/send back, `ticketSave` with
`rev`, parts release, flow save, editor save hook) are split off as **E14-4b**
(roadmap) because they rewrite `board-service.ts` and nothing else may touch it
meanwhile. `files` stays the default; nothing in the running system changed.

- **File reader** (`store/file-store-reader.ts`, read-only): walks
  `tickets/<prefix>/<shard>/<id>/ticket.md` of a checkout, parses with
  `detailFromContent`, comments from `comments/` (oldest first), applies the
  **lease-expiry rule** (claim past `lease_until` + 20 min grace reads as
  unclaimed, `epoch` kept, raw `text` untouched). Equality with the `dk` read
  path on the 91-ticket migrated store: every ticket identical. Measured:
  **4 ms** (warm) / 18 ms (earlier median) against **29.4 s** (dk 0.6.0) and
  **7.7 s** (dk 0.6.1) for `ls` + one `show` each.
- **Write path** (`DricketTicketStore.put`, `DricketFileStore.write`):
  `dk put <id> -F <tmp> --claim --if-version <rev>` (one commit, 0.6 s). Exit 12
  comes back as `{ ok: false, conflict: { current } }` — the ticket re-read — so the
  caller asks; exit 11 / 17 / 14 throw typed errors. The checkout must show the new
  `rev` before `write` returns (one `dk sync` if it does not, else an error).
  `DkProcess` already queues writes per store: the engine is the single writer.
  `MIN_DK_VERSION` is **0.6.0** (v0.6.1 recommended: R-26 and R-30 fixed).
- **Change detection** (`store/store-change-feed.ts`): own writes announce at once,
  a recursive `fs.watch` on the checkout (200 ms debounce, `.git` ignored) catches
  foreign writers, a remote store (`tickets.dk.checkout` set, differing from
  `tickets.dk.store`) adds a periodic `dk sync` (`tickets.dk.syncSeconds`, default
  30, 0 = off) plus a sync on first read. `StoreBoardSource` wires it and
  `board-service` forwards the announcement to `announceChanged` (one line).
- **Settings:** `tickets.dk.checkout` (empty = the store directory when
  `tickets.dk.store` is a local directory), `tickets.dk.syncSeconds`. No checkout =
  reads fall back to the E14-2 `dk` reader. The checkout must not live in OneDrive.
- **Specs:** `file-store-reader.spec.ts` (fixtures + the equality check, enabled by
  `DREY_E144_STORE=<store copy>`, `DREY_DK_BIN`), `store-change-feed.spec.ts`,
  `dricket-file-store-dk.spec.ts` (real dk, scratch store: put, conflict, foreign
  claim, announcement), version gate in `dk-process.spec.ts`.
- **Known limits:** a foreign write inside the 200 ms window after an own write is
  announced by the next event only (E14-8 hardens); the 5 s ref check is not built
  (only if the watcher is seen to miss).

### Milestone 153 — E14-3: the ticket migration tool

**Not yet manually verified by the owner.** Owner request 2026-11-04 (roadmap
E14-3, ADR-0090, `docs/design/dricket/migration-plan.md`). A CLI-style tool in
`packages/tickets-engine/src/migrate/`, no UI, no engine wiring: it reads a
legacy tickets vault **read-only** and writes only into a **scratch** dricket
store, through the installed `dk` (v0.6.0). Nothing in the running system
changed; `drey-tickets` and `~/.drey-engine` were only read.

- **Run it:** `node scripts/migrate-tickets.mjs --legacy <vault> --allow <ids.txt>`
  (dry run, the default), `... --apply --store <new dir> [--report <file>]`,
  `... --reverse --store <dricket store> --out <new dir>`. The allow-list is a
  text file of ticket ids (`docs/design/dricket/migrate-allow-list.txt` is the
  owner's triage list: 22 ids). Needs `npm run build:plugins`.
- **Reader** (`legacy-vault.ts`): phase folders and `archive/`, raw YAML header,
  body verbatim; unreadable files are listed, not hidden (the real vault has one:
  `archive/T-0084.md`, no front matter fence -- the "91 vs 90 files" of the plan).
- **Converter** (`convert.ts`, pure): `T-0063` -> `t-63`, phase -> stage (variant A),
  Drey-only keys -> `x-` fields (`chain` `;`-joined, other lists `, `-joined),
  `blocked-by` -> `depends` (an id outside the migrated set is removed, kept in
  `x-legacy-blocked-by`, noted in a dk comment), title over 200 characters
  shortened with the full text prepended to the description, unknown priority ->
  default + `x-legacy-priority`, `../attachments/` links rewritten. Live state
  (`run`, `claimed-by/at`) is not migrated and **blocks the apply** (a run stamp, a
  claim in build) unless `--allow-live-runs`. Deviation from the plan table:
  `interactive` is carried as `x-interactive` (a per-ticket setting, not run state);
  `x-legacy-commit` is not carried (the history is cut, the old repo keeps it).
- **Apply** (`apply.ts`): refuses a store that is, is inside or contains the legacy
  vault, and a store that is not empty; `dk init` + the scratch `dricket.toml`
  (`[stages]` = Drey's phases, Drey's priorities, quota 0) on `main`; per ticket
  `dk add --unclaimed` then one `dk put --claim --if-version` of the document `dk`
  itself produced, patched (`dricket-doc.ts`) with stage, branch, repos, `x-` fields
  and the legacy body. **dk v0.6.0 gap (R-28 in `dricket-requirements.md`):** no
  import and no way to choose the number or `created_at`/`created_by`; so gaps are
  filled with cancelled `placeholder` tickets (the 22 real tickets need 69) and the
  legacy creation data travels as `x-created-at`/`x-created-by`. Nothing of dricket
  is re-implemented; `put` and `validate` judge every document.
- **Report** (`report.ts`): the dry run prints per ticket the target (id, stage,
  priority, kind, depends, x-fields, body size), warnings and what cannot be carried;
  `--report` writes a Markdown report with the apply outcome and the shadow diff.
- **Shadow diff input** (`shadow-diff.ts`): `rowsFromLegacy`, `rowsFromRecords`,
  `collectStoreRows` (list + `show` per ticket: dk v0.6.0's `ls` still lacks
  `depends`/`x-` fields, R-05) and `shadowDiff(legacy, store)` -- set, stage, title,
  priority, depends sets, derived column order; dangling blockers are *declared*, not
  differences. E14-2's shadow mode feeds the same `BoardRow`s.
- **Reverse converter** (`reverse.ts`): a dricket document -> the legacy file text
  (typed back: `rank`, `interactive`, lists), comments appended to `## Log` as one line
  each, a `lost` list per ticket (labels, touches, lease/epoch of a claim). The
  rollback of migration-plan §5.
- **Tests** (42, `migrate/*.spec.ts`): converter table over a fixture vault of real
  and realistic legacy tickets (`fixtures/legacy-vault/`: dangling blocker, run stamp,
  build claim, odd priority, over-long title, archive, unreadable file); pure round
  trip legacy -> dricket -> legacy' on every fixture; shadow diff; the guard; and,
  against the **real dk 0.6.0** in a temp dir with a temp HOME (skipped with a printed
  reason when dk is missing), apply + `dk validate` + shadow diff + round trip through
  `dk show`. `DREY_DK_BIN` selects the binary. The E14-1 contract spec got a 60 s timeout (it flaked under load beside this one).
- **Docs:** docs/06 section 6.93, docs/05, `dricket-requirements.md` (R-28, R-10
  status).
- **Real run** (scratch store, temp HOME, short path -- a Windows path over ~120 characters breaks git on dricket's comment files, so the apply refuses it): the 22 triaged tickets applied in ~8 min, 91 tickets incl. 69 placeholders, `dk validate` ok, shadow diff identical (1 declared), reverse wrote 22 files back.
- **Real dry run** of the 22 triaged tickets against `drey-tickets` (read-only):
  22 migrate, 69 placeholders, `T-0030` blocks the apply (run stamp), `T-0017`'s dangling
  blocker is removed with a warning. Not done: the cut-over apply into the real
  `drey-board` (E14-7), the pipeline/meta repo split, `dricket.toml` through a PR.

### Milestone 152 — E14-2: the board from the store, and the shadow comparison

**Not yet manually verified by the owner.** Owner request 2026-11-04 (roadmap
E14-2, ADR-0090). Read-only; `tickets.backend` stays `files` by default, which
behaves exactly as before (the files board is built by the same call as ever).

- **`tickets.backend` has three values:** `files` (default), `dricket` (the
  Work panel, Mission Control and the phone show the store's board) and
  `shadow` (they keep showing the files board while the store's board is built
  beside it and compared). Set by hand in the tickets config (`backend`,
  `dk.store`, `dk.path`, `dk.dataDir`); no Settings page yet.
- **One assembler for both backends.** `store/store-board.ts` folds a store
  `TicketDetail` back into the legacy ticket shape and runs it through the
  unchanged `assembleBoard`, so column order, derived `blocked`/`blocks`,
  issues and card workers have one implementation. The mapping (stage → phase,
  `depends` → `blocked-by`, `x-rank` `x-worker` `x-persona` `x-track` `x-form`
  `x-proof` `x-awaiting` `x-interactive` `x-chain` `x-references`
  `x-entered-<phase>`, `owner` → `claimed-by`) is the table in
  `specs/ticket-schema.md`. Stage → phase: `x-phase`, else the stage when it
  is a pipeline phase (a store configured with `[stages]` = the phase ids), else
  dricket's built-in names by role; an unmappable stage is an unknown column
  with a warning. A store that cannot be read gives an empty board with one
  `error` issue, never a silent fallback.
- **Shadow report.** At most every 30 s and never on the request path, the
  engine builds both boards, compares them ticket by ticket and field by field
  (phase, worker, blocked, blocks, issues, every meta field; column order;
  tickets only on one side) and writes `<userRoot>/shadow/board-diff.md` and
  `.json` (engine home: `~/.drey-engine/shadow/`); a difference is also logged.
  `path`, `run` and `branch` are not compared by design.
- **Reader.** dk v0.6.0 `ls`/`show` still carry only the header subset (R-05,
  R-06), so the board reads `ls` plus one `show` per ticket, cached by what the
  `ls` row reports, so a second snapshot re-reads only changed tickets. Measured
  at about 0.2-0.4 s per `dk` call here: a cold board of 22 tickets takes
  seconds, 500 tickets would take minutes (R-05 is the fix).
- **dk gaps found (docs/design/dricket/dricket-requirements.md):** R-26 parallel
  `dk` reads of one store fail with git exit 128, so `createDricketStore` now
  reads one call at a time; R-27 `dk init`'s `dricket.toml` becomes invalid with
  a custom `[stages]` until its legacy `[transitions.agent]` table is deleted;
  measured cost added to R-05.
- **Port:** `TicketRecord` gains `parent`.
- **Not in this milestone:** the separate `storeListing` view in the Work panel
  was dropped as a to-do (under `dricket` the board itself is the store; the
  engine route stays). Tickets open from their `tickets/<phase>/<id>.md` path,
  which does not exist under `dricket`, so opening a ticket document, every
  write and the fleet stay on the files until E14-4/E14-5. Benchmark at 500
  tickets not done (see the cost above).
- **Tests:** `store-board.spec.ts` (mapping, stage resolution, order, blocked,
  equality with the files board over equal data), `board-diff.spec.ts`,
  `store-board-source.spec.ts` (reader cache, shadow report, unreadable store,
  rate limit), `store-board-dk.spec.ts` (real `dk` v0.6.0, scratch store with a
  configured `[stages]` vocabulary and Drey's priorities in a temp dir with a
  temp HOME: columns, order, depends/parent, claim, extension fields, shadow
  report; skips with a reason when `dk` is missing or older than 0.5.0).

### Milestone 151 — E14-1: the `TicketStore` port and the first dricket slice

**Not yet manually verified by the owner.** Owner request 2026-11-04 (roadmap
E14-1, ADR-0090, `docs/design/dricket/`). Read-mostly and behind
`tickets.backend` (`files`, the default, behaves exactly as before).

- **Port** `packages/tickets-engine/src/ports/ticket-store.ts`: `list`, `show`,
  `claim`, `release`, `extend`, `comments`, `capabilities`; typed
  `TicketRecord` / `TicketDetail`; `TicketStoreError` with kinds mirroring
  dk's exit codes. Ids cross the port as `T-0063`.
- **`FileTicketStore`** wraps today's code (`parseTicketFile`,
  `patchTicketFile` exactly as `setClaim` uses them): same stamps, one commit,
  one announce. Leases, stage moves through `release` and comments are
  reported `unsupported` / empty. Not yet called by the board service's
  writers (E14-4).
- **`DricketTicketStore`** over the installed `dk --json` (`store/`):
  `dk-process.ts` (`execFile`, no shell; version gate `>= 0.5.0` with a clear
  `too-old` error; envelope decode; exit-code table 1, 2, 10-19; write queue
  per store, reads timed out, writes never; abort signal), `ids.ts`
  (`T-0063` <-> `t-63`), `flat-frontmatter.ts` (dricket's non-YAML header,
  `title: a: b` reads), `store-settings.ts`. Comments cannot be read (no dk
  command, R-08): `unsupported`, no workaround.
- **Board listing:** `EngineBoardService.storeListing()` (engine route
  `storeListing`) groups `TicketRecord`s by stage, from either backend.
  Settings keys `backend`, `dk.path`, `dk.store`, `dk.dataDir` (synced to the
  engine). **Not rendered in the Work panel yet** -- the board over
  `TicketRecord[]` is E14-2.
- **Real `dk` findings** in `docs/design/dricket/v0.5-observations.md`: ten
  differences from the analysis (extra exit codes 2/10/17-19, errors also as a
  stdout envelope, an agent cannot release to `done`, `ls` answers `null` for
  an empty list, `extend -m` is mandatory, no comment list, ...); new
  requirements R-22, R-23 in `dricket-requirements.md`.
- **Tests:** unit specs for ids, flat reader, process wrapper (gate, exit
  table, queue, abort), the store over captured dk v0.5.0 output
  (`store/fixtures/dk-v0.5.0/`), the file store, settings; a **contract suite**
  (`dricket-contract.spec.ts`) against a scratch store in a temp dir with a
  temp HOME: list -> show -> claim -> show -> second claimant (11) -> extend ->
  release -> show -> list, plus 10 and 14. It skips with a printed reason when
  `dk` is missing or older than 0.5.0 (`DREY_DK_BIN` selects the binary;
  `DREY_CAPTURE_DK_FIXTURES=1` rewrites the fixtures). CLI probe:
  `scripts/dricket-slice.mjs`.
- **Docs:** docs/05 (building block), docs/06 section 6.92 (claim sequence).

### Milestone 150 — Dricket analysis (documentation only)

**Not yet manually verified by the owner.** Owner request 2026-11-04: move
Drey's whole ticket handling, the fleet included, onto **dricket** (`dk`,
v0.5.0) and find out what that takes. No product code changed.

- **Analysis** in `docs/design/dricket/`: `fit-analysis.md` (concept-by-concept
  mapping of ids, paths, front matter, body chapters, phases vs stages, claims
  and leases vs the runner, comments, status log and ledger, dependencies,
  priorities, validation, monitoring, secret scan, quotas, profiles),
  `engine-impact.md` (per module of `packages/tickets-engine`,
  `plugins/tickets`, `libs/mission-ui`, `apps/mission-control`: replaced,
  adapted, unchanged, deleted; the `TicketStore` port; how reading works; the
  contracts that change; the own-write ledger and watcher),
  `migration-plan.md` (inventory of the real repo, conversion rules, history
  cut, dry run and rollback, cut-over checklist, staged items E14-0 .. E14-9,
  the first thin slice, owner decisions OD-1 .. OD-9) and
  `dricket-requirements.md` (R-01 .. R-21 and Q-01 .. Q-08 with severity and a
  concrete proposal each).
- **ADR-0090** `0090-tickets-on-dricket.md` (status: proposed) and its row in
  the ADR index.
- **Roadmap:** new heading "Tickets on dricket (proposed by the analysis,
  owner request 2026-11-04)" with E14-0 .. E14-9 and a table of which running
  or planned items stay valid, wait, are reshaped or become obsolete. Nothing
  else was reordered.
- **Not verified:** `dk` was not built or run (the one build attempt was
  denied by the session's permission classifier and was not retried by another
  route), so every `dk` statement comes from reading its source and docs; the
  engine's fleet internals were read through ADRs and call sites. The first
  slice (E14-1) starts by capturing the real JSON in a contract suite.
- **Tests:** none (documentation only).

### Milestone 149 — Dictation in the Mission Control chat composer (E12-8)

**Not yet manually verified by the owner.** Owner decision 2026-11-04: voice is
an input to the assistant, not a capture screen (board 4d is a plain text
sheet). The phone's chat composer gets a microphone.

- **Button.** `libs/mission-ui/src/chat/chat.html`: between the field and Send,
  44 × 44 pt, `aria-label="Dictate"`, `aria-pressed` while it records, filled
  accent while on (board PhoneChat's look). Disabled while a turn is sending
  or the view is read-only. **Hidden** where the browser has no
  `SpeechRecognition` / `webkitSpeechRecognition`, and on a page that is not a
  secure context: iOS Safari refuses recognition on plain `http`, so the button
  is simply absent there (no hint line — CLAUDE.md: no UI text a screen does not
  need). **Dictation needs HTTPS** — Tailscale Serve (the manual says so).
- **Behaviour.** Interim results fill the field live (`base + final + interim`),
  the final text stays editable and is never sent for the owner. While it
  records a line above the field shows the board's indicator: dot, "Recording",
  a bar wave (CSS animation, off under reduced motion) and the timer `0:03`.
  Typing, Send, a new chat and destroying the chat **cancel** the engine silently
  (a late result cannot land in the next message); leaving the composer or
  hiding the page **stops** it gracefully (the last words still arrive). Language:
  the device's first language, else the page `lang`, else `en-US`. Errors are
  inline sentences: microphone blocked, no speech heard, no network to the speech
  service, no microphone, language unsupported, "stopped unexpectedly"; the
  owner's own stop says nothing.
- **Code.** `chat/dictation.ts` is pure and testable: the `Dictation` state
  machine (`idle → starting → recording`) over a small recognition seam,
  `mergeTranscript`, `splitResults`, `resolveDictationLang`, `clockOf`, the error
  mapping. `chat.ts` only wires it. The shape session and the plan sheet use this
  same composer (the plan pane has none of its own), so there was no second one
  to change. The desktop Assistant's microphone (E13-5) is untouched.
- **Specs:** `dictation.spec.ts` (19, a fake recognition: live merge, timer,
  graceful stop vs cancel, every error code, a throwing engine, a stale engine) and
  seven component specs in `chat.spec.ts` (hidden without engine / on http, 44 pt
  button order, live fill without a send, typing ends it, blocked microphone,
  send cancels).
- **Seen:** the production build in Chromium (390 × 844): the button is visible,
  44 × 44, not pressed; with a fake engine injected the pressed state, the
  "Recording 0:01" line and the live text ("T-0084 back to Ralf and ship it")
  render as drawn; on a tap the real Chromium engine started without an error
  within 2.5 s. **Not tested: real speech.** Headless Chromium has no microphone
  and no speech service, and iOS / WebKit is not installed here — whether the
  iPhone hears and transcribes (and which language it picks) is for the owner
  to try on the device over HTTPS. A long dictated text wraps inside a
  one-row field (the field grows by line breaks only, as before) and scrolls.

### Milestone 148 — Fenced code is opaque: Mermaid plans work end to end (E10-7)

**Not yet manually verified by the owner.** Owner requirement 2026-11-04: a
ticket with a Mermaid diagram must display *and* evaluate. Display worked
(E12-6); evaluation did not: every reader of ticket text found its
structure with a line regex over the whole text, so a diagram line starting
`## Verification`, `### Parts`, `- [ ]`, `persona:` or a Log line counted —
a mermaid block in the Plan cut the plan short, added fake parts and
criteria, or made the Log patcher append into the diagram.

- **One shared reader.** `shared/markdown/fences.ts` — `maskFences(text)`
  (same length, fenced lines blanked, `\r` kept), `fencedLineFlags` and
  `maskFenceLines`. A reader looks for structure in the masked text and
  slices the original with the offsets it found, so a write keeps every
  other chapter and every fence byte for byte. Rule (also in
  `specs/ticket-schema.md`, "Body sections"): ``` and `~~~` fences,
  indented or in a list item / quote, closing fence at least as long (nested
  lengths), a backtick info string without a backtick; **a fence that never
  closes ends at the next column-0 `## `**, so a forgotten closing fence
  cannot swallow Verification and Log.
- **Parsers checked (all that read ticket text) — wrong before, fixed
  now:** engine `plan-parts` (plan/parts bounds, part lines), `plan-section`
  (Plan write, the `## ` demotion of a shape reply — a `## ` line inside a
  fence of the reply is no longer demoted), `plan-delta` (`planSectionOf`),
  `ticket-files` (`ticketSections`, `acceptanceCommands`, the Log
  append), `ticket-refine` (`replaceSection`), `verification` (section
  bounds, stamp, criteria, findings, video chapters, upsert before Log),
  `verlauf` (read and append), `scout` (`## Report` read and upsert),
  `proof-mode` (Handover declaration), `review-feedback` (feedback block read
  and write), `contracts/changes` (`## Changes`, `## Result`, the story
  and `planApprovedOf` Log lines); Mission Control's mirrors `plan.model`
  (`planSectionOf`, chapters, parts, `replacePlanSection`), `ticket.model`
  (`splitTicketSections` — the section split of the View screen —,
  `proofOf`, `scoutReportOf`) and `api/dto` (Verlauf, Verification); Drey's
  `sectionBodyRange` and `logSectionRange` (their private fence toggles
  closed on any fence line and ignored lengths). **Right already:**
  frontmatter split (line 1 only), chain / persona readers (frontmatter, and
  the `chain:` details only inside the Parts chapter), `status-log` (own
  line grammar, not Markdown), chat sessions and persona threads (own line
  grammars with their own fenced JSON), `shared/note-sections.ts` and the
  tags plugin's section splitter (already fence-aware, used for notes, not
  for tickets).
- **Specs, written red first:** `shared/markdown/fences.spec.ts` (12);
  `core/fence-safety.spec.ts` (31, one realistic ticket with seven fences
  — backtick, tilde, indented, four-backtick — whose lines look like every
  structure; plus an unterminated fence, a fence in the criteria chapter,
  Mermaid between `### Goal` and `### Parts`, CRLF);
  `services/board-service-fences.spec.ts` (4: a real `EngineBoardService`
  on a temp vault — the shape reply writes a Mermaid plan, `planParts`
  reads only real parts, persona/move/delete edits and the release leave the
  diagram intact, a second shape reply replaces the chapter whole);
  `libs/mission-ui/src/ticket/fence-safety.spec.ts` (7).
- **Seen, not just tested:** the production Mission Control build in
  Chromium (390 × 844) against a stub desk, a ticket with a Mermaid flowchart
  and a text fence full of decoy headings in the Plan: View mode draws the
  diagram, the fenced decoy text stays inside its block, the plan card
  lists only the two real parts and the proof line reads "1/1 green".
  **The desk was a stub, not the real engine**; the engine side is the board
  service spec above. Unterminated fences get no warning in the validator
  yet (they end at the next `## `, silently).

### Milestone 147 — One cap per video, nothing deleted (E11-1c)

**Not yet manually verified by the owner.** Owner decision 2026-11-04: the
walkthrough video has a size cap per video; retention is never limited except
by the disk.

- **Engine.** `videos.limitMb` (2000, the oldest videos of `done` tickets
  deleted) is gone together with its whole code path: `VideoService.sweep`,
  `pickVideosToRemove`, `replaceVideoWithNote`, the standing notice and the
  sweeps after a verify run, at startup and after a settings change. The new
  key is `videos.maxMb` (default 25, whole MB from 1 to 200). A stored
  `videos.limitMb` is ignored and removed from `config.json` at startup
  (`FileConfigStore.delete`). Existing videos stay untouched.
- **Over-cap recording.** Right after the harness stored the recording the
  verify step checks its size (`VideoService.enforceCap`): exactly the cap is
  kept, one byte more is not. Playwright cannot trim and the code has no
  re-encoding path, so the file is deleted (the only deletion the engine ever
  does, of the recording it was about to reference) and the ticket's
  `### Video` chapter reads `Video not kept: 31 MB exceeds the 25 MB limit.`
  (size rounded up to a tenth); screenshots and criteria are unaffected.
- **Contract.** `VerificationReport.videoRemoved` became `videoNotKept` (the
  line); the `Video removed (size limit).` note and its writer/reader are
  removed (`core/verification.ts`), older tickets carrying it are read without
  a video and without an error.
- **Settings.** Mission Control, Engine page: the row is *Largest video* in MB
  (default 25, 1–200; a value outside is not sent), the standing notice is
  gone; `POST /api/settings/engine` takes `{maxMb}` and the `videos` view has
  `{inGit, maxMb, existing}`. The proof card (Mission Control and the Drey
  ticket document) shows the new line where the player would be. **The Drey
  desktop settings have no video row on this base** (nothing to change there;
  the Settings → Tickets page is rebuilt by E13-11/12).
- **Specs/docs.** `specs/ticket-schema.md` (Videos size rule, Verification
  chapter), ADR-0088 later-change note, `specs/roadmap.md` (item removed),
  the manual, concept v2 §5.2 and convergence gap G-30.
- **Tests.** `video-service.spec.ts` (cap boundary 25 MB exactly / one byte
  over, line text, no `sweep`, older videos untouched, old key dropped),
  `verify-service.spec.ts` (kept at 25 MB, dropped over, follows
  `videos.maxMb`), `engine.spec.ts` (the same through the real engine, board
  and git of a throwaway vault, plus the config migration),
  `settings.spec.ts` (bounds 1/200, default 25, `limitMb` rejected),
  `verification.spec.ts`, the Mission Control and ticket-document specs.
  **Not seen:** a recording from a real Playwright/Electron run — the harness
  was a fake that writes a file of the chosen size.
### Milestone 146 — Settings → Tickets in Drey (E13-12)

**Not yet manually verified by the owner.** The tickets settings page now
opens with the rows of board 7g — **Team**, **Default flow**, **Budget and
runners**, **Walkthrough videos** — followed by **Mission Control on other
devices** (the former "Remote access" section: switch, reach, pairing by QR
and code, paired devices with Revoke); the pipeline, repository, prompts,
fleet and workers sections moved under a "Pipeline and workers" heading.
Page sentence: "The team, the flow, the budget and the devices that reach
Mission Control."

- **Team.** The personas as colour chips (the owner as "You", E10-6) from the
  engine's `personas`; *Edit team* opens the Team tab, where setup and memory
  live (E13-8).
- **Default flow.** The standard flow as a strip (`Build · Ben → Review ·
  Ralf …`: the agent columns of the pipeline with their `persona:`). A flow
  is edited per ticket, so *Open flow editor* opens the Flow tab (milestone
  145) of the ticket picked next to it (every ticket past the first column);
  changing the standard flow itself is the pipeline table below (a column's
  worker and persona). A "default flow for new plans" is E10-5b's follow-up.
- **Budget and runners.** *Daily budget* adds up the personas' budgets and
  today's cost (`PersonaView.budget` / `dailyCost`, read-only); *Runners*
  shows the pool sizes (`fleet.pool.<id>.size`, or the default) and *Manage*
  scrolls to the Workers section. **Not built:** "Pause when the budget is
  spent" and a runners dialog still need a desk setting first (E12-3b), so
  there is no switch for them yet.
- **Walkthrough videos.** *Keep in Git* (off) and *Largest video* (MB) read
  and write the engine's own `videos.inGit` / `videos.maxMb` through the new
  invoke names `settingsRead` / `settingsPatch` — the same guard the phone's
  Settings uses: turning *Keep in Git* on asks first (a warning with *Keep in
  Git* and, when videos exist, *… and include the n existing videos*); the
  engine's limits and refusals show under the row. Nothing about the keys
  or their defaults is defined in Drey (E11-1c owns the rule).
- **Files.** `plugins/tickets/renderer/settings/` (`desk-model.ts` pure,
  `desk-settings.ts` DOM), `renderer/settings-desk.css`; `settings-page.ts`
  composes the page (it takes two hooks, `openTeam` and `openFlow`);
  `settings-remote.ts` only renames its heading and shortens its intro.
- **Seen in the built app** (e2e `flow-settings.spec.ts`, throwaway vault and engine home): the Flow tab edits (a manual step added after Review, dashed, "not saved") and saves a `chain:` into the ticket file; Settings shows the team chips, the standard flow, budget, runners, videos and the device section. While the Settings overlay is open it covers the Flow tab that *Open flow editor* opens behind it (close Settings to see it). Not seen: Paul's draft (no model in e2e), a live run on the ticket (read-only state), the QR pairing.
- **Specs:** `desk-model.spec.ts` (standard flow, budget line, runners line,
  settings answer, megabyte field), `desk-settings.spec.ts` (jsdom: team,
  flow, confirmation before *Keep in Git*, the limit field).

### Milestone 145 — The Flow tab (E13-11)

**Not yet manually verified by the owner.** The flow editor of Mission Control
(E10-5) as an editor tab in Drey: gates with `+` connectors, an inspector
(who, model, tell me, runs after, earlier / later, add after, remove or
restore), "Ask Paul to change this flow", "Reset to standard flow" and
"Save flow". Board 7c's "Change flow ›" link and board 5i's editor.

- **One grammar.** The tab edits nothing itself: every edit is a round trip
  to the engine's `flowEdit` (`core/flow-edit.ts` + `chain-delta.ts`, the
  same functions behind the phone's editor), the save is `flowSave`, Paul's
  draft is `flowDraft`. A refusal ("Review is in this flow already") shows
  under the list and the draft stays. Nothing is written before Save flow;
  a changed gate is drawn dashed until then.
- **Opened from** the ticket header strip's new "Change flow" link under the
  chain (`ticket-document/strip.ts`, `dom.ts`; one optional `openFlow` dep and
  one optional `onFlow` field); Settings → Tickets → Default flow opens it
  too (E13-12). One tab per ticket (`flow://T-0121`) or
  per plan part (`flow://T-0121/2`, for E13-10's Parts block); the tab belongs
  to the Work view; the session restores it by key and reads the flow again.
- **Engine surface.** The invoke allowlist gained `flow`, `flowEdit`,
  `flowDraft`, `flowSave` (parsed by the router's own `parseFlow*`, actor
  `owner@drey`) and, for E13-12, `settingsRead` / `settingsPatch`
  (`RemoteService.settings()` is public now); `main/index.ts` forwards them.
- **Files.** `plugins/tickets/renderer/flow/` (`flow-model.ts` pure,
  `flow-view.ts` plain DOM + controller, `register.ts` the doc kind
  `tickets-flow`), `renderer/flow.css` (top level: the plugin build copies
  only top-level stylesheets). The phone client's Angular editor and this
  one share the engine contract (`contracts/flow.ts`) but not code: Drey
  cannot import the Angular lib, so the small word helpers
  (`changesLabelOf`, `marksOf`, `moveRoomOf`, `addablePhasesOf`) exist twice,
  mirrored and spec-pinned on both sides.
- **Specs:** `flow-model.spec.ts` (labels, dirty, dashed marks, move room,
  addable phases, manual-step personas, tab key), `flow-view.spec.ts` (jsdom:
  load, insert + save, refusal, Paul's draft + undo, read-only, failed load),
  engine invoke specs for `flow*` / `settings*`.
### Milestone 144 — Shape in Drey (E13-9, SDK 1.43)

**Not yet manually verified by the owner.** Owner request (roadmap E13-9,
2026-11-04; board 7b of the design canvas). A ticket of an Ideas phase opens in
the editor as its Markdown file; the Assistant on **Mission Control** shapes it:
Paul writes the `## Plan` chapter of the open file, the owner's own edits ride
along, the question is an answer card above the composer, the split proposal
ends it. **The "Refine with agent" button is gone everywhere.**

- **The ticket is attached.** With a ticket document of an Ideas phase in focus
  (no live run on it) the Mission Control target shows *that ticket's* shape
  session (`chatSessions` entry with `ticket:`; a fresh composer when it has
  none; the first message starts it with `ticket`) and the chip *T-0130.md
  attached* sits above the composer. Another document in focus switches the
  thread with it; a note shows the newest Mission Control chat as before. No
  seam of the Assistant knows a ticket: the tickets plugin's target reads a
  `ShapeBinding` (`conversation/shape-binding.ts`) over the SDK's
  `documents` facade.
- **Before a message.** The binding saves a dirty buffer (`documents.save`) —
  Paul and the engine's plan delta read the file — and locks the tab for the
  turn (`documents.setEditLock`, ADR-0049's advisory lock). A save that cannot
  finish stops the send and shows the reason as the error card.
- **Paul edits live.** The engine writes the `## Plan` chapter (`setPlan`, one
  commit) and announces the file; the open clean tab shows it in place (the
  vault change round of milestone 140). After the turn the binding waits
  (bounded, 4 s) until the buffer *is* the file before it asks for the marks,
  otherwise the stale buffer would read as the owner's edit. **Deviation from
  the roadmap wording:** this is not the Assistant's buffer-push live edit
  (ADR-0049's `documents.setBuffer`): Paul runs in the engine, so the change is
  one reload of the tab, **not one Ctrl+Z step** (File history keeps the replaced
  text). ADR-0049 carries a later-change note. The roadmap named
  `OpenDocsBridge`; that bridge is main-side and the tickets plugin's target runs
  in the renderer where the same `documents.save` / `setEditLock` are the
  equivalent calls, so nothing is re-implemented.
- **Marks in the document.** Under the `## Plan` heading: *Paul edited this · 2
  min ago* and *You edited this · rides along with your next message*, drawn by
  the ticket-document extension (`shapeMarksNode`, a block widget; the next
  widget — the Parts block, E13-10 — sits beside it). They come from the
  engine's plan status, asked with the **buffer's text** (`chatPlanStatus
  { ticket, text }`), so unsaved edits count; `PlanStatus.modelAt` /
  `PlanShadow.at` carry the time of Paul's last turn.
- **Answer card and split.** Unchanged from E13-5 / E10-3 (they only needed the
  ticket-bound session): the question as pills above the composer, the pick sent
  as the next message; *Split* / *Keep as one*; *Keep as one* moves the file
  into the build queue and the binding asks for a fresh board.
- **SDK 1.43 (content-agnostic).** `ConversationTarget.onThreadChange(listener)`
  — the thread changed without a call from the Assistant, read `thread()`
  again — and `ConversationThread.attached` — labels drawn as chips above the
  composer. `plugins/AUTHORING.md` has the note. (1.42 was the highest; if a
  parallel session also took 1.43, renumber at merge time.)
- **Refine removed.** The ticket header, the Work panel row menu and the
  thread's decision bar lose "Refine with agent"; `interactiveModeFor` now offers
  only `plan` ("Plan with agent" on the first automatic column — kept: it is
  still referenced); `InteractiveMode` is `'plan'` in the engine, the fleet
  start parser ignores `refine`; the shipped prompt
  `refine-interactive-default` is deleted (`plan-interactive-default` stays);
  manual, ticket schema, FLEET.md, runtime view and the ADR index follow. A run
  persisted with `interactive: refine` offers no end move. **Mission Control
  (`apps/mission-control`) never had a Refine button**; the phone's "Refine…"
  menu and `POST …/refine` (a field / section rewrite) are another thing and
  stay. The Shaping dialog ("Plan with agent") is *not* superseded for the
  first automatic column; for the Ideas phase, shaping is this item.
- **The composer stays whole on a target; the Vault chip works there.**
  Owner feedback after the first cut (the target composer had shrunk to the
  field and the mic). On Mission Control / 1:1 the composer now keeps the
  **Vault chip** (off by default, the same scope and picker as on Model, so an
  architecture-docs vault can be picked) and **Prompts**; attachments, note
  chips, Live edit and the model row stay Model-only. With the chip on, the
  Assistant asks its main side (`vault:context`, the same ranked note sections
  as an ask turn, ADR-0072) and hands the block to the target as
  `send(text, { context })` (SDK 1.43); the Mission Control target passes it
  through `mcSend` / `mcStart` to the engine (`context`, bounded to 12 000
  characters), where it is appended to the model's system prompt for that turn
  only — never written to the session file. Reading only: Pia and Paul get
  the sections, no vault tools. Switching back to Model changes nothing there.
- **The Assistant's head and chat list, redone (owner design, same
  session).** One head row instead of two: the **chats button** (three
  lines) on the left, the **icon switcher** (speech bubble = Model, rocket =
  Mission Control, two heads = 1:1; tooltips carry the names, a target names
  its icon — SDK 1.43 `ConversationTarget.icon`), the active chat's title and
  **+** for a new chat on the right. The chats button swaps the thread for
  the **chat list inside the panel** (the Model's chats, or the target's
  history; title, time, "n open"; the current one marked) — the two modal
  pickers are gone (`chat-list.ts`; `picker-chat.ts` deleted; the attach,
  prompt, vault and model pickers stay). The composer on a target looks like
  Model's: the attached ticket is a **chip inside the box**, and **Attach**
  works — attached files go to the target as reference text (6 000 characters
  each) beside the Vault chip's sections. The e2e specs that read the old
  switcher words / chat modal follow (`assistant.spec`, `assistant-targets.spec`;
  `assistant-tools.spec` was already failing on a strict-mode locator since
  E13-5 and got `.first()`).
- **Specs added.** `ticket-document/shape.spec.ts` (target of a document, ago
  words, the two marks, heading offset), `shape-state.spec.ts` (the status
  store), `conversation/shape-target.spec.ts` (thread per ticket, save → lock →
  send → unlock → settle, error without sending, switching documents, split
  decision), `main/chat-ipc.spec.ts` (`mcStart` with ticket, `mcPlanStatus`),
  `assistant/renderer/targets.spec.ts` (`onThreadChange`, `attached`), engine
  plan status `modelAt` / shadow `at`; the dialog specs lose the refine cases
  (`end-moves`, `dialog-starters`, `default-prompts`).
- **Real run:** `e2e/shape-in-drey.spec.ts` on the built app (own profile, own
  engine home, a mock OpenAI-compatible endpoint on port 41872): the ticket
  opens from the Files panel with no dialog button in its header, Mission
  Control shows the chip, Paul's plan appears in the open document with *Paul
  edited this*, the answer card (3 pills, one recommended) sits above the
  composer, the owner types into the plan and *You edited this* appears, the
  pick "3 parts" goes out with the edit (the mock saw "The owner edited the
  plan" and the typed words; the file on disk had them), the split card shows
  *Split* / *Keep as one*, *Keep as one* moves the file to `20-build/`.
  Screenshots `shape-paul-edited.png`, `shape-owner-edited.png`,
  `shape-split-proposal.png`, `shape-kept.png` in the test output.
  **Not seen:** a real model (the mock returns one fixed envelope); the open tab
  *after* "Keep as one" still shows the old path and the file's old strip (the
  tab is not re-keyed to the moved file; reopen from the Work list); a
  Windows-CRLF ticket file; the Work view's Capacity band is still shown while
  a ticket is open (E13-13 rest).

### Milestone 143 — The Mission Control frame stays put (D-5)

**Not yet manually verified by the owner.** Owner report 2026-11-04: on iPhone
and iPad, installed to the home screen, a scroll gesture moved the whole
content instead of leaving the frame fixed like a native app.

- **Cause.** The document itself was scrollable: `html, body` had only
  `height: 100%`, no `overflow` and no `overscroll-behavior`, so iOS
  rubber-banded the page; and eleven inner scrollers (chat body and sheet,
  flow editor body and inspector, plan approve and pane bodies, settings
  categories and page body, team and ticket sheets, the Work dock body) had no
  `overscroll-behavior`, so a drag at the end of a list chained into the page.
- **Fix** (CSS only, no visual change). `apps/mission-control/src/styles.css`:
  `html, body` get `overflow: hidden` and `overscroll-behavior: none`;
  `body` is `position: fixed; inset: 0` (iOS ignores `overflow: hidden` on
  the body for touch drags otherwise). Every vertical scroll container in
  `apps/mission-control` and `libs/mission-ui` now carries
  `overscroll-behavior-y: contain`; the ticket patch `<pre>` (horizontal
  scroll) carries `-x: contain`. Pinch zoom and safe-area padding are
  untouched. The `::host` typo from the report does not exist in the tree
  (`app.css` already has `:host`).
- **Not done:** no keyboard handling beyond the existing `dvh` layout — iOS
  does not shrink the layout viewport when the keyboard opens; if the composer
  sits behind the keyboard on the device, that is a follow-up.
- **Spec:** `shared/mission-control-scroll-contract.spec.ts` reads every
  stylesheet of both trees and asserts the html/body contract and that no
  scroll container lacks `overscroll-behavior`. **Verified in Chromium only**
  (iPhone 14 profile, touch gestures, production build): the document's
  `scrollTop` stays 0 and header/composer boxes do not move. **WebKit is not
  installed here and iOS was not tested** — the owner must check on the device.
### Milestone 142 — D-4: runs.spec no longer flakes under full-suite load

**Not yet manually verified by the owner.** `fleet/runs.spec.ts` failed
intermittently inside `npm run test:plugins` (reproduced alone under CPU load:
3 of 12 runs). Two causes, one in the spec and one real ordering bug in
`RunSupervisor`:

- **Spec:** `state` turns `done`/`failed`/`stopped` in memory *before* the
  settle has cleared the ticket's run stamp, committed and written the persona
  memory. 39 sites waited on `state` alone and then read the ticket (stamp
  still there) or ended the test so `afterEach` removed the temp dirs under a
  running settle (`ENOENT` / `ENOTEMPTY`). They now wait for `onRunSettled`,
  which fires as the settle's last step (`settled()` helper). The run.json
  read in "folds the run telemetry" retries (the write truncates first).
- **Production (`runs.ts`):** (1) the reaper stops the worker and then
  finishes the run, but `stop()` resolves `exited`, so the exit handler also
  reached `finish` — two settles: two commits, `onRunSettled` twice (the chain
  orchestrator was told twice), and (2) unserialised read-modify-writes of the
  ticket (settle clearing the stamp vs. the exit handler's log line) could let
  a stale write bring the cleared run stamp back. Now `finish` settles once
  (a second caller awaits the first), a run's ticket writes are queued, and the
  watchdog's fire-and-forget "looks stuck" write is awaited by the settle and
  by `reap`.
- **Specs:** two regression specs (state is terminal before `onRunSettled`
  while the settle's commit is held; a reaped run settles exactly once and
  leaves no run stamp). Full `test:plugins` green three times in a row
  (291 files / 3613 tests).

### Milestone 141 — The Work view, first cut (E13-13, SDK 1.41)

**Not yet manually verified by the owner.** The tickets plugin registers the
view preset **Work**; the title bar's switcher now shows **Notes | Work**
(`Ctrl+1` / `Ctrl+2`). First cut of the roadmap item, as its text allows once
E13-2 and E13-6 are built; the rest stays on the roadmap as E13-13.

- **The preset** (`plugins/tickets/renderer/view-preset.ts`, over the E13-2
  SDK): `tickets.work`, label "Work"; **Tickets** panel left, **Assistant**
  right, **Capacity** band at the bottom; the centre is the pane tree of the
  view (ticket documents, the Board, the Team). Applied once when the view is
  first shown; afterwards the owner's arrangement is kept. No
  `assistantTarget` (E13-5 does not exist on this base).
- **Home views.** The Board, Team and ticket-thread kinds name Work as their
  `homeView`. A ticket **file** is plain Markdown, which a file opener (name
  suffix only) cannot single out, so **SDK 1.41 adds
  `documents.registerHomeViewRule({ homeView, matches(path, vaultId) })`**
  (`FileOpenerRegistry.homeViewOf`, asked by `DocOpenService.openFile`; an
  opener's own `homeView` wins; `stayInView` opts out; a throwing rule is
  logged and skipped). The tickets plugin's rule matches ticket paths of the
  board vault, so a ticket opened from the Files tree, a `[[T-0121]]` link or
  the quick switcher jumps to Work.
- **Naming (G-10), decided from the boards and ADR text:** the view and its
  switcher button are **Work**, the dock panel is **Tickets** (boards 7a–7j and
  the sorting rule say "Tickets panel"). Panel title, the "Show the Tickets
  panel" command, the status item tooltip, the empty-thread text and the e2e
  selectors (`aria-label="Show Tickets"`) follow; the panel id stays `tickets`.
  The header's "Open Board tab" icon and the footer's Team link stay with E13-14.
- **Specs / tests.** `view-preset.spec.ts` (layout, no target, the rule per
  vault and path, both registrations), `file-opener-registry.service.spec.ts`
  (opener beats rule, throwing rule, unsubscribe), the new e2e
  `e2e/work-view.spec.ts` (switcher text, `Ctrl+2`, the Work arrangement,
  `Ctrl+1`, a ticket opened from the Files tree lands in Work) with an isolated
  profile and engine home. Typechecks, lint, cycles and the four app suites,
  `test:plugins` green.
- **Seen in the built app** (e2e run, screenshots in the session notes): the
  switcher, Work with the three panels, the ticket header in the centre after
  the jump. **Not seen:** the Board/Team tabs jumping to Work by hand, a live
  fleet in Work, session restore of the Work layout.
- Docs: ADR-0089 later change, docs/05, docs/06 §6.83, the manual (Views),
  `plugins/AUTHORING.md`.

### Milestone 140 — Engine writes refresh Drey's vault views (D-3, G-08)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(convergence audit G-08). The standalone tickets engine writes ticket
files, but Drey's vault layer was never told: with the vault watcher off
(the default) the Files tree, the search / tag index, backlinks and an
open ticket tab stayed stale until a manual refresh.

- **Root cause.** `FsEngineHost.announceChanges` (the engine's standalone
  host, ADR-0088 E2b) threw the paths away (`void changedPaths`) and emitted
  a bare `board` event; the Drey plugin turned that into the renderer's
  `board-changed` only. The pre-E2b `DreyEngineHost` had called
  `ctx.vault.announceChanges` — the extraction dropped that link.
- **Paths on the stream.** The engine's hub got a second, plugin-only
  channel (`ChangeHub.emitPaths` / `subscribePaths`, `Engine.onPaths`): the
  `/api/events` stream carries `{change:'paths', vaultPath, changed,
  deleted}`. It is not a `RemoteChange` — the gateway and the phone never
  see it. A transition reports the new file as changed and the old one as
  deleted (a rename is a delete + add pair, as for the watcher).
- **Batched announce.** `plugins/tickets/main/path-announcer.ts` coalesces
  reports (400 ms debounce, 2 s max wait, last write wins per path, a batch
  over 400 paths degrades to a full refresh of the vault) and calls
  `ctx.vault.announceChanges` once per burst, so a fleet run is a trickle of
  rounds, not a storm. The Drey vault is matched by path (the engine's
  vault root), so an unregistered tickets vault is silently skipped. The
  plugin knows no ticket semantics; the SDK and base are unchanged.
- **Open tabs.** The existing external-change round decides: a clean tab
  reloads, a dirty tab keeps its buffer and is marked "Changed on disk", a
  tab whose file moved away flips to draft semantics (`existsOnDisk:
  false`) and stays open. No echo: the round never writes back to the engine.
- **Specs.** `path-announcer.spec.ts` (move = changed + deleted, path
  matching, unregistered vault, burst coalescing, max wait, last write wins,
  oversize → full refresh, dispose, failing listing, `dispatchFrame`),
  `engine.spec.ts` (a real transition reports both paths on `onPaths` and
  the SSE stream), and `e2e/engine-refresh.spec.ts` (a real Drey with the
  watcher off, its own engine, driven over the loopback channel like Mission
  Control: a clean open ticket tab reloads after an engine edit, the Files
  tree shows an engine move into another phase folder, a dirty tab keeps its
  unsaved text and is marked "Changed on disk"). Without the fix the first
  and the last assertion fail (reproduced by disabling `emitPaths` in the
  built engine).
- **Not done.** A ticket tab does not follow an external move to the new
  folder (it flips to draft semantics); watcher stays off by default.
### Milestone 139 — The Review tab (E13-7)

**Not yet manually verified by the owner.** Owner request, 2026-11-04 (board
7d of the design canvas): the review of Mission Control's proof card (E11-2,
E11-3) on the desktop, as an editor tab of the tickets plugin.

- **The tab.** Doc kind `tickets-review`, one tab per ticket, key
  `review://T-0121`, title **Review · T-0121** (`renderer/review/`). The
  ticket document's **Open Review** button opens it (it opened the thread
  tab until now). Above: the ticket's **proof** — the same block as in the
  ticket document (`proofNode`: verdict, checks, screenshots, walkthrough
  video with chapters, findings). Below: **"3 files · 1 of 3 viewed"**,
  one chip per changed file (status, path, +/−, comment count), the
  selected file's rows with old/new line numbers, and a footer with the
  checks ("Checks green · 4/4"), **Send back with N comments** and
  **Accept and move to Commit** (only while the ticket waits at one of
  your checkpoints; otherwise "Not waiting for your decision").
- **File pane.** *Changes* (the patch's rows) or *Whole file* (the file on
  the ticket branch with the patch laid over it), *Viewed* per file (the
  mark is keyed by path + patch hash, so a file that changed after you
  looked reads unviewed again), **Open in editor** (the file as a vault
  file at the line when its worktree is, or sits inside, a registered
  vault; otherwise a scratch copy of the branch's file) and **Git history**
  (opens that vault file and runs the git plugin's `git.fileHistory`;
  says so when the file is in no Git vault).
- **Comments.** Click a line number for a comment on that line of the new
  file, Shift-click a second number for a range; Ctrl+Enter adds, Esc
  cancels, every comment can be edited or removed. Comments and viewed
  marks are kept per ticket in `localStorage` (`drey.tickets.review.<id>`)
  and dropped when their file leaves the diff.
- **Feedback.** *Send back with N comments* calls the existing `sendBack`
  board IPC with `comments: ReviewComment[]` — **the engine's own contract**
  (`core/review-feedback.ts`, E11-3): the plugin's `sendBack` handler now
  parses them with `parseReviewComments` and hands them to
  `BoardService.sendBack`, which writes the `### Review feedback` block into
  the ticket's `## Handover`. With comments the note is optional
  (`sendBackNoteOf`, new in `review-feedback.ts`, shared with the HTTP
  router, which had the same fallback inline); without comments the button
  opens the ordinary send-back dialog. Accept is the Ready card's
  `acceptTicket`. Two new plugin IPC handlers carry the data:
  `reviewDiff` (`BoardService.ticketDiff`) and `reviewFile`
  (`ticketFile`), the calls Mission Control reaches over HTTP — through two
  new methods on the engine's invoke channel (`ticketDiff`, `ticketFile`;
  `server/engine.ts`, spec in `engine.spec.ts`). **A running engine must be
  restarted** to have them; an older one answers "no such method".
- **DiffView.** The design doc names Drey's `DiffView` for this tab. It is
  an Angular component over two texts (before / after) with no line
  gutter, so it can carry neither per-line comments nor viewed marks, and
  plugins have no way to mount an Angular component (`ui.showDiff` is a
  modal). The tab therefore renders the engine's unified patch itself, as
  the phone client does (`patch.ts` is the plugin-side port of
  `patchRowsOf` / `wholeFileRowsOf`; the lib is Angular-bound and the
  plugin may not import it). No SDK change.
- **Not in this milestone:** desk-wide viewed marks across devices
  (E11-2b — the marks are per machine here), a file list longer than the
  engine's cap of 20 files / 200 KB (the tab says "the list is cut for
  size"), and the Before / After pictures as a dedicated pair (the
  proof's screenshots show as the gallery).
- **Specs.** `review/patch.spec.ts`, `model.spec.ts` (incl. the
  worktree-to-vault resolution), `view.spec.ts` (jsdom: files and rows,
  viewed, line and range comment → `sendBack` payload, accept, no
  buttons off a checkpoint, Whole file, open in editor with and without a
  vault), `review-feedback.spec.ts` (`sendBackNoteOf`), and
  `e2e/review-tab.spec.ts` (a real git repo with a branch and worktree:
  Open Review → proof and diff → two comments → Send back → the
  ticket file carries the `### Review feedback` lines).

### Milestone 138 — Assistant conversation targets (E13-5)

**Not yet manually verified by the owner.** Owner request (outside the list,
2026-11-04, E13-5). The Drey Assistant talks to a **target** the owner picks in
a segmented control in the panel head: **Model** (today's plain chat over the
registered provider, `LlmRouter`, nothing new), **Mission Control** (the
engine's chat, Pia) and **1:1** with one persona (a menu of the team's agent
personas). The control appears only while a plugin registered a target; an
install without the tickets plugin looks exactly as before.

- **A generic SDK seam (SDK 1.41, content-agnostic).**
  `api.conversations.registerTargets(provider)` / `targets()` /
  `onTargetsChange` / `viewTarget()` / `onViewTargetChange`. A
  `ConversationTarget` is `id`, `label`, optional `group` (targets with the
  same group fold into one segment with a menu) and `thread()`, `send`, `act`
  (a card button), `newThread`, optional `history` / `open`. A thread is
  messages with an optional `author` + `via` chip, folded `thought`, `cards`
  (a proposal with buttons, or a `choices` answer card) and an `error` card.
  The base (`src/app/plugin-host/conversation-targets.service.ts`) only
  collects providers and fans out change notices; the assistant plugin knows no
  tickets, the tickets plugin registers Mission Control and the personas.
- **Per-view default.** `viewTarget()` is the active view's preset
  `assistantTarget` (milestone 127, the seam already carried it, ADR-0089): the
  Assistant selects that target when the view becomes active, waits when the
  target registers later, and falls back to Model in a view without one. The
  owner's own pick stays until the next view change. The Work view preset
  that names `tickets.mission-control` is E13-13.
- **Mission Control over the plugin's engine channel, not the gateway.** The
  roadmap said "through `RemoteService.localClient`"; that call registers a
  device for the gateway URL and needs remote access on. The tickets plugin
  already holds the engine's loopback invoke channel, which exposes the same
  `ChatService` (`chatSessions`/`chatOpen`/`chatStart`/`chatSend`/
  `chatConfirm`/`chatDismiss`/`chatShapeDecide`), so `plugins/tickets/main/chat-ipc.ts`
  (`mc*` handlers, the router's id grammar re-checked) forwards there: no
  pairing, no dependence on the remote switch.
- **Cards.** A proposal renders under the mission message it followed with
  **Confirm / Dismiss** (a decided one as "Done — …" / "Dismissed", no
  buttons); Paul's split proposal as **Split / Keep as one**; an open question
  as an **answer card above the composer** whose pick is sent as the next
  message. Shape-session relays are Paul's words with the **via Mission
  Control** chip. A failed turn is the D-1 error card (provider, reason,
  endpoint, model) and is not written into the session; a CLI provider shows
  the engine's refusal.
- **1:1.** The persona's thread (E12-4: the owner's messages; `personaThread`
  / `personaThreadAppend`) with one line "<Name> reads this thread before the
  next run." The owner as a team member (`kind: human`) has no 1:1.
- **Dictate.** A microphone button in the composer (icon size 14, the
  composer's own) on every target, using the Web Speech API
  (`webkitSpeechRecognition`) and hidden where the page has none; the words
  land in the composer, the owner sends them; errors ("needs microphone
  access", "could not reach its speech service") show under the field.
- **Specs.** `targets-model.spec.ts`, `targets.spec.ts`, `dictate.spec.ts`
  (assistant), `conversation/map.spec.ts`, `conversation/targets.spec.ts`,
  `main/chat-ipc.spec.ts` (tickets), `conversation-targets.service.spec.ts`
  (base). **Real run:** `e2e/assistant-targets.spec.ts` on the built app
  (own profile, own engine home, a mock OpenAI-compatible endpoint on port
  41871): Model answers, Mission Control answers with a proposal card that is
  dismissed, a 1:1 with Paul appends, a `claude-code` provider shows the
  refusal; screenshots `target-model.png`, `target-mission-control.png`,
  `target-one-to-one.png`, `target-cli-refused.png` in the test output.
  **Not seen:** a real model, speech actually heard (the mock cannot), the
  Work view switching targets (no preset names one yet).
### Milestone 137 — Text size steps S / M / L / XL

**Not yet manually verified by the owner.** Owner decision, 2026-11-04: the
Mission Control text size has **four** steps, not the five of milestone 136.

- **Scale.** Settings → Appearance: **S = 15, M = 16, L = 17 (default, the
  iOS body size), XL = 19 px** body. The factor stays px / 15
  (`--mc-text`); the labels stay fixed 15 px; the preview line reads
  "L · 17 px body text, the default". XXL and XXXL are gone.
- **Migration, idempotent, versioned by `mc.textSizeScale`.** Each earlier
  scale maps to the nearest step by body px, once, then the value is
  re-saved with marker `3`: unmarked (the first build: S 13.5, M 15,
  L 17.25, XL 19.5, XXL 22.5 px) → S, **S**, L, XL, **XL**; marker `2`
  (milestone 136: S 15, L 17, XL 19, XXL 21, XXXL 24) → S, L, XL, **XL**,
  **XL**. A stored first-build M (15 px) therefore lands on S, not on the
  default L as milestone 136 had it.
- **Specs.** `theme.spec.ts` (scale, both migrations, idempotence, boot),
  `settings.spec.ts` (the XL step and its preview line).

### Milestone 136 — Design decisions into code (E12-7)

**Not yet manually verified by the owner.** Owner request, 2026-11-04: after
the audit of docs, design canvas and code, the **Anthrazit design-system
values win over ad-hoc ones** (canvas version 71, sticky "Decisions
2026-11-04"). Visual and settings only; takes G-13, G-23 and G-26 of the
convergence audit.

- **Attention pastels (G-23).** `--accent-peach #f2cfae`, `--accent-pink
  #f2d3e2`, `--accent-mint #bfe3cd` plus `--on-pastel #101113` (the DS
  `ink-on-accent`) in `src/styles.css` and Mission Control's `styles.css`.
  They are one value in every theme (the DS defines them identical in
  light and dark), so Anthrazit, Drey and Cyberpunk all carry them; the
  theme palettes themselves are untouched. Re-pointed from amber
  `--status-modified` / `--accent-quote`: the desktop Work panel's
  **Needs-you** group badge and **kind chip** (peach), the **Shaping**
  badge and the shaping track border (pink); in Mission Control the Work
  tab's needs badge, the needs-you group head, the question cards' left
  border and kind label (peach). Amber stays where it means a *state*
  (cost, flags, source-control "modified"). **Persona colours are owner
  data** (the `color:` of each `persona.md`), not code — nothing to
  re-point; the code's defaults (`#a78bfa` migrated agents, `#38bdf8`
  human) are unchanged.
- **Radius scale (G-26).** `--radius-chip` 4 / `--radius-control` 8 /
  `--radius-dialog` 16, named by role because the legacy `--radius-sm`
  (5) / `--radius-lg` (9) names are in use all over Drey with other
  values. Migrated: every stylesheet of the tickets plugin and all of
  `libs/mission-ui` and the Mission Control app (their `--r` 12/14 is
  gone; 22 px round buttons became the `99px` pill, circles stay `50%`).
  **Not migrated:** the rest of Drey's panels (`src/**`, other plugins)
  keep the legacy steps 4–9 — they move to the scale when touched.
- **Type floor.** Mission Control: no `font-size` below 13 px in any
  stylesheet (about 120 declarations of 9–12 px raised). Desktop tickets
  surfaces: floor 12 px (11 px / 0.65–0.74 rem raised); 12 px stays for
  dense list metadata.
- **Text size scale.** Settings → Appearance: **S / L / XL / XXL / XXXL =
  15 / 17 / 19 / 21 / 24 px** body, **L the default** (second smallest).
  Every stylesheet's base is written for the 15 px body, so a step's
  factor is px / 15 (`--mc-text`; default 1.1333 in the token sheet).
  The step labels are fixed 15 px; the live preview line reads "L · 17 px
  body text, the default". A stored first-build value is migrated once
  (marker key `mc.textSizeScale`): S→S, **M→L**, L→XL, XL→XXL, XXL→XXXL.
- **Capture label (G-13).** The tickets capture command is `Mod+Alt+T`
  (shown as Ctrl+Alt+T; the manual already says so); no UI string in the
  tickets plugin, Mission Control or the title bar named Ctrl+Alt+N, so
  there was nothing to correct there. `Ctrl+Alt+N` stays the *daily-note*
  quick capture. The platform formatter shows `Ctrl` — no `⌘⌥T` form
  exists in the code (the app is Windows-first); not added.
- **Fix on the way:** Mission Control constructed its `Theme` only when Settings opened, so a stored theme / text size applied only after a visit there; the app root now injects it at boot (needed for the migration to take effect on load).
- **Specs.** `shared/design-scale.spec.ts` (new): no radius outside the
  tokens in the tickets plugin and Mission Control, no font-size below the
  floor, tokens present in both sheets. `libs/mission-ui/src/theme.spec.ts`
  / `settings/settings.spec.ts`: the new scale, the migration, the preview
  line.
- **Out of scope here:** dictate button, mermaid, parts block, E13-x,
  devices (D-2), the docs sweep.
### Milestone 135 — Paired devices list and pairing from Mission Control (D-2)

**Not yet manually verified by the owner.** Owner request, 2026-11-04,
outside the list. The paired-devices view read like a log of when devices
reported (one phone paired twice, Mission Control showed only a date). The
owner: "I only want to know how many there are in total and, for each one,
when it last connected" — and "Mission Control should also be able to do the
pairing."

- **One list, two screens.** The pure model is
  `packages/tickets-engine/src/contracts/device-list.ts` (`deviceListOf`):
  the heading states the total ("4 paired devices", "1 paired device",
  "No paired devices"); one row per device, most recently connected first,
  "Last connected <local date and time> · 3 h ago" or "Paired <date>, not
  connected yet"; **This device** (Mission Control knows it), **Read-only**,
  **Inactive** (not connected for 14+ days — a marker, nothing is removed);
  a name that appears twice gets a short id suffix ("Phone · f6a7") so the
  stale leftover can be spotted and revoked. Drey's Settings → Tickets →
  Remote access (`settings-remote.ts`, plain DOM, via the
  `plugins/tickets/shared/device-list.ts` shim) and Mission Control's
  Settings → Devices (`libs/mission-ui/src/settings/`, which keeps a local
  copy of the file like `team.ts` — the lib imports nothing from the repo)
  draw it. A spec in the lib runs both copies on one case table
  (`device-list.cases.ts`), so they cannot drift apart.
- **`lastSeen` means "last connected".** `DeviceRegistry.touch` already ran
  on every authenticated request, persisted at most once a minute per
  device (checked, unchanged). The gap: an open event stream (phone left on
  the board) only counted at connect time; the stream's 25 s keep-alive now
  touches the device too.
- **Pairing from Mission Control.** Settings → Devices, for a paired device
  that is **not read-only**, "Pair another device": name, Read-only switch,
  "Show pairing code", then code (`XXXXX-XXXXX`), QR (SVG from the engine's
  matrix), the pairing link, an expiry countdown and Cancel; once the second
  device used the code the card vanishes and the list reloads (3 s poll while
  a pairing waits). Engine routes (`server/router.ts`, `PairingAccess` over
  the same `PairingCodes` slot as the desktop): `GET /api/pairing`,
  `POST /api/pairing/start {name, readOnly}`, `POST /api/pairing/cancel`,
  all behind the bearer token; **a read-only device gets 403 on all three**
  (reading the waiting code is refused too — it is a credential) and never
  sees the button. The engine log names who started it ("remote Owner iPad
  (aaaa…): pairing started for "Pia phone""). One-time code, five-minute
  expiry, the failure limiter and `POST /api/pair` are unchanged; there is
  no new way to pair without an existing code. A missing public URL gives
  the desktop's hint ("Set the device address first — a phone cannot open
  127.0.0.1"). Trust model: ADR-0088 later change.
- **Specs.** `contracts/device-list.spec.ts` (heading singular/plural/none,
  relative hints, inactive at exactly 14 days, duplicate suffix, ordering),
  `server/pairing-access.spec.ts` (start → a second client pairs → listed,
  read-only 403 on start/cancel/read, bad payload, cancel, expiry, 404 on a
  host without it), `libs/mission-ui/src/settings/settings-devices.spec.ts`
  (parity, rows and markers, form and start, no button for read-only,
  code/QR/countdown/cancel, the address hint, the 3 s poll),
  `apps/mission-control state.spec.ts` (start/cancel/refresh reload, refusal
  toast), `plugins/tickets/renderer/settings-remote.spec.ts` (the desktop
  list). Seen working against a real engine in a throwaway home and vault:
  code and QR appear in Mission Control, a second client pairs with the
  code, the new device is listed ("5 paired devices"), a read-only device
  gets 403 and no button.
### Convergence audit (documentation only) — milestone 134

**Documentation only; no product code changed, nothing to verify in the app.**
Owner-requested audit, 2026-11-04: the concept, the design canvas and the code
had drifted after milestones 97–132 were built in parallel.

- **Concept v2 in the repo, in English:**
  [`docs/design/work-panel/architecture-concept-v2.md`](../docs/design/work-panel/architecture-concept-v2.md),
  a faithful translation of the owner's German v2, with a status line per
  section (built / planned / dropped, milestone numbers) and updates for D5–D11,
  the video size rule, E10-6, E12-6, the desktop integration and ADR-0089, the
  Refine-button removal (E13-9) and D-1.
- **Doc-to-code audit:** `docs/05`, `docs/06`, ADR-0088, ADR-0089 and
  `specs/ticket-schema.md` brought to the code (stale paths after the engine
  extraction, relabelled sequence diagrams, new building blocks for the engine
  process and Mission Control, the fleet-ledger section of the schema, the
  `chain` grammar, German words removed). Milestones 109–111 had no changelog
  entry: backfilled below from the commits.
- **Design-to-code audit:** all 34 canvas boards compared with the code; the
  roadmap's E13 items carry what the owner's boards show; the Anthrazit tokens
  were checked against the CSS variables.
- **Gap list:** [`convergence-gaps.md`](../docs/design/work-panel/convergence-gaps.md)
  (35 rows, sorted by severity, with roadmap ids); the new roadmap items are
  marked "proposed by the convergence audit". Roadmap Status line and "next free"
  counter corrected; ADR-0089 shown as accepted.
- **Owner answers applied (2026-11-04, canvas v71):** capture chord Ctrl+Alt+T, "Add part" stays excluded, the Mermaid gate diagram and Zod dropped (new roadmap items E10-7 Mermaid-safe parsers and E12-8 dictation), the Anthrazit design system wins (code: milestone 136, E12-7), no separate plan-step list.
- **Not verified:** nothing was run and no board rendered (strings, structure and
  colours were compared); legacy parts of docs/05 and docs/06 were not audited.

### Milestone 133 — Markdown surface for Mission Control (E12-6)

**Not yet manually verified by the owner.** Owner priority, 2026-11-04 (the
phone rendered ticket Markdown wrongly: its own reader knew headings,
paragraphs, bullets and code — tables, callouts, math, diagrams and inline
formatting came out as raw characters). "Use our Drey md editor instead":
the **same CodeMirror engine as the desktop editor** now renders and edits
Markdown in Mission Control, in three modes.

- **Extraction, not a copy** (ADR-0088 later change). The Angular-free half
  of `src/app/editor/` moved to **`libs/markdown-surface/`** (alias
  `@markdown-surface/*`): theme, the extended dialect (`markdown-extensions`),
  Live Preview (`live-preview/`), link and wikilink handling, vault-image
  helpers, the toolbar actions, the eraser. New `engine.ts` is the one place
  both clients take the dialect (`markdownDialect`), the three modes
  (`surfaceModeExtensions`: Source adds nothing, View is read-only with
  links on a plain click, Live reveals around the selection) and the
  read-only lock from; the desktop `MarkdownSurface` now builds from it
  (the inline `markdown({...})` block and the mode switch are gone from it).
  `create-view.ts` is the plain-DOM entry (`createMarkdownView`:
  mode, editable, `setDoc` that keeps selection and scroll, `applyAction`).
  Desktop behaviour is unchanged: specs moved with the code, the desktop
  suite is green. Lint rule: the lib imports its own folder and `shared/`
  only, no Angular.
- **`mc-markdown`** (`libs/mission-ui/src/markdown/`): the Angular wrapper.
  **View is the default wherever a result is presented** — the ticket text,
  the report summary, the plan's chapters, the proof face's new
  **Verification text** (unfolds on tap) — **Live Preview where the owner
  writes** (the plan editor in Shape, with a compact formatting strip: bold,
  italic, heading, bullets, tasks, code block, quote, link; 44 pt targets).
  A segmented **Live | View | Source** control (44 pt) on every surface; the
  pick is remembered per surface on the device (`mc.md-mode.<surface>`,
  `mode.ts`; a blocked storage falls back to the default). The CodeMirror
  chunk loads on first mount; until then the text shows as plain wrapped
  lines. The desktop's tokens are mapped onto Mission Control's in
  `markdown.css` (all three themes follow). KaTeX's stylesheet and fonts
  are now assets of the Mission Control build (without them the math showed
  twice).
- The old reader `ticket/markdown.ts` is deleted; the plan pane's draft
  field is the surface (`onDraft(text)`), the ticket view binds
  `bodyText()` instead of blocks.
- **Bundle** (production build, `ng build mission-control`): initial
  534.8 kB raw / 118.0 kB transfer, unchanged in kind — the engine is the
  lazy chunk `create-view` (325 kB raw / 100 kB transfer), plus the lazy
  `katex` chunk (261 kB / 64 kB) and mermaid's own lazy chunks, which load
  only when a note carries math or a diagram.
- **Specs.** Moved with the code (`ng test markdown-surface`, 17 files /
  260 tests); `mode.spec.ts` (the memory) and `markdown.spec.ts` (the
  component: plain text first, engine mounts, View default and read-only,
  Live default with strip, Source shows raw Markdown, remembered per surface,
  follows the bound text) in mission-ui; the plan and ticket specs follow the
  new bindings.
- **Seen in a real run** (built Mission Control, 375×812, a real engine on a
  temporary tickets vault and home — not the owner's board): the ticket text
  in View with headings, bold, highlight, strike, inline code, link, emoji,
  a callout, task list, table, inline and block math, a TypeScript fence
  with syntax colours, a mermaid diagram and a footnote; Source (raw
  Markdown with colours) and Live (syntax revealed on the caret line) by tap.
  **Not seen:** the plan editor and the plan sheet in Shape mode, the proof
  face's Verification text, the report summary, the iPad width, the Drey
  theme and Cyberpunk, Safari (the run was Chromium), and typing on a real
  touch keyboard. The desktop editor was covered by its suites and the
  e2e specs named in the commit, not by hand.
- **Left out on purpose** (roadmap, E10-3b): tinted line marks inside the
  rendered plan and tap-a-line editing on the phone sheet; the Ready card
  and the chat bubbles still use their own plain text (the chat files belong
  to another milestone).
### Milestone 132 — You as a team member: manual steps (E10-6)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(roadmap E10-6; ADR-0088 later change; `specs/ticket-schema.md`, "The manual
step"). What was and was not seen in a running app is at the end.

- **The human persona.** `kind: human` in `persona.md` (`personas/you`, created
  once on first sight — Team list or flow editor — titled from config
  `personas.humanName`, default "You"). Never dispatched, no capacity, budget,
  pause or model; Team shows its card as "Manual steps", not counted in the
  header.
- **The manual gate.** Chain phase `manual` / `manual-<word>`, valid only as an
  `insert` (`insert manual(you, notify) after review`); an agent persona on it
  is refused at the flow write guard. Two ways to park: a `manual` step after
  a gate (the run request carries `parkFor`; on a green gate the runner stamps
  `awaiting: you` instead of moving on) and a gate whose resolved persona is
  human (the dispatch pass stamps it before any run is composed — no run, no
  worktree). New ticket field `awaiting:`; any transition clears it;
  `dispatchable` skips it.
- **Finishing.** Accept / Send back are the existing board moves (Log line
  "manual step finished by <owner>", status `done:` line with the owner).
  Needs you gets a `manual` item ("Your turn" card with Accept and
  Send back + mandatory note) in Mission Control.
- **Flow editor.** The manual step is always offered under "Add a gate"; its
  Who picker lists only human personas, the model block is hidden for the
  owner.
- **Specs added:** `core/manual-gate.spec.ts`, orchestrator, runs, chain, needs,
  board-service-flow (accept, send back, persona creation, guard), Work card,
  Team card, flow picker.
- **Seen in a running app:** throwaway vault + own `--home`, built engine and
  Mission Control: Team lists You; the flow editor gave Build to You; with the
  chain running the ticket parked (one commit, Log line, no run), the card
  "Your turn" appeared and Accept moved it on (`build -> review`, awaiting gone).
  **Not seen:** the park-after-green-gate path against a real agent run (only
  specs), Send back in the UI, the plan-part picker offering You, phone
  hardware, screenshots (viewport measured via DOM only), the `paused:` status
  line of an in-place park (not in the status log in that run).
- **Not done:** persona editing of `humanName` in Settings, E10-5b items.
### Milestone 131 — Mission Control chat reaches its model (D-1)

**Not yet manually verified by the owner.** Owner report, 2026-11-04
("nothing gets to the model if I ask Paul or Pia"; roadmap D-1, a known
defect; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)
E5a bridge). What was and was not seen is at the end of this entry.

- **Reproduced first** with the real engine process (`engine-main.js`,
  own `--home`, throwaway tickets vault) against a mock OpenAI endpoint,
  driven through the phone's gateway routes (pair, `POST /api/chat/sessions`
  for Pia and for a shape session with `ticket`, `POST …/flow-draft`):
  with the config right, all three reach the mock; with nothing listening
  the reply was the text *"The chat model could not be reached (fetch
  failed) — Mission Control is sorry."* — no provider, no URL, and
  **written into the session as Pia's own words** (so the next turn's
  history fed it to the model as if she had said it); against a host that
  only speaks Anthropic Messages the engine POSTed `/chat/completions`
  and answered *"answered 404"*. The owner's live engine config holds
  `chat.baseUrl=http://localhost:1234/v1` with a Z.ai-style key and
  nothing listening: Drey's provider had been switched, the engine never
  heard.
- **Root cause (three parts).** (1) `syncConfig` pushed the assistant LLM
  settings only at engine activation/adoption, never when Settings →
  Assistant changed them, and skipped cleared values, so the engine kept a
  stale endpoint. (2) The bridge spoke only the OpenAI-compatible dialect
  and never learned which provider Drey uses: `zai-glm` / `anthropic`
  (Anthropic Messages) got a wrong request, the CLI providers have no
  endpoint at all. (3) A failed turn was an ordinary mission reply.
- **Sync on change.** SDK 1.40: `ctx.appConfig.onChange(cb)` (main side;
  the base store already had the hook). The tickets plugin pushes
  `chat.enabled`, `chat.provider`, `chat.baseUrl`, `chat.apiKey`,
  `chat.model` at activation **and** whenever one of them changes (an
  unrelated config write pushes nothing); a cleared value travels as
  `null`.
- **Dialects.** `services/chat-model.ts` (new, pure) is the engine's whole
  knowledge of providers: `lmstudio` / `openai-compat` / `openrouter` →
  `POST {base}/chat/completions` with a bearer key; `anthropic` /
  `zai-glm` → `POST {base}/v1/messages` with `x-api-key`, the system
  prompt lifted out and roles merged by Drey's own pure adapter
  (`shared/llm` `toAnthropicMessages`, no `electron/` import), SSE
  `content_block_delta`. `claude-code`, `copilot-cli`, `copilot-web` (and any
  unknown id) are **refused by name**: *"GitHub Copilot CLI: Mission
  Control cannot talk to this provider…"*. An engine configured before the
  provider key existed stays OpenAI-compatible. The master switch
  (`llm.enabled`) turns the chat off too, with that reason.
- **An honest failure, not a reply.** The bridge's outcome carries a typed
  `failure` (`not-configured` / `unsupported` / `unreachable` / `refused` /
  `timeout`: provider, endpoint, model, reason — node's "fetch failed" is
  unpacked to *connection refused — nothing is listening there*). The chat
  service answers `{ok: false, error, failure, file}`, streams an
  `error` event, keeps the owner's line and writes **nothing** as the
  mission's reply; a flow draft returns the same text as its error. An
  unreadable answer (the model replied outside its envelope) stays an
  honest say — the model was reached.
- **The error card.** The chat shows it under the thread, with a headline
  per kind ("Pia cannot reach the model", "Paul cannot use this provider",
  …; Paul in a shape session), the provider, endpoint and model and the
  reason, and a Dismiss button; it belongs to its session, the next turn
  clears it, a stream `error` is no longer appended as reply text.
- **Settings → Chat (the E12-3b row).** A new page: provider, endpoint,
  model, "API key: Set / Not set" (the key itself never leaves the
  engine), the reason a turn could not run right now, and **Test
  connection** — `POST /api/settings/chat/test` asks the endpoint for its
  model list (no tokens) and reports *Connected… model … is available*, *it
  does not list the model*, *the endpoint rejected the API key*, or the
  unreachable/unsupported text. Read-only: the values are Drey's assistant
  settings.
- **Specs.** Engine: `chat-model.spec.ts` (new: the table pinned against
  `PROVIDER_PRESETS`, both wires, the delta readers, the cause text, the
  probe), `chat-llm.spec` (the failure outcomes, the Anthropic wire, an
  unsupported provider, the master switch), `chat-service.spec` (no
  mission line on a failure, the flow draft's error), `settings.spec` (the
  route and the chat block without the key); plugin:
  `engine-lifecycle.spec` (provider kind, null clears, the sync on
  change); mission-ui / app: `chat.spec` (the card), `settings.spec` (the
  page and its test), `dto.spec`, `state.spec` (the card on send and on a
  new session, the probe).
- **Not in this milestone (roadmap).** Mission Control over the CLI
  providers (Claude Code, Copilot): refused by name for now, an engine-side
  CLI bridge would be its own item.
- **Seen and not seen.** Seen in the built engine and the built Mission
  Control app (in-app browser, own temp home, mock endpoint): Pia and Paul
  (shape session, plan pane) answering from the mock; the error card under
  Pia with the endpoint down; Settings → Chat with a successful and a
  failed Test connection; the gateway flow draft and the zai-glm wire
  (`POST /v1/messages`, `x-api-key`) in the scripted run. **Not seen:** the
  Paul error card and the flow-draft error in the UI (covered by specs and
  the scripted run), a real hosted provider (no key), Drey's own window
  with a Settings → Assistant change reaching the running engine (the sync
  is spec'd, the Electron round was not run), and the owner's live engine
  (not touched).

### Milestone 130 — Board, Team and Capacity in Drey (E13-8)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(roadmap E13-8; design boards DeskBoard, DeskTeam and DeskWork of the
design canvas; `docs/design/work-panel/desktop-integration.md`; the data is
E12-4's, nothing was rebuilt). Tickets plugin and engine only — no SDK, no
base change (the existing doc-kind and dock-widget registries carried it).
What was and was not seen in the built app is at the end of this entry.

- **Board tab** (`tickets-board`, `board://all`, `tickets.openBoard`, the
  Work panel's ⋯ row): the pipeline as columns, one card per ticket — id,
  kind (Running / Waiting / Plan), **persona** chip, title, **cost**, the
  worker's line or the blockers — the **cost of each column** in its head,
  "Done this week" last, **New idea** in the first column. A ticket with
  `parent:` hangs **under its ticket** (own phase, persona, cost); the
  plan's parts that are no tickets yet come from `planParts` and hang under
  the planning ticket marked `P1`, `P2` with their start line. A card opens
  the ticket page. The persona is the live run's, else the ticket's pin,
  else the column's. A ticket without a known cost shows none, never
  `$0.00`. **No estimate** on the board: it needs ≥ 3 similar runs
  (decision D9) and is the ticket header's (E13-6). A repaint keeps the
  scroll position.
- **Team tab** (`tickets-team`, `team://all`, `tickets.openTeam`): E12-4's
  Team on the desktop — head `4 personas · today $1.59`, Today against the
  summed budgets, the capacity chips (`Local 1/2`), **Pause all / Resume
  all** (`chainMaster`), the armed **Stop all** (`chainAbort`), a card per
  persona (avatar, role · phases, state word idle / running / `2 running` /
  waiting / stuck / paused, the day's cost line and bar, one row per live run
  with the worker's line). A flagged run turns amber (`No progress for 9
  minutes and the context is filling up (78%).`) with **Nudge**, **Hand to
  Claude Code** (not offered on a run already there) and **Stop**. A card
  opens the persona's detail beside the grid: **1:1** (the coaching thread
  and composer, Ctrl+Enter sends), **Memory** (entries, Pin, teach a line)
  and **Setup** (worker, model, pool, phases, cost, Pause / Resume persona).
- **Capacity band** (dock widget `tickets-capacity`, bottom dock, closed by
  default, `tickets.showCapacity`): `2 of 5 slots busy`, the pool chips, one
  line per persona (`idle`, `works on T-0121`, `waits for you on T-0121`,
  `stuck on T-0126`), Today against the budget, Pause all, **Open Team ›**.
  The header status reads `1 stuck` / `2 running`.
- **Tickets panel parity** with the mobile list: every row carries the
  **persona** chip and the **cost**; the queued ideas are their own
  **Prioritized** group ("waits for Ben") between Shaping and Ideas
  (`applyWorkFilter` splits on `queued`; `workGroups` is unchanged).
- **Engine / main.** The invoke allowlist gained `TEAM_METHODS` — the remote
  port's own `personas`, `handoffRun`, `chainPersonaPause`,
  `personaThread[Append]`, `personaMemory[Append|Pin]`, `planParts` — and the
  plugin main the matching IPC routes (`personas`, `personaPause`,
  `handoffRun`, `personaThread[Append]`, `personaMemory[Append|Pin]`,
  `planParts`). The Team tab therefore shows what the phone shows.
- **Build.** `scripts/build-plugins.mjs` no longer tries to copy a
  sub-folder of `renderer/` as an asset (it crashed on `board/` and `team/`;
  their sources are bundled into `index.js` like every other).
- **Code** (all under `plugins/tickets/renderer/`): `desk-deps.ts` (the seam
  to `index.ts`'s store), `team/` (`team-model`, `team-store`, `team-view`,
  `capacity-view`), `board/` (`board-model`, `board-view`), `desk.css`.
- **Specs / tests.** `team-model.spec` (money, role, state words, stuck copy,
  budget share, capacity chips, the model), `board-model.spec` (columns,
  cost per column, persona ladder, parts under their ticket, plan parts),
  `team-store.spec`, `team-view.spec` (jsdom: Team, Capacity, Board incl.
  Nudge / Hand-off / Stop, Pause all, armed Stop all, detail),
  `work-panel.spec` (persona + cost, Prioritized), `engine.spec` (the team
  reads over invoke), `e2e/desk-board-team.spec.ts` (the built app, below);
  `e2e/work-panel.spec.ts` follows the Prioritized group.

**Seen in the built app** (Playwright over the production build, seeded
tickets vault with four personas, a ledger of settled runs and a plan with
parts; screenshots `desk-board.png`, `desk-board-build.png`, `desk-team.png`,
`desk-capacity.png` in the e2e output and the session notes): the Board with
persona chips, card costs, `$3.61` on Build, the plan card with its released
part and two plan parts, the scroll position surviving a board refresh; the
Team with the capacity chips, a waiting persona, the stuck persona's amber
row and its three buttons, the day's cost bars and the Setup detail; the
Capacity band in the bottom dock (`2 of 5 slots busy`, `stuck on T-0126`);
the Prioritized group and the row costs in the Work panel.
**Not seen:** the fleet runner does not run under e2e, so the live runs were
a pushed `fleet-changed` snapshot — Nudge, Hand to Claude Code, Stop, Pause
all and Stop all were **not pressed in the real app** (covered by the jsdom
specs only); the 1:1 and Memory panes were not opened against real data; no
estimate (D9) is shown anywhere, so none was checked; light and Cyberpunk
themes were not looked at.

**Not done / open:** "New persona", "Remove from team" and editing a persona's
Setup (the port's `personaPatch`) are not on the desktop yet — Setup is a
read-out plus Pause / Resume; the 1:1 is the coaching thread of E12-4 (the
Assistant target "1:1 per persona" is E13-5); the persona's share of the
pool slots (`1/2`) in the band needs a per-persona slot count the engine does
not report; the improvements ("Friction") card is not on the desktop; the
Board has no drag between columns (a card's move stays in the Work panel's
row menu); the Board and Team tabs have no home view yet (E13-13). **Test
hazard, not fixed here:** the tickets e2e specs adopt the engine of the
owner's `~/.drey-engine` when one runs (they then read the real board);
`desk-board-team.spec.ts` points `USERPROFILE` at a temp home so it spawns
its own engine — the other tickets specs still need that, or a stopped
engine, to pass on this machine.
### Milestone 129 — The ticket as a document (E13-6)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(Mission Control on the desktop, inside Drey; design canvas boards
DeskReady, DeskTabs, DeskWork). A ticket file in the editor now reads like
the phone's ticket screen: the same content, edited in place.

- **Header strip** (under the req-62 chip row, `renderer/ticket-document/`):
  the status chip (why it waits for you — *Ready to try*, *Plan to approve*,
  *Question* … — *Running*, *Blocked*, or the phase), the persona doing the
  current step, the cost (`$1.84 in total` when it waits for you, `so far`
  while it is worked), the **estimate** of the step now due (E11-4, hover for
  its basis; only with three or more similar runs), the **chain** (every step
  with who does it, ✓ / ● / ○, ◆ for your checkpoint, from the engine's own
  `mergeChain` with the ticket's `chain:` delta; persona = delta, else the
  ticket pin, else the column's) and the **gate** (`Waits for you: …`).
- **Proof widget.** `## Verification` (the section the verify step writes —
  the roadmap called it Proof) is drawn as a block: verdict (`3/3 green.`),
  checks with notes and video times, screenshots from `tickets/attachments/`
  (a click opens the picture), the walkthrough `<video>` from
  `tickets/videos/` with a chapter button per shot, the `Video removed (size
  limit).` note, the findings. It is a block *replace* over the section body:
  the caret entering it shows the Markdown again (the table rule).
- **Cost table** at the end: one row per settled `## Verlauf` run (phase,
  model, tokens, time, cost) and the total row; an unknown figure reads `—`
  and is never zero.
- **Action bar** under it: *Send back…* and *Accept and move to <next
  column>* at one of your checkpoints (the Ready card's own `sendBack` /
  `acceptTicket` calls; the send-back modal was lifted to module level),
  always *Thread* and *Open Review*. **Open Review opens the ticket's thread
  tab** (result card and changes) until the Review tab exists (E13-7).
- **Base / SDK:** none. Everything is the generic `registerFrontmatterView` /
  `registerExtension` seams with the host's CodeMirror modules. Plugin main:
  `personas` and `estimate` IPC; the engine's invoke channel exposes
  `estimateOf`. The plugin cannot import `libs/mission-ui` (Angular), so the
  few word helpers (`$1.84`, `48k`) are rewritten over the engine's readers
  (`parseVerificationSection`, `parseVerlaufEntries`, `mergeChain`,
  `RunEstimate`).
- **Three pre-existing defects fixed on the way** (each blocked the real run):
  (1) the engine hosts the vault as `standalone`, so `snapshot.vaultId`
  never equalled Drey's vault id — the req-62 ticket header never matched and
  the thread's "Ticket file" link opened nothing; `main/host-vault-id.ts`
  maps it to the Drey vault (same folder name, holds `pipeline.md`) in the
  `board` IPC answer. (2) `run-composer.ts` applied the quiet-start pre-fill
  before `paint` existed (`setContent` fires `onChange` synchronously →
  "Cannot access 'paint' before initialization", the whole thread view died for
  a ticket with a pre-fill); the pre-fill now applies after `paint`.
  (3) `scripts/build-plugins.mjs` copied every non-`.ts` entry of
  `renderer/` and crashed on a subfolder; folders are skipped (their sources
  are in the bundle).
- **Specs added:** `ticket-document/model.spec.ts` (words, section ranges,
  proof view, cost table incl. unknown figures, estimate line, chain with
  pin/delta), `dom.spec.ts` (proof, cost, bar, strip), `e2e/ticket-document.spec.ts`.
- **Not done / not seen:** video playback of a real recording (the player is
  checked as an element with its `drey-asset` URL; the vault protocol answers
  without Range, so seeking in a long video is untested), the 25 MB video rule
  (E11-1c), the Source-mode escape (the widgets also show in source mode),
  narrow-width wrapping beyond the CSS wrap rules.

### Milestone 128 — Mission Control flow editor (E10-5)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(concept v2 §5.7; design boards "iPad: Flow editor" and its phone twin;
ADR-0088 E10 – E12). See the end of this entry for what was and was not
seen in a running app.

- **Chain grammar.** `before` / `after` and the per-part scope existed
  (E9, E10-1); added are `move <phase> after|before <anchor>` (a standard
  gate runs elsewhere) and `assign <phase> <persona>` (a standard gate's
  persona), with merge (`moved` mark, pinned persona) and write-guard rules
  (`specs/ticket-schema.md`, "The chain delta").
- **Edit the arrangement, not the strings** (`core/flow-edit.ts`).
  `applyFlowOp` takes a draft delta and one edit — insert after a gate,
  remove (a strike, or dropping an insert), restore, move earlier / later,
  persona, tell me, reset — and returns the next delta, regenerated
  canonically: the longest in-order run of standard gates stays silent, the
  others get `move`, new gates `insert`, then `skip` / `notify` / `assign`.
  The result is validated and merged back; an arrangement the grammar
  cannot write is refused with a reason. Only the future is editable.
- **Wire.** `GET /api/tickets/<id>/flow[/<part>]` (the gates from the
  current one on with persona, model, owner mark, locks; the phases to add;
  the personas), `POST …/flow-edit` (stateless: draft in, draft out, nothing
  written), `POST …/flow-save` (ticket header through `setChain`, or the
  part's `chain:` line in the parent's plan, one commit `tickets: <id> part
  <n> flow`; refuses a released part, a live run, a delta the guard
  rejects), `POST …/flow-draft`.
- **Paul drafts.** "Ask Paul" runs one bridge turn under `FLOW_SYSTEM_PROMPT`
  (the standard flow, the flow now, the crew; the reply is the mission
  envelope with one `setChain`); the desk reads the draft back through the
  same guard and returns it with his reason. It is the working draft,
  dashed, with **Undo draft**; nothing is written.
- **The screen** (`libs/mission-ui/src/flow`). The gates as a list — dot,
  title, who · model (`you` for the owner's own gates), marks (`current`,
  `added`, `moved`, `struck`, `tell me`) — with a 44 pt **+** connector
  after each; the chip `Standard flow` / `Standard flow + n changes`;
  changed gates dashed against the saved flow. The inspector for a tapped
  gate: Who (Pipeline default or a persona), Model (the persona's, shown),
  Tell me when it is done (switch), Runs after, Earlier / Later, Add a gate
  after, Remove / Restore gate; a bottom sheet while the editor is narrow,
  a side column from 720 px of editor width (container query). Foot: ask
  Paul, **Reset to standard flow**, **Save flow** (disabled until the draft
  differs). A read-only device sees the flow and changes nothing.
- **Entries.** `Change flow ›` on each card of the plan to approve opens
  that part's flow (a released part has no link); the ticket screen's gate
  sheet opens the ticket's own flow with **Edit the flow**. Save closes the
  editor, toasts `Flow saved` and refreshes the cards and the ticket.
- **Specs added:** grammar round trip, merge, guard (`flow-edit.spec.ts`),
  the ops incl. the regeneration property; the service on a real temp vault
  — ticket and part scope, persona/model/owner, locks, refusals, save into
  the header and the part line, Paul's context (`board-service-flow.spec.ts`);
  the flow prompt on the wire (`chat-llm-flow.spec.ts`); the port
  composition of a draft (`drey-port.spec.ts`); the routes incl. a read-only
  device (`router.spec.ts`); the DTO reader, helpers and the screen
  (`flow/flow.spec.ts`); the state's open / edit / draft / undo / save
  (`state.spec.ts`); the approve link and the sheet row.
- **Seen in a running app:** the engine (`engine-main`, a throwaway demo
  vault with English content, loopback remote, a stub OpenAI-compatible
  endpoint for Paul) served the production build to the built-in browser,
  paired as a device. At 1194 × 834 (docked layout) and 375 × 812 the flow
  of a part (`Change flow ›` from the plan to approve) and of a ticket (gate
  sheet) were driven through the DOM: restore a struck gate, move Verify
  earlier (`moved` mark, chip + 1 change), add a gate and give it Ralf and
  tell me, Paul's draft with his reason (dashed gate), Save flow — the files
  carried `chain: move verify after build; notify build` in the part and
  `chain: - insert security(ralf, notify) after review` on the ticket, one
  commit each, and the ticket's gate bar showed the new gate. 44 pt targets
  and no horizontal scroll were measured. **Not seen:** the built-in
  browser would not return screenshots (pane hidden, 5 s timeouts), so the
  layout, the dashed styling and the sheet were **not looked at, only
  measured**; a real iPad / iPhone (Safari); the dark / Drey / Cyberpunk
  themes; a draft from a real model; the side-column inspector (the demo
  layouts were narrower than 720 px of editor width).
- **Not done:** Paul proposing a flow for every new plan (the switch), a
  per-gate model pick, the default flow in Settings → Tickets, the fleet
  executing `move` / `assign`. Roadmap: E10-5b.
### Milestone 127 — View presets and home views (E13-2, SDK 1.39)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(roadmap E13-2; ADR-0089 decisions 2 and 7, "Later change: presets and home
views"). Content-agnostic: nothing ticket-specific in the SDK or the base; the
tickets plugin's own "Work" preset is E13-13 and is not built here.

- **SDK 1.39** (`shared/plugin-api/`): `api.ui.registerViewPreset({ id,
  label, layout?, assistantTarget? })` returns an `Unsubscribe`;
  `api.ui.switchView(id)`; `homeView?: string` on `PluginDocKindContrib` and
  `FileOpenerContrib`; `stayInView?: boolean` on `documents.open` and
  `documents.addDoc`. `ViewPresetLayout` = widget ids per dock
  (`left`/`right`/`bottom`), `open`, `folded`.
- **Base** (`src/app/views/view.service.ts`, `dock/dock.service.ts`,
  `services/home-view-router.service.ts`): presets join the switcher after
  Notes (not renamable, not deletable, not saved — the plugin re-registers at
  every start); the first layout is seeded into the dock when the view is
  first shown (`DockService.seedView`), afterwards the owner's arrangement
  rules; a taken or empty id is refused (logged); disposing the registration
  removes the view and lands in Notes when it was active. An active preset
  from the last run survives until the plugins have registered
  (`ViewService.settleStartup`, head of `SessionService.restore`); a vanished
  plugin sends the owner to Notes with the layout kept.
- **Home views.** Opening a tab of a kind (`addDoc`) or a file claimed by an
  opener (`openFile`) that names `homeView` switches to that view first, so
  the tab lands there; `stayInView` opts out; a session restore never
  switches (`HomeViewRouter.suspend`).
- **Assistant target.** The preset's `assistantTarget` is carried per view
  (`ViewService.assistantTarget()`); the base reads nothing from it (E13-5).
- **Sample plugin**: view "Sample" (`left: sample`, `right: files`), the
  command "Sample: switch to the Sample view", and the clock kind with
  `homeView`. `plugins/AUTHORING.md`, `TUTORIAL.md`, manual (Views),
  docs/05 and ADR-0089 updated.
- **Not built.** "Opening a note from Work goes to Notes" (needs a notion of a
  note the base does not have), a UI row "Open in this view", the Assistant
  actually using the target.
- **Specs**: `view.service.spec.ts` (9 new: order and protection of presets,
  refused ids, first-show layout then owner's changes, unknown panels, target
  per view, removal of the active preset, startup settling, router,
  opener home view with `stayInView`).

### Milestone 126 — Mission Control plan to approve (E10-4)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(concept v2 §5.9; design boards "iPad: Plan to approve" and its phone
version; ADR-0088 E10 – E12; recut of ticket T-0079). See the end of this
entry for what was and was not seen in a running app.

- **The screen.** "Split into N tickets" on Paul's split card (and the new
  **Plan to approve · N parts** button on the ticket face of a ticket
  whose plan lists two or more parts) opens a full-screen layer, one step
  under the ticket screen: `Plan to approve · 3 parts` over the ticket's
  title, then **one card per part** — `Part 2`, the title, the builder
  (a button with the persona's dot; the chips under it list every persona
  of the vault), the reason, a **Flow** row (`Build · Ben → Commit`,
  inserted gates accent, skipped gates struck, `(tell me)` on a notify
  gate, `standard` or `standard + 2 changes`; `Change flow ›` is a
  placeholder until E10-5), the start rule (`Runs now`, `After part 2`,
  `Released as T-0141`) and the estimate.
- **Move and delete.** A tap on a card opens `↑ Move up`, `↓ Move down`
  and `Delete part`; delete asks for **a second press** (`Press again to
  delete`, forgotten when another card opens). The edit is written into
  the parent's `### Parts` chapter (`tickets: T-0130 parts`, one commit);
  a list never drops below two parts ("A split needs two parts. Keep the
  plan as one ticket instead.").
- **Locked parts.** A part that is a ticket already — queued, running, in
  a later gate or done — is locked: no builder pick, no move, no delete,
  nothing may be placed above it (`Running: this part cannot be moved or
  deleted, and no part can be moved above it.`, `Open ticket`). The
  desk decides (`movePlanPart` / `deletePlanPart` with the released set);
  the screen only mirrors it.
- **The start rule is the plan's order.** Part n+1 carries `blocked-by:`
  the ticket of part n, so it starts when the part before it reaches the
  pipeline's terminal phase; under each card `Part 3 starts when this one
  is done.`
- **The estimate (D9).** Per card the build gate's estimate for the
  builder on its own model — `Estimate $0.30 · 9 min · median of 6 similar
  runs` — only with at least three similar runs, otherwise `Estimate not
  yet · fewer than 3 similar runs so far`; the foot says `Typically $0.90
  for 2 of 3 parts, from your own past runs · nothing runs until you
  approve.` (the parts still to run, those with a basis). It is the build
  gate only, not the whole flow.
- **Mission Control's proposal and the approval.** The foot's first line
  is Mission Control's proposal for the parts still to release (`Mission
  Control proposes to approve all 3 parts. Part 1 runs now; each part
  after it starts when the one before it is done.`); **Approve and run**
  releases them, **Run part 1 only** (`Run part 2 only` behind a released
  part) releases just the first. Nothing runs before the tap; a read-only
  device sees the cards but cannot edit or release. The card itself is
  the confirmation surface — a tap on the app's own screen, not a chat
  proposal card (ADR-0088 later change).
- **The release** (`POST /api/tickets/<id>/release`, `{scope: all|first}`,
  `BoardService.releasePlan`). Everything is checked first (personas
  exist, each part's chain delta validates against the build phase) and
  nothing is written on a refusal; then one ticket per new part is minted
  **in the build queue** (`created in inbox`, `inbox -> build`) with
  `parent:`, the builder's `persona:`, its own `chain:` and `blocked-by:`
  the part before it, the parent's repo and priority, and a description
  naming the part, its reason and the parent. One commit `tickets: T-0130
  plan released (3 parts)`; the parent keeps the plan and gets the Log
  line `plan released: T-0131, T-0132, T-0133`. A part is matched to its
  ticket by title among the tickets naming the parent. After **Approve
  and run** the screen closes, a toast says `Released 3 tickets` and Work
  opens; after **Run part 1 only** the cards stay up with part 1 locked
  (`● queued · locked`) and the proposal now covers the rest.
- **Wire.** `GET /api/tickets/<id>/parts` (the cards, the build gate, the
  default builder, the personas with their models), `POST …/parts` (`{op:
  persona|move|delete, …}`), `POST …/release`. No touches, overlap or
  routing anywhere (D5).
- **Specs added:** the release matcher, states, locks, start lines,
  minting order and the part ticket file (`core/plan-release.spec.ts`);
  the cards, the edits with the locks, the release in a real temp vault
  incl. blocked-by resolving on the board and refusals writing nothing
  (`services/board-service-parts.spec.ts`); the command parsers and the
  routes incl. a read-only device (`commands.spec.ts`, `router.spec.ts`);
  the DTO reader, the card helpers, the estimate and total wording, the
  proposal wording and the screen — cards, second-press delete, locks,
  approve scopes, refusal, no overlap words (`plan/approve.spec.ts`); the
  state's open-after-split, refresh, edit, release and board refresh
  (`state.spec.ts`); the ticket face's entry (`view.spec.ts`).
- **Seen in a running app:** the engine (`engine-main`, a throwaway demo
  vault with English content, remote on loopback) served the production
  build to the built-in browser paired as a device. At the tablet width
  (1194 × 834 emulated, the pane scaled it) and the phone width (375 × 812)
  the cards, the move (`tickets: T-0130 parts` landed), the second-press
  delete, the persona chips, a skipped gate struck in the flow row, the
  estimate (`$0.30 · median of 4 similar runs`, `not yet` for a persona
  with two runs, `$0.61 for 2 of 3 parts`), **Run part 1 only** (part 1
  `queued · locked`, T-0131 on Work), then **Approve and run** (T-0132
  and T-0133 on Work, `waiting for T-0131` / `T-0132`, the files
  carrying `parent:`, `persona:`, `chain:`, `blocked-by:`) were driven by
  hand. **Not seen:** a real iPad or iPhone (Safari), the entry through
  Paul's split card (its chat turn needs a model; the state spec covers the
  hand-over), the dark/Drey/Cyberpunk themes beyond Anthrazit, a running
  part (the lock for `running` is spec-tested only), and the estimate's
  first paint — it reads `not yet` until the desk's answer arrives.
- **Not done:** the flow editor behind `Change flow ›` (E10-5), the whole-
  flow estimate, a parent that leaves "needs shaping" after the release,
  the desktop widget (E13-10). Roadmap: E10-4b.

### Milestone 125 — Link fallback to other vaults (E13-4)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(roadmap E13-4; ADR-0051 / ADR-0059 later changes). Base only, no SDK
change.

- **Resolution.** A `[[wikilink]]` of a vault-scoped note is resolved in
  its own vault first — unchanged. Only when that finds nothing **and the
  link's vault has the fallback on** are the other registered vaults
  searched: the active vault first (when it is not the link's own), then
  the registry order. The first vault with a match wins; within a vault
  the existing rules hold (unique name, sibling, shortest path; path
  targets work too — a fallback vault has no sibling preference). A name
  found in several fallback vaults is **ambiguous**: it opens the first.
  Nothing is created when any vault matches; a link that matches nowhere
  still creates its note in its own vault. The pure rule is
  `resolveWikilinkAcrossVaults` (`shared/wikilinks.ts`).
- **Link check and hover.** `WikilinkService.inspect` feeds the editor's
  link check: a link that resolved into another vault gets the hover
  title `In vault “Tickets”`; an ambiguous one `Ambiguous: also in
  “Archive”. Opens the one in “Tickets”.` and a dashed underline
  (`cm-wikilink-ambiguous`). Same-vault links look as before. The marks
  refresh when the document is edited or scrolled, like every tree change
  (a toggled setting does not repaint untouched text at once).
- **Settings → Vault → Links.** One switch per registered vault, "Also
  look for link targets in other vaults (<vault>)", stored as
  `vault.linkFallbackVaults` (vault ids), **off for every vault by
  default** — so following a link that matches nothing creates the note
  as before.
- **Backlinks.** The panel also lists links that reached the shown note
  through the fallback (`collectFallbackBacklinks`): links of vaults that
  opted in, unmatched at home, whose fallback search lands first on this
  note — an ambiguous name counts for its first match only, exactly where
  Ctrl-click opens. Such a row carries the linking note's `vaultId`; the
  click opens it in that vault.
- **Not changed.** Link-integrity rewrites on rename (ADR-0059) stay per
  vault; vault-less documents keep their merged index; `[[` completion
  stays per vault; the entry drawer still resolves in the active vault.
- **Specs / tests.** `shared/wikilinks.spec.ts` (order, ambiguity, off,
  own-vault first), `WikilinkService` (off by default creates, own first,
  other vault opens and names it, ambiguity, active vault first, opt-in
  per vault), decorations (title, ambiguous class), backlinks
  (`collectFallbackBacklinks`), config normalisation. Docs: ADR-0051 and
  ADR-0059 later-change notes, docs/05, docs/06 §6.46, the manual.

### Milestone 124 — Status bar slot for plugins (E13-3, SDK 1.38)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(roadmap E13-3; Mission Control on the desktop inside Drey).

- **SDK 1.38** (`shared/plugin-api/`): `api.ui.createStatusItem({ text,
  icon?, tooltip?, commandId?, priority? })` returns a `StatusItemHandle`
  (`update(patch)`, `dispose()`). Content-agnostic: no tone or colour
  field, no ticket/cost/fleet meaning in the SDK or the base. An item with
  neither text nor icon is hidden; the host removes a plugin's items when
  it is disabled.
- **Base** (`src/app/plugin-host/status-items.service.ts`, `src/app/status-bar/`):
  items sit right-aligned left of Settings, higher `priority` further
  left, registration order within equal priority; with a `commandId` the
  item is a button that runs the command, otherwise plain text.
- **Sample plugin**: a "Sample" item that runs `sample.stamp`
  (`plugins/AUTHORING.md` documents 1.38).
- **Tickets plugin** (`renderer/status-slot.ts`): "2 running · 3 need you"
  from the fleet's live runs and the board's needs-you count (the same
  number the Work panel header shows); hidden when both are 0; a click
  reveals the Work panel (`tickets.showBoard`). No cost text yet — the
  renderer holds no cost number today.
- **Specs**: `status-items.service.spec.ts`, `status-bar.spec.ts`,
  `status-slot.spec.ts`.


### Milestone 123 — Views: saved layouts with their own tabs (E13-1)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(ADR-0089, accepted with this change; design
`docs/design/work-panel/desktop-integration.md`, boards 7a–7j). The base half
of the desktop integration: the shell can hold several saved layouts. Checked
in the unit suites and, for the switcher, the dock layouts and the persistence,
in the dev renderer in a browser pane (no Electron, no vault, so **no tab was
opened by hand**: tabs per view, "Show this tab in", "Show here" and the
session restore are covered by specs only).

- **A view** is a named layout: its dock state (`DockService`), its pane tree
  with docked bands and tabs (`PaneService`, `ViewSlot`). `ViewService`
  (`src/app/views/`) owns the list and the active id; switching restores the
  other view's panes, sizes and tabs exactly as left. **Notes** is today's
  layout and always exists; others come from *View → Save current layout as a
  view…* (name field under the title bar; copies the layout, tabs included,
  documents shared) and can be renamed or deleted (right-click on the
  switcher button). Plugin presets and `homeView` are E13-2.
- **Switching.** Title-bar switcher (segmented up to four views, a menu above;
  invisible with Notes alone), `Ctrl+1`–`Ctrl+9`, the **Switch view** command
  (next, wrapping) and View-menu rows. `Reset layout` resets the active view.
- **Tabs belong to views.** The other views' tabs are hidden; one tab may be
  shown in several (tab menu *Show this tab in*, the last tick stays; Open
  windows lists the view's tabs and, under *In other views*, the rest with
  *Show here*; its count is the view's). One document, one buffer: dirty
  state, save and save conflicts act on the document in every view. A tab's X
  leaves only the active view while another one shows it (no prompt); the
  document closes with the unsaved-changes prompt when the last view lets go.
  Deleting a file closes its tab everywhere; a rename follows it everywhere.
- **Persistence.** `drey.dock` is now `{ active, views }` (the old blob reads
  as Notes); the session snapshot (still version 2) gains an additive `views`
  map, `layout` stays the Notes layout, `tabs` is the union. A snapshot
  without views restores into Notes; a vanished view's layout is dropped and
  a document only it held is closed.
- **Specs.** `view-slot.spec`, `pane.service.views.spec`,
  `dock.service.views.spec`, `view.service.spec` (switching, tab ownership,
  closing, delete, name field), `session.service.views.spec` (write, restore,
  old snapshot, vanished view); the folded-side spec follows the new blob.
  Also in this change: `menu.service` and `session.service` import
  `PaneService` from its file, not the `panes` barrel — the barrel pulls
  `PaneLeaf` → `TabBar` → `ViewService` into a runtime loop that
  `check-cycles` does not see but the test bed does.
- **Docs.** ADR-0089 accepted with an "As built" section, docs/05 (component
  reference, feature index), docs/06 §6.76, manual §16 "Views".

### Milestone 122 — Mission Control shape mode (E10-3)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(concept v2 §5.8; design boards "iPad: Shape the plan", "Phone: shape
thread", "Phone: shape with the plan sheet"; ADR-0088 E10 – E12). Not
visually checked in a running app — the specs and the production build
are what ran. "Split into N tickets" only records the choice; the plan to
approve (E10-4) picks it up.

- **Entry.** The ticket face of a ticket that has not reached the build
  queue offers **Shape with Paul**: the chat opens on that ticket's shape
  session (an existing one reopens, otherwise a fresh composer waits for
  the first message, which starts the session with `ticket:`).
- **The dialog.** Context line `Shaping T-0130 with Paul · opus · reads
  only` and, once he has read files, `Context: CLAUDE.md · roadmap.md ·
  +2`; Paul's messages carry `Paul, via Mission Control`. The model is
  the chat model (`GET` session → `model`).
- **Paul's turn** (`SHAPE_SYSTEM_PROMPT`, `chat-llm.ts`). One JSON
  envelope with optional `plan`, `question`, `split`, `read`. He reads the
  ticket's repository through `readRepoFile` (read-only, the ticket's own
  `repo`, no `.git` / dependency folders / secrets / binaries, 6 paths and
  3 rounds at most) and writes **only the `## Plan` chapter** through
  `setPlan` (`core/plan-section.ts`; one commit `tickets: <id> plan`;
  refused while a run is live). The shape reply never streams as raw
  JSON — the screen shows what he reads and waits. The shadow copy and
  the delta of milestone 121 are unchanged.
- **Answer cards.** A `question` lands as a `question` line in the
  session file and, while it is the last thing in the thread, as the
  block above the composer: the choices as pills (`recommended` tagged),
  "Pick an answer, then send it. Or write your own below.", and a
  `Send “…”` button — the pick is never the action.
- **Split proposal.** `split` lands as a card: Paul's reason and **N
  counted from the plan's `### Parts`** (never fixed; one part or none
  offers only "Keep as one ticket"). "Keep as one ticket" moves the
  ticket into `build` through the board's transition; "Split into N
  tickets" records `split-decision split`. Both are in the chat card and
  in the plan pane's foot.
- **The plan beside the dialog.** `mc-plan-pane` (`libs/mission-ui/src/plan`):
  the Plan as a list of collapsed chapters (Goal and Parts open, the
  parts with persona and reason), the E10-2 status line, an **Edit**
  toggle swapping in a text field (the Markdown surface arrives with
  E12-6), saved on Done and — through `setFlush` — before the next
  message goes out; a refused save keeps the message back. Wide
  layout (≥ 1024 px, chat docked): the pane takes the center column. On
  a phone / tablet: a **Plan** row in the thread (`3 parts · 1 open
  question`) opens it as a bottom sheet.
- **Specs added:** the Plan-section writer (replace, add before Log,
  demotion, CRLF), the envelope's shape fields and bounds, the bridge's
  shape prompt, read rounds, round cap and silent stream, the session
  file's question / split / decision / sources lines, the chat service's
  plan write, failure note, N from parts, keep / split decisions and
  refusals, the board's `setPlan` and `readRepoFile` (path guards), the
  route, the DTO readers, the chat's context line / answer block / split
  card / plan row, the plan pane (chapters, edit and save, refusal,
  decision), the state's begin / start / decide / save / flush.
- **Not done:** tinted marks and line-level editing inside the plan, the
  formatting strip (E12-6), Paul on his own persona model, the plan to
  approve (E10-4), the flow editor (E10-5). Roadmap: E10-3b.

### Milestone 121 — Mission Control plan delta (E10-2)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(concept v2 §5.8; ADR-0088 E10 – E12). The mechanism is complete on the
engine and in the app; E10-3 (Shape mode) adds the entry point that
starts a shape session for a ticket — until then the chip, the card and
the marks appear only for a session the desk was told to shape
(`POST /api/chat/sessions` with `ticket`).

- **Shadow copy.** Per shaped ticket the engine keeps the plan as it was
  at the end of the model's last turn plus a turn counter and the lines
  the model changed (`services/plan-shadow.ts`, machine-local file
  beside the engine config). The first turn sends no delta.
- **Only your delta goes back.** A message in a shape session carries
  the change shadow → current plan as a summary and a line diff
  (`core/plan-delta.ts`, LCS) ahead of the owner's words
  (`ChatBridge.runTurn` → `planDelta`); the model's own edits are never
  mirrored back, and the history handed to the model skips the card.
- **Chip and card.** Over the composer a chip reads `2 new edits of
  yours go along`; tapping it leaves them out for the next message
  (shown struck through; reset after sending — the edits are then
  acknowledged but never sent). The history gets a **You edited the
  plan** card with the summary and the diff, written into the session
  file directly before the owner line (`- '<UTC>' plan-edit — …`).
- **Marks.** The ticket face shows `The model saw plan v7 · 1 edit of
  yours since` and, under it, the changed lines with their number and
  who changed them last (`you` since the shadow, `model` in its last
  turn) — `GET /api/tickets/<id>/plan`. These are listed lines, not
  tints inside the rendered plan.
- **Specs added:** the plan section reader, the line diff and delta
  (groups, numbering, pure deletion, model-facing text), the shadow
  stores, the chat flow (first turn, delta as card and as model input,
  model edits not mirrored, deselected chip, status and marks), the
  session file's card and `ticket:` key, the routes, the DTO readers,
  the chip and status-line wording, the state's payload and refresh.
- **Not done:** tinted marks inside the rendered plan and the editor,
  the "editor saves before sending" step (the Markdown surface arrives
  with E12-6), and per-run shadows (one shadow per ticket).

### Milestone 120 — Plan parts schema + parser (E10-1)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(concept v2 §5.9; ADR-0088 E10 – E12). Engine only — nothing on screen
changes yet; E10-2 – E10-5 build on it.

- **`### Parts`.** `core/plan-parts.ts` reads and writes the optional
  chapter under `## Plan`: one `- [ ] <title>` per part in execution order
  with indented `persona:`, `reason:` and `chain:` details (the chain
  entries in the chain-delta grammar, `;`-separated). The reader is
  tolerant — stray lines, unknown keys, a bad persona and unreadable
  chain entries warn and drop; `withPlanParts` replaces the chapter in
  place or appends it to the Plan and removes it for fewer than two parts
  ("Keep as one"). `movePlanPart` / `deletePlanPart` are list edits that
  refuse a running part and any move ahead of one.
- **`parent:`.** The frontmatter key naming the ticket a part belongs to
  (`TicketMeta.parent`); a value that is no ticket id or the ticket's own
  id warns and reads as no parent.
- **Specs:** the round trip, tolerance cases, CRLF, chapter boundaries,
  replace/add/remove placement, move/delete incl. the running-part lock,
  the `parent:` reader. Spec text: `specs/ticket-schema.md`, "Parts".
- **Not done:** per-part scope in the chain machinery (a part's `chain:`
  is parsed, the dispatcher reads only the ticket's own until E10-4
  creates the part tickets).

### Milestone 119 — Mission Control cost table + estimate (E11-4)

**Not yet manually verified by the owner.** Owner request, 2026-11-04
(concept v2, decision D9, design board "Ready to try" — "How it got here").

- **Cost table.** The ticket face ends in a **Cost** card instead of the
  raw History YAML: one row per settled run from the ticket's
  `## Verlauf` — gate (by its pipeline title), `Ben · sonnet`, minutes ·
  tokens, dollars — and a total row with the summed cost and time. A
  cost or time the line does not carry reads `—` / is left out and never
  counts as zero. The raw lines stay in the file and the raw editor.
- **Estimate.** Under the gate bar, for the gate now running: `About
  $0.30 · 9 min · 48k tokens — median of 6 earlier Build runs by Ben on
  sonnet.` The figures are medians over the owner's own history — the
  `## Verlauf` lines of every ticket under `tickets/`, archive included
  (`core/estimate.ts`, `GET /api/estimate/<gate>/<persona>/<model>`) — for
  runs of exactly that gate + persona + model that were handed over and
  carry a cost. **With fewer than three such runs there is no estimate**,
  nothing is shown. The model is the one the persona is set to.
- **Money.** Every ticket/work cost slot writes `$1.87` now (the German
  `1,87 $` is gone; the Team tab changed in milestone 115).
- **Specs added:** token/minute words, the median rules (minimum, even
  count, filters, missing figures), the board read over live and archived
  tickets, the route, the estimate DTO reader, the cost table rows and
  totals, the estimate sentence.
- **Not done:** size classes (decision D9 puts them later); the plan
  card's per-part estimate arrives with E10-4; the state's estimate memo
  has no spec of its own.

### Milestone 118 — Mission Control line comments (E11-3)

**Not yet manually verified by the owner.** Owner request, 2026-11-03
(concept v2, decision D6, design board "iPad: Review a file").

- **Commenting.** On the proof card's diff the new file's line numbers
  are buttons: a tap opens a composer under the line, a tap on another
  line of the same file stretches it into a range (`Lines 30–33`); the
  selected lines are tinted. **Add to review** turns it into a pending
  card (`Line 27 · you · pending`) with **Edit** / **Delete**. Removed
  lines carry no number in the new file and take no comment. Comments are
  kept per ticket on the device until they are sent.
- **Send back.** The button reads `Send back with n comments…`; the note
  is optional once comments exist (they stand in for it). The desk
  (`POST /api/tickets/<id>/send-back`, `comments: [{file, line, endLine,
  text}]`) validates and caps them (50, 1000 characters each), moves the
  ticket to the earlier agent phase as before and writes a
  `### Review feedback` block into the ticket's `## Handover` in the same
  commit (`core/review-feedback.ts`); a second send-back replaces the
  block. Build prompt version 5 tells the persona to answer every line.
- **English.** The leftover button label `Annehmen & mergen` is now
  `Accept and merge`.
- **Specs added:** comment parsing and capping, the block's render/parse
  round trip and its replacement, the Handover placement (existing,
  missing, last section), the route (comments as note, junk refused), the
  board's send-back with and without comments, the composer's range
  logic, add/edit/delete and persistence, the send-back hand-over, the
  state's payload.
- **Not done:** dictation in the composer, drag-to-select ranges (a
  second tap does it), comments on removed lines.

### Milestone 117 — Mission Control diff review (E11-2)

**Not yet manually verified by the owner.** Owner request, 2026-11-03
(concept v2, design board "iPad: Review a file"; ADR-0088 E10 – E12).

- **Viewed marks.** Every file in the proof card's Changes list has a
  **Viewed** checkbox (44 pt target); the heading reads
  `Changes · 3 files · 1 of 3 viewed`. The mark is stored per device and
  ticket and keyed by the path plus a hash of its patch, so a file that
  changed after the owner looked reads as not viewed again.
- **Changes / Whole file.** An open file has a two-way switch. *Whole
  file* fetches the file as it stands on the ticket branch
  (`GET /api/tickets/<id>/file/<path>` → `git show HEAD:<path>`, 200 KB
  cap, repo-relative paths only) and lays the patch over it: the lines
  between and around the hunks become context, removed lines stay in
  place, hunk headers drop out. A long file says it is cut.
- **Change n of m.** Contiguous runs of added/removed lines are the
  changes; `Change 2 of 5` with previous/next buttons scrolls to the run
  and outlines it. Past the last (first) change of a file the neighbouring
  file opens at its first (last).
- **Specs added:** the whole-file overlay, the change runs, the viewed
  key, the viewed marks across a remount, the whole-file availability and
  loading state, change stepping across files, the safe-path rule, the
  file route.
- **Not done:** the board's wide master-detail layout and desk-side viewed
  marks (roadmap E11-2b); line comments are E11-3.

### Milestone 116 — Mission Control proof mode + videos (E11-1)

**Not yet manually verified by the owner.** Owner request, 2026-11-03
(concept v2 §5.3, decision D12; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)
E10 – E12). Supersedes E4's "video on failure only" rule.

- **Proof mode.** A ticket's proof is `ui` or `tests`
  (`core/proof-mode.ts`): the frontmatter pin `proof:` wins, then the
  builder's Handover line `proof: ui|tests — <reason>` (the last such
  line wins, so the reviewer's correction counts), else `ui`. The build
  prompt (version 4) asks for the line, the review prompt (version 2)
  confirms or corrects it. `TicketMeta.proof` carries the pin; an
  unknown word is a warning, not a pin.
- **Verify.** The harness starts the app only for `ui`: it records the
  walkthrough (always kept now, named
  `verify-<yyyyMMdd>-<HHmmss>-<ticket id>.webm`), at most six shots, and
  the report gets a `### Video` chapter with one `m:ss` chapter per shot.
  A `tests` proof starts nothing, records nothing and marks the criteria
  `checked by the machine gate`.
- **Videos.** `VideoService` owns `tickets/videos/`: the engine-written
  `.gitignore` (`*`, `!.gitignore`) while `videos.inGit` is off, removed
  when it is on (a hand-edited file is left alone); the size limit
  deletes the oldest videos of done tickets (terminal column, or a ticket
  no longer on the board) until the folder fits and swaps the player for
  `Video removed (size limit).`; with `inGit` on nothing is deleted and
  the settings screen shows "The limit no longer frees space." A limit
  that only unfinished tickets keep exceeded is reported too. The sweep
  runs at engine start, after each verify run and when the keys change.
  `GET /api/videos/<name>` is bearer-authenticated, name-pinned and
  answers `Range` (206/416).
- **Mission Control.** The proof card plays the video with chapter
  buttons that seek, shows the removal note, and hides the gallery and
  the player when a ticket carries none. The `videos.inGit` dialog offers
  "Include the n existing videos" (commits them; without the tick they
  stay untracked). The ticket diff card's two leftover German words
  ("Dateien", "gesamt") are English now.
- **Specs added:** proof resolution and declaration parsing, the pin in
  the ticket reader, the Video chapter round trip, harness tests mode and
  always-kept video, verify service ui/tests/pin paths, the video
  service (names, oldest-first pick, note swap, folder/ignore rule,
  sweep, inGit notice, existing-video commit), the Range parser and
  route, the proof reader's video block, the settings dialog tick and
  notice.
- **Not done:** see the roadmap's E11-1b — the 60-second cap, streaming
  in the phone client, a player in the Drey-hosted panel. Not run
  against a real Playwright/Electron session.

### Milestone 115 — Mission Control team states (E12-4)

**Not yet manually verified by the owner.** Owner request, 2026-11-03
(concept v2, design boards 5d and 6d; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)
E10 – E12; owner decision D8: the persona's Chat and 1:1 are one
conversation).

- **Team tab.** The header reads `4 personas · today $1.59`; money is
  written `$1.59` now (the German comma format is gone from this tab —
  the ticket view's cost slots follow with E11-4). Above the cards: the
  **capacity chips** (`Local 2/2`, `Claude Code 2/3` — running runs against
  the pool's effective size), **Pause all after this step** (the chain
  master halted; reads **Resume all** while halted) and **Stop all** (armed
  by a first press, then aborts every live run and halts the chain).
- **Cards.** Avatar, role · phases, a state word (`idle`, `running`,
  `2 running`, `paused`), the day's cost against the budget as a line and a
  bar in the persona's colour, then **one row per live run**: ticket title,
  age, the worker's activity line. A run the hang watchdog flagged
  (`RunInfo.stuck`) turns amber and says `No progress for 9 minutes and the
  context is filling up (78%).` (the context part from 60 % fill) with
  **Nudge** (a steering message to change course), **Hand to Claude Code**
  and **Stop**.
- **Engine.** `POST /api/runs/<id>/handoff` → `TicketsRemotePort.handoffRun`:
  stops the run, waits (≤ 30 s) until the runner lets go, then starts the
  ticket again with the worker pinned to `claude-code` and a fresh brief;
  refused for an unknown run, a run already on Claude Code, or a failed
  stop. `ChainStatus.poolSize` (the effective pool per provider) feeds
  the capacity chips. Nudge and Stop ride the existing `send` / `stop`
  routes, Pause all / Stop all the existing `chain/master` / `chain/abort`.
- **Persona detail.** Chat and 1:1 merged: three tabs — **1:1**
  (improvement drafts, the coaching thread and the composer in one pane,
  badge = open drafts), Memory, Setup.
- **Code.** `LiveRunView` / `CapacityView` in the wire DTOs, `runRowOf`,
  `stateWordsOf`, `budgetPctOf` in `team.ts`; `McState.nudgeRun` /
  `stopRun` / `handToClaude` / `stopAll` / `ticketTitleOf`.
- **Specs added:** run rows, state words, budget share, the controls, DTO
  live runs + capacity, McState run controls, engine hand-off (port +
  route), pool sizes in the orchestrator status, the merged tab.

**Not done:** the design's "Local · qwen3-coder" chip names the pool's
model; the chips carry the provider label only. Daily cost is the sum of
the personas' ledger figures — a cost for runs of no persona is not in
it.

Verified: typecheck, lint, cycles, `test:app` (1196 + 125 + 477),
`test:plugins` (3203 of 3204 — the CRLF `default-prompts.spec` artefact),
the language guard and the production build. Not run in a browser against
a desk.

### Milestone 114 — Mission Control settings (E12-3)

**Not yet manually verified by the owner.** Owner request, 2026-11-03
(concept v2, design boards 5f, 5g and 6c; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)
E10 – E12; owner decision D10: Appearance per device, everything else per
vault).

- **Appearance (per device, localStorage, applies at once).** Three
  themes — **Anthrazit** (the default; the first build's `anthracite`
  reads as it), **Drey** (terracotta) and **Cyberpunk** (violet-black,
  neon pink) — with the canvas' token values; a highlight colour (theme
  default, blue, teal, violet, pink, orange, yellow) overriding
  `--accent` while status colours stay fixed; text size S / M / L / XL /
  XXL (0.9 – 1.5×) with a live preview card — every `font-size` in the
  lib and the app multiplies `--mc-text`; **Compact lists** (tighter
  Work cards); **Reduce motion** (starts from the OS preference).
- **Screen.** A list of pages, then one page with a back button on the
  phone; the list left and the page right from 768 px. Pages: Appearance,
  Devices (paired devices, last seen, read-only mark, revoke with a
  second press, never the asking device) and Engine (Videos: *Keep
  videos in git* — turning it on opens the warning dialog with the
  specified text, turning it off is immediate — and the size limit in
  MB, committed when the field is left or on Enter; with the switch on
  the page says "The limit no longer frees space.").
- **Engine.** New routes behind the existing bearer auth:
  `GET /api/settings` (devices + `videos.inGit` / `videos.limitMb` + the
  count of videos in `tickets/videos/`), `POST /api/settings/engine`
  (`{inGit?, limitMb?, confirm?}`, 100 – 100000 MB, enabling `inGit`
  without `confirm: true` is refused), `POST /api/settings/devices/revoke`
  (`{id}`). A read-only device cannot write; a host without the settings
  half (the Drey plugin's gateway) answers 404 and the pages say so. The
  keys live in the engine config; **what they do** — the `.gitignore`, the
  limit sweep, the Range route — is E11-1.
- **Code.** `Theme` owns the five settings (`set`, `setAccent`,
  `setTextSize`, `setCompact`, `setReduceMotion`); `MC_SETTINGS_STATE`
  is the screen's per-vault slice, implemented by `McState`;
  `packages/tickets-engine/src/server/settings.ts` is the engine half.
  The toolbar theme toggle and the bottom-bar token (`--tabbar-h`) are gone.
- **Specs added:** theme (all five settings, fallbacks, OS motion
  default), Settings screen, McState settings calls, engine settings
  parsers + router + the remote service half.

**Left out, on the roadmap:** the Chat, Away and alerts, and Repositories
pages — none has a desk API or a setting behind it yet (away posture is
out of scope); "Include the n existing videos" in the confirmation
arrives with E11-1, when there are videos to commit.

Verified: typecheck, lint, cycles, `test:app` (1196 + 123 + 465),
`test:plugins` (3200 of 3201 — the CRLF `default-prompts.spec` artefact),
the language guard and the production build. Not run in a browser against
a desk; the text-size scale and Compact lists are CSS-only and unseen.

### Milestone 113 — Mission Control navigation (E12-2)

**Not yet manually verified by the owner.** Owner request, 2026-11-03
(concept v2, design boards 5a and 6a–6d; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)
E10 – E12). The bottom tab bar of E5b is gone.

- **Phone.** The chat is home (the app opens on it). Its menu button
  (three lines, top left) opens the **history panel**: search, New chat,
  the places Work (with the needs count), Team and Settings, then the
  sessions grouped Today / Yesterday / Earlier, the live one on top. Work,
  Team and Settings carry a menu button in a slim top bar that leads back
  to that panel. Sessions are still the `_meta/chat/` files; a session
  other than the live one opens read-only, as before.
- **From 768 px.** A top tab bar — Work (needs counter), Chat, Team,
  Settings. Work stays in column 1, the active detail in column 2.
  **From 1024 px** the right dock holds Chat | Capacity; the Chat tab
  folds and unfolds the dock (`aria-pressed`), and the chat's menu button
  opens the history list inside the dock (no places there). Between 768
  and 1023 px the Chat tab shows the chat in the center column.
- **New screens.** Settings (first cut: the theme switch that sat beside
  the tab bar; E12-3 fills it) and the dock's Capacity tab (the live
  worker count; E12-4 extends it).
- **Code.** `McTab` gains `settings`; `McState.chatMenu` is the one-shot
  that makes the chat open its history on mount (`McChatState.chatMenu`,
  optional); `historyGroupsOf` is the pure grouping/filter; the old
  bottom sessions sheet became the history panel (the attach sheet stays).
  Two German leftovers found on the way (`aktiv`, `Karten warten`) are
  translated and the language guard learned them.
- **Specs added:** `historyGroupsOf`, the menu request, Capacity.

Verified: typecheck, lint, cycles, `test:app` (1196 + 120 + 457), the
language guard, and `ng build mission-control --configuration production`.
Not run in a browser against a desk.

### Milestone 112 — Mission Control redesign, specs + English pass (E10–E12 groundwork, E12-1)

**Not yet manually verified by the owner.** Owner request, 2026-11-03
(outside the list; concept v2, owner decisions D5–D12;
[ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)
"Later changes", E10 – E12). The first stretch of the redesign:

- **Specs.** Roadmap: the E10 / E11 / E12 items in the owner's work
  order; req-75 W6 recut (E10-2 – E10-4), W7 and W8 dropped (D5).
  ADR-0088: decision 8 replaced, sections for E8, E9 and the redesign
  (navigation, settings, proof rule, videos, language, schema).
  `ticket-schema.md`: the reserved `tickets/videos/` folder with its
  engine-maintained `.gitignore`, `videos.inGit` / `videos.limitMb`,
  the Range-served `/api/videos/<name>`; Proof mode (`proof: ui|tests`,
  builder declares, review confirms, frontmatter pin, missing = `ui`);
  `### Parts`, `parent:` and the per-part `chain:` scope.
  `decisions.md`: what was dropped.
- **Pia → Paul (D7).** The planner persona is Paul; Pia is Mission
  Control. Doc comments, the chat prompt's `setChain` example
  (`insert security(ralf, notify) after review`) and the schema
  examples renamed; no engine default persona or prompt carried the
  name. Test fixtures that use `pia` as an opaque persona id stay.
  The concept text was recut in a copy (`Drey Tickets – Architekturkonzept v2.md`
  in the shared notes folder).
- **English pass (E12-1).** All German UI text in `libs/mission-ui`
  (chat, ticket view, team detail, work) translated, including the
  composer placeholder, toasts, aria-labels and the persona-chat
  intent patterns (`remember`, `rule|instruction`, `new ticket:`).
  `## Verlauf` and its `dauer` / `ausgang` keys are file format and
  stay; the box's visible heading reads "History".
- **Guard.** `shared/mission-ui-language.spec.ts` scans the lib's and
  the app's sources for `[äöüßÄÖÜ]` and a list of German UI words.

Verified: typecheck (nine configs), lint, import cycles, `test:app`
(1196 + 120 + 450), `test:plugins` (3194 of 3195 — the one failure,
`default-prompts.spec`, is a CRLF checkout artefact of the shipped
prompt files and predates this change). Not verified in the running app.

### Milestone 111 — configurable priorities + the blocked-by chat path

**Not yet manually verified by the owner.** *Backfilled by the convergence audit
(milestone 134) from commits `f73ff404` and `971a1a31`; the entry was not written
when the milestone shipped (2026-11-02).*

- `_meta/pipeline.md` gains a top-level `priorities:` — ids in weight order, the
  vault's own vocabulary; its middle entry is the default, its first half the
  dispatch's jump class. `urgent, high, normal, low` is exactly that split, so an
  unconfigured vault behaves as before. Unknown ids in tickets warn and read as
  the default; `createTicket` refuses an off-vocabulary priority.
- Board order, dispatch classes, chat digest and envelope validation, header edits
  read the vocabulary instead of a fixed list; the board's column order follows it.
- The chat's sixth intent `setBlockedBy` (whole-list replacement, an empty list
  clears the blockers) executes like `setChain`: no-op when unchanged, refusal on
  a live run, one header rewrite, one commit `tickets: <id> blocked-by <n ids|none>`.

### Milestone 110 — the chain delta (E9, concept §5.7)

**Not yet manually verified by the owner.** *Backfilled by the convergence audit
from commit `033520f3`.*

- The pipeline defines the standard flow; a ticket overrides it with a `chain:`
  frontmatter delta (`insert <phase>(<persona>, notify) after|before <anchor>`,
  `skip <phase>`, `notify <phase>`). Every write validates the delta against the
  pipeline and the ticket's position; a live run refuses like every header edit.
- Merge of flow + delta feeds the gate bar (a tappable bar opening the sheet with
  three interventions), the notify cards (fire when the following gate is
  entered, hide after the next or 24 h) and the chat's `setChain` command with a
  before/after proposal card. `specs/ticket-schema.md` "The chain delta".

### Milestone 109 — the Scout track (E8, concept §5.6)

**Not yet manually verified by the owner.** *Backfilled by the convergence audit
from commit `a96a3639`.*

- `form: scout` (absent = ship): a scout run has no worktree, branch, diff, gate
  or move; the worker writes only the `## Report` chapter (`### Summary`,
  `### Decisions`) into its own ticket file; the supervisor commits it at settle.
- The report waits as a `report` card in Needs you; the dispatcher holds a scout
  ticket whose report is written; the chat's `promote` command (proposal card,
  confirmation, `setForm` patch, one commit) turns it into a ship.

### Milestone 108 — the status log + fleet ledger surface (Mission-Control migration E7)

**Not yet manually verified by the owner.** Owner request, 2026-11-02
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E7 — the concept's §3.3: the machine keeps a ticket's status
and the fleet's events in machine-shaped files the UI reads as
projections, never free text). The status-log contract
(`packages/tickets-engine/src/core/status-log.ts`, a pure data form
since milestone 98) gains its writers and readers: one append-only
`tickets/<phase>/<id>.status.log` beside the ticket — ONE line per
event, `- '<ISO stamp>' <verb>: <payload>`, the verbs `working` /
`needs-decision` / `blocked` / `paused` / `done` / `failed` /
`resolved`; every `needs-decision` and `blocked` carries a
`[short-key]` so the owner can resolve it, and an open key stays open
until a `resolved: <key>` line closes it — the open-decisions fold:
newer lines never close a key implicitly, a keyless line is its own
item, surfaced visibly instead of dropped (strict writer, tolerant
reader — the ADR-0076 discipline; the log is append-only, an older
line is never rewritten). The fleet ledger (`core/ledger.ts`, also a
data form since 98) is the events' fast lane:
`tickets/_meta/ledger.jsonl`, one strict JSON line per event —
`dispatched` / `phase` / `proof_ready` / `merged` / `archived`
(`v: 1`, ts, ticket, persona, model, cost, from/to when known) — read
by Mission Control and the reports without parsing Markdown; it is
swept into git by the next regular commit rather than committed per
line. The writers ride optional seams, absent = silent no-op: the
runner side (an event-writer on the orchestrator's deps) writes
`dispatched` / `working` / `done` / `blocked` / `failed` for its runs,
the board side writes `phase` on every move and `merged` / `archived`
at the terminal transitions, the verify service writes `proof_ready`
with the run's settled cost — each append rides its writer's own
commit cadence. The Needs-you composition (`server/drey-port.ts`'s
`needs()` over `needsOf`) folds the status logs in: every open key
lifts one card of the two new kinds `'needs-decision'` / `'blocked'`
(`NeedKind` in `contracts/remote-protocol.ts`) onto the owner's list,
beside the question / permission / red-gate / checkpoint items, keyed
so the owner's answer lands as the ticket's `resolved:` line. The
workers' write path ships in the prompts — build, review and qa carry
the 'The status log is the owner's live view' paragraph asking for
the one-line-per-event discipline before the run ends (key every
needs-decision and blocked; append only your own lines). Specs:
`core/status-log.spec.ts` (4; the verb grammar, the keyed lines, the
open-decisions fold), `core/ledger.spec.ts` (4; the strict line, the
tolerant read, the cost rounding), the runner rows in
`fleet/orchestrator.spec.ts` (the event-writer: dispatch, settle,
blocked, failed), `services/board-service.spec.ts` (the
phase/merged/archived appends on the transition pipeline),
`services/verify-service.spec.ts` (`proof_ready` with the cost),
`server/drey-port.spec.ts` and the gateway's `server/router.spec.ts`
(the two new NeedKinds end to end), the app's `work.spec.ts` and
`api/dto.ts` (the new kinds' labels and parse), the prompts' shape
still asserted by `core/default-prompts.spec.ts` (LF,
newline-terminated, the working style in every prompt). Deliberate
scope cut: the status log and the ledger record, they do not yet
drive — no auto-action fires on an open key beyond the Needs-you
card, and the ledger's report surface waits for the reporting
milestone.

### Milestone 107 — the self-improvement loop (Mission-Control migration E6)

**Not yet manually verified by the owner.** Owner request, 2026-11-02
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E6 — the concept's §4.8: the personas improve themselves — the
friction a worker reports becomes proposal drafts the owner accepts or
dismisses, one armed 1:1 per persona). The loop's data shapes are pure
format in
`packages/tickets-engine/src/core/improvements.ts`: `parseFriction`
reads the worker's `friction.md` — one line per finding, `- <date> ·
<ticket id> · <what was missing>` — skipping unparseable lines, never
guessing; `validateDraft` vets the aggregator's output (`null` refuses
instead of guessing — unknown targets, empty or oversize content; at
most `MAX_IMPROVEMENT_EVIDENCE` = 10 evidence items and
`MAX_IMPROVEMENT_CONTENT` = 8 KiB of content); `renderImprovements` is
the strict writer and `parseImprovements` the tolerant reader of the
persona's `improvements.md` — an absent or broken file reads as empty,
ids come from `nextImprovementId` and are never reused. The aggregation
step is the `ImprovementsService`
(`packages/tickets-engine/src/services/improvements-service.ts`),
composed over a `PersonaImprovementsPort` the board service implements
on its single-writer queue: a sweep — once at start, then on every run
settle (`onRunsSettled`, wired to the fleet changes by the engine) —
aggregates a persona once its `friction.md` holds
`IMPROVEMENTS_THRESHOLD` = 3 findings; a repeat aggregation
additionally waits for 5 settled runs since the file's last
`- aggregate:` stamp. The LLM seam is the E5a chat bridge with a
per-turn system prompt — `AGGREGATOR_SYSTEM_PROMPT`, the same
OpenAI-compatible stream and the same honesty (an unconfigured model
says so, never a silent fallback); the turn's prompt carries the most
recent 20 friction lines plus the run-history digest, the reply must
parse as one JSON array of at most 3 drafts, each backed by the
friction evidence it rests on — never invented —, `validateDraft`
drops the malformed ones one by one, and the survivors hand to the
board port's `applyAggregation`, which owns the `improvements.md`
write — the consumed friction moves into the proposals' `evidence:`
blocks — in one commit. The board service
owns the owner's decision — the app routes the 1:1's buttons through
its service entries: Apply rewrites the proposal's target in exactly
one commit (`prompt.md` replaced by the draft's content, a
`models.default` patch through `patchHeaderFields` on `persona.md`'s
frontmatter, a `memory` lesson appended to `memory.md`), Dismiss
records the decision the same way; both stamp the proposal's state and
its `decided:` line, never rewriting a line already written. The
Needs-you group gains the kind `'improvements'`: a persona whose open
proposals reach the threshold raises one card pointing at the 1:1. The
workers' write path ships in the prompts — build, review and qa carry
the 'Friction is a gift' paragraph asking for one friction line before
the run ends (no persona in the brief: skip it). The app's persona
detail is that 1:1 (concept §4.8): the persona's facts on top, its open
proposals below as cards — target, title, evidence, the content's
beginning, the lesson when present — each with an armed two-step Apply
and Dismiss, the ticket screen's `acceptArmReduce` reducer reused.
Specs:
`packages/tickets-engine/src/core/improvements.spec.ts` (6; the
friction grammar, the strict writer / tolerant reader round-trip,
`validateDraft`'s refusals), the service rows —
`packages/tickets-engine/src/services/improvements-service.spec.ts`
(15; the sweep's trigger — the first aggregation at 3 waiting
findings, a repeat after 5 settled runs —, the JSON-array reply, the
per-draft validation drops, the one-commit hand-off) and
`packages/tickets-engine/src/services/board-service.spec.ts`
(`applyAggregation` and the owner's apply/dismiss entries), the device
row —
`packages/tickets-engine/src/server/router.spec.ts` (the persona
routes), the app's `work.spec.ts` (the `'improvements'` card) and the
persona detail's own spec under `apps/mission-control/src/app/team/`;
the prompts' paragraphs are asserted by
`packages/tickets-engine/src/core/default-prompts.spec.ts` (LF,
newline-terminated, the working style in every prompt). Deliberate
scope cut: the aggregator only proposes — evidence and caps keep every
draft phone-reviewable, and no target is ever rewritten without the
owner's confirm, exactly like the chat's proposal cards.

### Milestone 106 — the ticket screen + proof card + Drey hosting (Mission-Control migration E5c)

**Not yet manually verified by the owner.** Owner request, 2026-11-02
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E5c — the concept's §5.3/§5.5 on the device and §3.5.4 in Drey:
one ticket = one card, the read-only-first ticket screen, and the same
app hosted in a Drey window). The device API grows the ticket screen's
reads and the owner's checkpoint moves: `GET /api/tickets/<id>` carries
the ticket's full markdown with its `revision`; `GET
/api/tickets/<id>/diff` answers the branch against its base as `{files:
[{status, path, patch}], truncated}` — parsed on the engine by
`diffOfOutput` (the same core the desk uses,
`packages/tickets-engine/src/core/worktree-changes.ts`); `GET
/api/tickets/<id>/worktree-changes` lists the moving files; `POST
/api/tickets/<id>/save {text, baseRevision?}` is the raw edit's writer
— 409-less: a stale revision answers 200 `{ok: false, conflict: true}`
with the refine wording ('The ticket changed since you opened it.
Reload it and edit again.'), a text that no longer parses as a ticket
is refused with its issues, an accepted save is one commit on the desk;
`POST /api/tickets/<id>/accept` and `POST /api/tickets/<id>/send-back`
close the checkpoint — the send-back note is mandatory, an empty note
is a 200 refusal, never a silent move. `GET /api/attachments/<name>`
serves the proof shots' bytes bearer-authenticated, the name pinned to
`[A-Za-z0-9._-]+.(png|jpg|jpeg|webp|mp4|webm)` with no slashes, the
gateway's CSP widening only to `img-src 'self' data: blob:`. The ticket
screen (concept §5.5) is read-only first: the gate bar over the
pipeline's phases, the ticket body as safe Markdown (rendered, never
raw HTML), the `## Verification` section as the proof card (concept
§5.3 — the criteria checklist, the swipeable screenshot gallery, the
fullscreen shot viewer, findings), below it the diff as git rendered —
per file collapsible, the +/- balance, horizontally scrollable lines,
the per-file fullscreen zoom with stepped font size (`patchLineKind`
per line); the armed two-step Accept and the send-back with its
mandatory note sit in the actions row at the bottom, in the thumb's
reach (concept §7), and the raw edit mode is the exception path behind
a warning, its save conflict-checked. Drey hosts the same app (concept
§3.5.4): `RemoteService.localClient` registers the Drey window directly
as a device (no pairing dance) and answers `{ok, token, url}` — null
while the remote is off; the tickets plugin's main opens one sandboxed
window (`plugins/tickets/main/mission-control.ts` — the browser
plugin's view discipline minimised: own persisted partition, no
preload, sandbox + context isolation, http(s)-only top-level
navigation, off-window links to the OS browser) and loads
`${url}#token=${token}`; the Work panel's ⋯ menu gains the 'Mission
Control' row and a remote that is off answers honestly ('Enable remote
access in Settings → Tickets → Remote'). Specs:
`apps/mission-control/src/app/ticket/view.spec.ts` (33; the gate steps,
the section split, `proofOf`, the accept-arm reducer, the diff's font
steps and patch-line kinds, the component's render and moves),
`apps/mission-control/src/app/ticket/edit.spec.ts` (15; the conflict
wording, the refused save, the warning gate),
`apps/mission-control/src/app/ticket/markdown.spec.ts` (14; the safe
renderer), `plugins/tickets/main/mission-control.spec.ts` (11; focus
the living window, the honest remote-off answer, the failed-load
cleanup); the grown slices ship their own rows — the engine's
`server/router.spec.ts` (save/accept/send-back/diff/attachments
routes), `server/gateway.spec.ts` (the attachment bytes and the CSP),
`core/worktree-changes.spec.ts` (`diffOfOutput`),
`server/drey-port.spec.ts` (the board port's new ticket verbs), the
app's `api/client.spec.ts`, `api/dto.spec.ts`, `api/state.spec.ts`.
Deliberate scope cut: inherited from E4 — the proof card's judge stays
stubbed (the vision pass is its own milestone).

### Milestone 105 — the Mission Control app (Mission-Control migration E5b)

**Not yet manually verified by the owner.** Owner request, 2026-11-02
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E5b — the client half of the concept's §6/§7: `apps/mission-control`,
the Angular phone-first web app that renders the engine's surfaces on the
owner's devices; the 2026-11-02 owner decisions stand: the web UI stack is
Angular, the UI language is English). The app is a standalone Angular
project inside the repo workspace (`apps/mission-control`, prefix `mc`:
standalone components, OnPush + signals, external templates/styles, the
design tokens in its `styles.css`), built by its own
`ng build mission-control --configuration production` into
`dist/mission-control/browser`; the repo's build chain gains
`build:mission-control` (`npm run build` runs it after renderer,
electron and plugins), `test:app` runs drey's renderer suite then
mission-control's, lint and the typecheck cover the app's sources, and
`apps/` joins the cycles scan roots. The engine process serves the built
app from `dist/mission-control/browser` (engine-main) and keeps the
legacy remote as the fallback until the owner verifies — one more loop of
the strangler, not a cutover. The device API grows `GET /api/personas`
returning `PersonaView` (`{id,title,role,worker,model,pool,color}` —
personas as the wire DTO, never tickets). The shell (concept §7) is
phone-first, one column: the bottom tab bar holds Work left, the raised
Chat middle (the regular intervention) and Team right; tablet/desktop
widen the same views instead of replacing them. The Team tab renders the
personas of concept §4.3 — one card per persona (initials avatar on the
persona colour, role, the worker/model line, the live run chip: `on T-…`
state-coloured — running accent, failed danger, waiting dim — `idle`
otherwise), with a dim settings hint when the pool is empty; the cards
are read-only and the run chip links nowhere yet (E5c opens the ticket
screen). The Work tab renders the board as card groups (needs-you,
running, ideas); the Chat tab renders the E5a sessions with their
proposal cards, confirm executes through the board. Specs:
`apps/mission-control/src/app/team/team.spec.ts` (11) for the persona
helpers (initials, run-state colour); the work/chat/api slices ship
their own specs under `apps/mission-control/src/app/`. Deliberate scope
cut: E5b ships the phone shell and the tabs' first live slice over the
gateway — the ticket screen (proof/diff, the Drey webview) is E5c,
persona pause/config waits for the persona detail, and the run chips are
labels, not links.

### Milestone 104 — the Mission Control chat engine (Mission-Control migration E5a)

**Not yet manually verified by the owner.** Owner request, 2026-11-02
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E5a — the engine half of the concept's §6 central chat; the
Angular mission-control app that renders it is E5b, under the owner's
2026-11-02 decisions: the web UI stack is Angular, the UI language is
English). The iron rule holds: the chat never writes on its own —
every mutation is a typed command wrapped in a proposal card, executed
only on the owner's explicit confirm, through the same board methods
the invoke channel exposes, never a second write path. The contract
(`packages/tickets-engine/src/contracts/chat.ts`) names the shapes:
`ChatMessage` / `ChatSession` (one session = one file under
`tickets/_meta/chat/`), `ChatProposal` — pending → confirmed/dismissed,
append-only history, a decision adds a line, never rewrites one — with
its `ChatCommand` union (`createTicket` / `transition` / `setPriority`:
the chat's entire write surface, growing only with the intents),
`ChatStreamEvent` (the streaming unit the UI renders: thought dim, then
text, then the cards), `ChatServicePort` (the invoke channel and the
paired-device gateway share it) and `ChatBridge` — the LLM seam: the
bridge owns provider speak, the service owns persistence and execution,
the bridge never touches the vault. The session file
(`core/chat-session.ts`, the canonical grammar now in
`specs/ticket-schema.md`) is a strict-written, tolerant-read vault file,
openable in Drey's editor; the mission answers a turn with one strict
JSON envelope (`say` / `thought` / `commands`), read by
`core/chat-intents.ts` with hand-rolled shape checks — no schema
library; a command that fails validation drops out visibly, and a reply
holding no JSON at all gets an honest fallback answer, never a guessed
write. The chat service mirrors the verify service's discipline —
injected deps, one turn in flight per session, the `TicketsGit` locate +
`commitPaths` helper, exactly one commit per turn (`tickets: chat
<file>`), `announce` like every board write. A confirm re-validates the
pending command and executes it through the board service — the same
methods the Work panel's buttons call — then records the outcome on the
decision line's ` → …` tail; a dismiss just records. The bridge
(`src/services/chat-llm.ts`) is a direct OpenAI-compatible
chat-completions call over the engine config keys `chat.baseUrl` /
`chat.apiKey` / `chat.model`, which the plugin syncs from Drey's
assistant settings (`llm.baseUrl` / `llm.apiKey` / `llm.model`) at
activation like the other engine keys; an unconfigured chat answers
honestly that no model is set — never a silent fallback. The engine's
invoke allowlist gains `chatSessions` / `chatOpen` / `chatSend` /
`chatStart` / `chatConfirm` / `chatDismiss`, the SSE hub's additive
`'chat'` change kind rides beside board/fleet/remote, and the gateway
grows the chat routes for paired devices over the same port — the phone
chats under the board's writer rules. Specs:
`core/chat-session.spec.ts` (7), `core/chat-intents.spec.ts` (6),
`services/chat-service.spec.ts`, `services/chat-llm.spec.ts`, the
engine acceptance spec's chat rows (`server/engine.spec.ts`), the
gateway router's (`server/router.spec.ts`). Deliberate scope cut: E5a
ships the engine half — sessions, the turn loop, proposal cards and the
confirm path, the bridge, invoke + SSE + gateway routes; the Angular
mission-control app is E5b, the wider intents (configure, dispatch)
wait for E5c/E6.

### Milestone 103 — verify/proof (Mission-Control migration E4)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E4). The verification step exists: a ticket's proof is the app
run, not a worker's say-so — the verify step is a machine step, not an
agent run (a harness run → screenshots + the ticket's `## Verification`
section → one commit → the ticket on the owner's checkpoint). The
contract (`packages/tickets-engine/src/contracts/verify.ts`) names the
shapes: `VerificationReport` (the persisted proof), `VerifyHarness` /
`VerifyRunInput` / `VerifyRunResult` (the harness seam), `VerifyStatus`
(the proof card's live state) and `VerifyJudge` — the judge seam, E4
stubbed: a run without a judge counts a captured screenshot as its
criterion's pass, and the section's Findings carry the caveats until the
vision pass lands. `MAX_VERIFY_SHOTS` is 6 — the phone's proof card
shows them inline, beyond six the owner stops looking. The ticket gains
a `## Verification` section (`packages/tickets-engine/src/core/verification.ts`
+ spec; the canonical shape in `specs/ticket-schema.md`): the verify
service replaces it after every run — the stamp line (`Tested on … by
verify@<host> — <build and platform>`), `### Criteria` with one
`- [x]` / `- [ ]` checkbox per acceptance criterion (the backticked
command exactly as written under `### Acceptance criteria`, the
screenshot proof as `→ ![](../attachments/<name>)`, a note where one
exists) and `### Findings` (Auffälligkeiten, omitted when empty); the
writer is strict, the proof card's reader forgiving — an absent or
half-readable section means "not verified yet", never a guess. The
harness (`packages/tickets-engine/src/server/verify-harness.ts`) is the
Playwright Electron driver: it launches the ticket worktree's built app
(repos.md `launch:`, else the `dev.ps1 -Built -Multi` convention), walks
the criteria headless and captures the proof screenshots into the
vault's `tickets/attachments/` under `verify-…` names — the phone's
`img-…` stays untouched — with a failure recording beside them;
`packages/tickets-engine/src/server/web-harness.ts` is the same contract
over a web build, the skeleton the web app's proof (E5) grows from. The
verify service resolves the ticket's worktree and launch command (the
board service's `launchVersion` resolution), runs the harness, persists
the report and the screenshots in one commit (the `TicketsGit` locate +
`commitPaths` discipline, as the orchestrator's commit step), then moves
the ticket to the owner's checkpoint phase; it auto-scans the pipeline's
configured verify phase, so a ticket that lands there is proven without
a hand on it. `verifyTicket` and `verifyStatus` ride the engine's invoke
allowlist — the proof card's trigger and live state. The judge's shipped
prompt lands with the step (`packages/tickets-engine/prompts/qa-default.md`):
walk the ticket's acceptance criteria, compare each against its captured
screenshot, verdict `passed` / `failed` with a one-line note, findings in
the owner's language. Deliberate scope cut: the judge itself is not
wired — E4 ships the harness, the section contract, the service and the
seam; the vision pass that fills the seam is its own milestone.

### Milestone 102 — personas (Mission-Control migration E3)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E3). A named agent is role + behaviour + model + memory in one:
personas live in the tickets repo as `tickets/_meta/personas/<id>/`
(`persona.md` frontmatter + `prompt.md` + `memory.md`, optional
`avatar.png`), fully specified in
`specs/ticket-schema.md`. The three-level resolution
ladder — ticket `persona:` pin > phase `persona:` in `pipeline.md` >
engine config `personas.default` — resolves at dispatch before the legacy
assignment ring: a resolved persona feeds worker and model (a router only
climbs inside the persona's pool) and its `prompt.md` becomes the run's
instruction base instead of the phase handover prompt; when nothing
resolves, or the persona file is missing, the ring runs unchanged, so
unmigrated boards behave byte-identically. Every run stamps
`RunInfo.persona`, and the token report gains the per-persona cost
grouping (`personaCostReport`) — tokens in/out/cache, run count and cost
per persona, `unassigned` for persona-less runs. Memory has two append
paths, both capped at 200 lines dropping the oldest: the fleet appends
one outcome line to the persona's `memory.md` when a persona run settles
(a write failure is logged and never fails the settle), and the board
service's `personaLearn` is the confirmed single-entry write (one commit
`personas: <id> memory +1`, unknown persona ids refused); the run brief's
context pack carries the persona's memory slice (the last ~20 lines /
~500 tokens under a `## Memory` heading — no section at all when the file
is absent, so persona-less instructions stay byte-identical). The board
service also lists the personas (`listPersonas`) and migrates the legacy
column `worker:`/`model:`/`prompt:` keys onto generated personas
idempotently — one commit `tickets: personas migrated`; both methods ride
the engine's invoke allowlist. Deliberate scope cut: the chat-ingestion UI
and the Team view are E5 — E3 lands the data model, the resolution, the
memory paths and the cost attribution.

### Milestone 101 — the standalone tickets engine (Mission-Control migration E2b-2)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E2b part 2 of 2 — the flip). The tickets engine is now a process:
`packages/tickets-engine/src/server/engine.ts` composes the host-agnostic
board service, the fleet client and the remote gateway over one tickets
vault on disk (`FsEngineHost`, plain fs with the same vault-relative
containment discipline; `FileConfigStore` in `~/.drey-engine/config.json`).
The channel is one loopback listener: `POST /api/invoke` against an
explicit method allowlist (board/fleet/remote/config), bearer-token only
(generated once, persisted), plus `/api/events` SSE and `/api/health` —
always on, independent of the phone remote's enabled flag.
`engine-main.js --vault <path>` is the CLI entry (lockfile with
pid/port/token in the engine home). The Drey plugin adopts a live engine
through the lockfile or spawns one (`ELECTRON_RUN_AS_NODE`, the runner's
own pattern) and proxies the whole service surface through
`EngineClient` — the ~50 IPC handlers, the renderer's events and the MCP
tools read exactly as before, because the proxies forward by method name
and the IPC channel names are untouched. Drey's config keys the engine
reads (git path, worker, caps, pools, handover thresholds, remote
settings incl. paired devices) sync into the engine config on every
activation. The phone pairs with the same engine through the gateway
whether Drey runs or not — the single writer holds either way. The
engine acceptance spec boots the real composition against a temp vault
over HTTP: snapshot, create/transition with the one-commit discipline,
config round-trip, auth refusal, SSE events. Wrinkles, owner-visible:
remote settings and paired devices now live in the engine home (synced
from Drey config at activation; the fleet run history moves to
`~/.drey-engine/fleet` — a runner started under Drey is not adopted, a
fresh one spawns); per-worker handover overrides that were never in the
synced key list fall back to defaults. E2e impact: the plugin now spawns
the engine in app runs — the built-app e2e round is part of the owner's
verification.

### Milestone 100 — the gateway and the fleet client move into the engine (E2b-1)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E2b part 1 of 2 — structural, no behaviour change). The remote
gateway (`gateway`, `router`, `auth`, `config`, `service`, `drey-port`,
`needs`, `qr`, `fallback-client`) and the `FleetClient` move from the
plugin into the engine (`packages/tickets-engine/src/server/` and
`src/services/`); the remote protocol becomes an engine contract
(`src/contracts/remote-protocol.ts`, with the reply shapes alongside and
a re-export shim in `plugins/tickets/shared/` — every existing import
path keeps working). Both were already host-shaped: `RemoteService` takes
its config/port/log as injected deps, the `FleetClient` its root, runner
entry and listeners — the moves are pure path surgery, all 2743 specs
pass unmodified. This is the server half the standalone engine process
(E2b-2) boots: one HTTP+SSE surface, one pairing/device store, one
writer. Known-unrelated: `runs.spec.ts > a red gate fails the run…` is
load-flaky (fails intermittently under full-suite timing, green in
isolation, reproducible on the pre-migration tree) — flagged, not fixed
here.

### Milestone 99 — host-agnostic service layer (Mission-Control migration E2a)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E2a). The board service — the whole mutation surface (capture,
transitions via the one machine, archive/claims, runs, worktrees,
settings, phases, projects, initialize) — moves into the engine as
`packages/tickets-engine/src/services/board-service.ts` (`EngineBoardService`),
host-agnostic: every IO arrives injected through `services/host.ts`
(`EngineHost`: vault read/write/list/resolve/announce/markManaged,
config get/set, the debounced board-changed, log, the native folder
picker/shell reveal/console launcher; `FleetPort`: runs/start/configureChain).
The acting owner (`owner@host`) is injected, not derived. The plugin keeps
a thin `BoardService` subclass (same constructor activate() has always
built) over `DreyEngineHost` (the plugin context) and `FleetClientPort` —
the IPC handlers, the remote gateway, the MCP tools and the renderer are
untouched. Pure helpers move with their consumers: `ticket-refine`,
`worktree-changes`, `worktree-removal` to `core/`, `repos-scan` and the
handover-config readers to `services/`; `changes` and the remote reply
shapes move to `contracts/` (the plugin keeps re-export shims, so every
existing import path works). Behaviour is unchanged — all 2743
plugin/engine specs and the 1196 renderer specs pass unmodified. This is
the seam the standalone engine process (E2b) implements over plain fs:
phone without Drey.

### Milestone 98 — one transition machine + status log + fleet ledger (E1)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list; [ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md),
etappe E1 of the Mission-Control migration). The five move variants of the
board service (`moveCard`, `archiveCard`, `unarchive`, `treatDrift`,
`acceptTicket`) shared one copied pipeline — patch → rename → commit →
push → announce; `acceptTicket` stays a dispatcher by nature (terminal
phase archives, anything else moves). The pipeline now lives once in
`packages/tickets-engine/src/core/transition.ts` as `runTransition`: pure
domain with all IO injected (`TransitionIo` — read/write, the mkdir+rename
with the verbatim `ticket path escapes the vault` wording, the
warning-level commit/push, the closing vault-round + board-changed
announcement). The board service builds a `TransitionSpec` per move kind
and runs it through a host adapter; every historical error surface is
preserved (propagating read failures, the unarchive wording, the
normalize log line, warning joining). Nine new machine specs cover the
pipeline with fakes. Two pure data forms land alongside, parsers and
writers with specs, no consumers yet (E3/E5): `core/status-log.ts` — the
per-ticket append-only `<ticket>.status.log` with the verb grammar
(`working` / `blocked` / `needs-decision` / `paused` / `done` / `failed`
/ `resolved`), the `[key=slug]` marker convention and the open-decisions
fold (a key stays open until `resolved`, no matter what piles on top);
`core/ledger.ts` — the append-only `_meta/ledger.jsonl` fleet events
(`dispatched` / `phase` / `proof_ready` / `merged` / `archived`) with ts,
ticket, persona, model and optional cost — the realtime hook for Mission
Control and the reporting intent, no Markdown parsing. Gate green; the
board service shrinks by ~60 lines net, the service split itself is E2.

### Milestone 97 — tickets-engine package cut (Mission-Control migration E0)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list; the migration plan was approved by the owner,
[ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)).
The strangler restructure of the tickets system begins: the root becomes an
npm workspace and `packages/tickets-engine` (`@drey/tickets-engine`) takes
the tickets domain (`src/core`: ticket parse/patch, board assembly, phase
dirs, drift, blocked-by, git plumbing, command parsers, shipped prompts),
the whole fleet runner (`src/fleet`: runner, orchestrator, providers,
worktrees, telemetry) and the cross-layer contracts (`src/contracts`:
board snapshot types, question shape, fleet defaults, capture tidy) — no
behaviour change, every moved spec passes unmodified (218 files / 2718
tests green, renderer suite 1196 green). The plugin keeps the BoardService
wiring, the remote gateway and all UI, reaching the engine by relative
import; renderer and phone client keep their paths through thin re-export
shims in `plugins/tickets/shared/`. One compile program stays (the plugin
main tsc, rootDir = repo root) emitting `dist-electron/packages/tickets-engine/`,
so electron-builder ships the engine through its existing globs (`pack:dir`
verified). ESLint enforces the package boundary (packages never import
`src/`, `electron/`, `plugins/`, `apps/`); the `NO_RENDERER` glob gains a
`!**/packages/**` negation. The bundled runner entry moves behind the
engine's `RUNNER_SCRIPT_PATH`; the shipped prompts move to
`packages/tickets-engine/prompts` (build copies them next to the compiled
engine). Roadmap: the migration item holds E1–E6 (transition machine, the
standalone engine process + web app, personas, verify/proof, mission
control + chat, self-improvement) and supersedes req-75 W6–W8. Specs/docs:
ADR-0088, CLAUDE.md ownership map, docs/05 paths, `plugins/tickets/FLEET.md`
paths. E2 will add the engine's own HTTP/SSE server; until then the runtime
shape is unchanged.

### req-94 — CI green again: the e2e suite runs, and is typechecked

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list). CI had been red since 2026-10-31: the W4a merge
(591be22) resolved `e2e/work-panel.spec.ts` badly — both sides' lines
survived, leaving a duplicate `thread` binding and a `runTab` that no
longer existed; Playwright refused to load the file, and no step before
e2e ever looked at the folder (the whole Work-panel e2e set had never
run: the last green CI predates milestone 89). The spec now states the
shipped behaviour — req-84 (a Work row opens the thread alone, only the
row menu's Open ticket opens the file + thread pair), W4a's worker
header (state word, no run link, Pause only while a turn runs), the
composer's quick-prompt chips above the box, the footer's
"1 running · 1 need attention · OpenCode 2" wording, Needs you and
Shaping in the group order, the Idle filter keeping a triage idea —
and `ticket-header.spec.ts` / `interactive-dialog.spec.ts` walk the
owner's path (row → thread → its Ticket file link). The assistant-tools
mock now speaks SSE: the providers stream their tool rounds since the
fleet-stability wave (milestones 95/96, `stream: true` + the shared
chunk sink), and the scripted endpoint still answered plain JSON, so
every tool-loop ask died on "The endpoint returned no message content" —
the mock answers `data:` frames when the request asks to stream (ten
tests that each burned their 30 s timeout now pass in two). The board
issues chip assertion drops its "one line with the title" geometry: the
panel head has wrapped its controls since T-0086, so containment in the
header is the claim that holds. The first green run of the fold
assertion caught a real bug: the Ready card's Report chip
folded nothing — `.tickets-ready-body-host`'s `display: flex` defeated
the `hidden` attribute; `board.css` gains the `[hidden]` guard its
siblings already had. Guard against recurrence: **the e2e project is
typechecked** (`tsconfig.e2e.json`, the seventh config in
`npm run typecheck` and a CI step of its own — a duplicate binding or a
gone name is now a compile error before anything builds, not a failed
run three minutes in); the fixture re-exports the Playwright types the
specs import from it, and `e2e/drey-api.d.ts` is widened to the members
the tests touch (`getConfig`, the spelling calls, plugin
install/uninstall). Specs: `e2e/work-panel.spec.ts`,
`e2e/ticket-header.spec.ts`, `e2e/interactive-dialog.spec.ts`,
`e2e/assistant-tools.spec.ts`, `e2e/board-issues.spec.ts`,
`e2e/fixtures/drey.ts`, `e2e/drey-api.d.ts`, type annotations across
the e2e specs the new project sees, `tsconfig.e2e.json`,
`package.json`, `.github/workflows/ci.yml`,
`plugins/tickets/renderer/board.css`.

### req-93 — just-in-time planning: the plan columns leave the pipeline

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list). The detailed up-front plan aged faster than it
paid: a plan written when the ticket was captured sat in the queue for
a day while other tickets merged, and the build worker met stale line
numbers (T-0062 stopped over a req-74 that main had shipped meanwhile)
or re-derived the touching points anyway. The shipped default pipeline
is now **inbox → prioritized → build → commit → done** — the plan and
plan-review columns are gone (a vault that wants them configures them;
the schema and the checkpoint mechanism are unchanged). **Prioritized
is the planning column:** clarify the task, its decisions and its
acceptance criteria there (the shape dialog or the owner's hand) —
what ages slowly. The **build step derives file-level detail itself**
(`build-default` prompt v3): it orients first — symbols and files
verified against the checkout it actually works in, never line numbers
— writes a lean working plan into `## Plan` when the ticket carries
none, and treats a plan's file references as hints to verify, not
facts. The shape dialog (`plan-interactive-default` v2) asks the 2–4
questions that matter (goal, scope, constraints, verification) and
writes goal/decisions/constraints/acceptance criteria instead of a
file map. Acceptance criteria remain the contract: the fleet still
refuses to start a run on a ticket without backticked criteria.
Also: the chain daemon now **drops control state of phases the
pipeline no longer has** (`prunePhaseState` — a removed column's
held/streak/cooldown keys rode along in `chain.json` forever; the old
`review` column's leftovers clear on the next pass). Specs:
`orchestrator.spec.ts` (stale-phase prune), `specs/ticket-schema.md`
(default pipeline, plan section, validation 9), ADR-0076/0077
amendments, `docs/agents/fleet-worker.md`, the manual's checkpoint
paragraph. The owner's tickets vault reorders its `pipeline.md` in the
same step.

### req-92 — A step the worker cannot complete stays put (BLOCKED)

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list). Two tickets landed on `done` merged and pushed
nothing (T-0062, T-0071): their commit step had ended blocked on a
merge conflict, but any finished turn counted as the agent's done
declaration, and the green machine gate over the branch moved the
ticket regardless — the worker's own report was never heard. Now a
worker can declare a step incomplete: a final message ending with
`BLOCKED: <reason>` (parsed exactly like `QUESTION:`, line-start
markers, the last one wins, a question still wins over it) ends the
run **without** a gate and **without** a move; the reason rides the
record (`blocked` in `run.json` and `/status`), the stream notes it,
and the chain holds the ticket like an owner-stopped run until the
owner moves or starts it — the dispatcher logs
`dispatch holds <id>: its last run ended stopped or blocked`. The
completion discipline in every brief names the marker, and the
shipped `commit-default` prompt (v3) now has the commit worker
**resolve merge conflicts itself** — mechanical ones (both sides add
changelog/list entries: keep both, newest first) always, code
conflicts only when confident and gated green in the merge worktree
before the push — ending `BLOCKED:` only when a conflict is genuinely
semantic or the repo is protected. The two stranded tickets were
moved back to commit by hand; their re-runs then merged (conflict
self-resolved), pushed and completed the step for real. Specs:
`runs.spec.ts`, `providers.spec.ts` (`blockedOf`), `orchestrator.spec.ts`.

### req-86 — the step card follows the pipeline; add, rename and remove columns; Settings tidied

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list). Three things the owner met on T-0062:

**The card follows the ticket's place, not a section.** The Ready card
showed whenever the ticket file carried a `## Changes` section, so it sat
on a Done ticket after the merge, with the worktree gone. `stepCardOf`
(`shared/step-card.ts`) now decides: a **gate** (a manual column behind
an automatic one) shows the card with what the step did and the gate's
moves — **Launch this version** only when a worktree and a launch
command exist (`ChangesReply.launchable`), **Move to <next column>**
(the column's name, no longer "Accept and merge"), **Send back…**; the
**terminal column** shows a **final report** — led by **What was
delivered**, the new `## Result` section the commit step writes (merge
commit, what landed, anything left over; commit prompt version 3) — with
**Archive** as its only button; a ticket an agent is working shows no
card. The plan gate keeps its own approval UI.

**Foldable and resizable.** A strip above the card (fold chevron, ticket,
state) stays; folding hides the body and brings the buttons into the
strip, so the agent log gets the whole height and the gate is still
decidable. A splitter below the body sets its height (drag, ↑/↓ keys,
double-click resets), remembered across sessions
(`localStorage['drey.tickets.readyHeight']`). The story column no longer
takes 320 px of height when the pane is narrow.

**Columns can be added, renamed and removed** (Settings → Tickets →
Pipeline). *New column* adds a manual checkpoint after a chosen column
(default: before Done); the pencil renames in place — the title only, so
id, folder and tickets stay; the bin removes a column after a second
click and refuses while tickets sit in it. Inbox and Done stay pinned.
One commit each (`editPhase`; `addPipelinePhase` /
`renamePipelinePhase` / `removePipelinePhase` in `ticket-board.ts`, which
keep a hand-formatted `pipeline.md` intact).

**Settings tidied.** Every unset fleet field shows the value the runner
will use as its placeholder, from one table (`shared/fleet-defaults.ts`;
`protocol.ts`'s `DEFAULT_*` derive from it) — a deviation from "panel
fields carry no placeholder" (ADR-0057), limited to Settings; clearing a
field resets it. The four output caps and the shared compact threshold
left the page (the keys still work by hand, defaults unchanged); resume
pause TTL, context cap and git path moved under **Advanced**, as did the
repository fields policy, worktrees base, launch command, agent
instructions and link folders.

Specs: `shared/step-card.spec.ts` (gate / final / none matrix),
`renderer/ready-view.spec.ts` (gate, final, fold strip),
`renderer/settings-columns.spec.ts` (the column editor — it caught a
use-before-declaration), `main/ticket-board.spec.ts` (add / rename /
remove), `shared/fleet-defaults.spec.ts`, `main/default-prompts.spec.ts`.
⚠️ Not run in the author's sandbox: the full `npm run test:all`, lint,
the Electron build and the UI itself (seven fleet specs on Windows paths
fail there on `main` as well).

### req-75 W5c — Tidy up a captured idea

**Not yet manually verified by the owner.** Part 3 of req-75 W5: a
**Tidy up** button in the New ticket dialog's Description label row
(sparkles, right of the mic) makes one model call that turns the
dictated or hastily typed idea into a title and a description — on
demand, never an automatic rewrite: the owner sees the result in the
fields before creating and can edit or ignore it. The prompt lives in
the plugin (`plugins/tickets/shared/capture-tidy.ts`, classifier-spec
Prompt 4); the call runs main-side (the `'tidyCapture'` IPC →
`ctx.llm.chat`, `temperature: 0.2`, gated on the master switch, no
timeout — ADR-0014, the button stays disabled while it runs). The
reply is one JSON object through `parseJsonObject` — a title trimmed
to 80 characters, a description with an empty one falling back to the
raw text; an unreadable reply leaves the fields and shows the hint
"The model's reply could not be read — the text is unchanged." The
owner's original words (the first successful run's input, whitespace
folded, cut at 2000) ride the create as a second Log line
`raw capture: …` right after `created in` — a misheard dictation is
always recoverable; a hand-typed ticket gets no such line and the
canonical file stays byte-identical. Specs: `capture-tidy.spec.ts`,
`ticket-files.spec.ts`, `commands.spec.ts`.

### req-75 W5b — Dictation in the New ticket dialog

**Not yet manually verified by the owner.** Part 2 of req-75 W5: the
New ticket dialog starts Windows dictation — the OS's own, Drey still
runs no speech recognition (req-11 stays excluded). Opened by the
system-wide New ticket chord (W5a) the dialog opens on Description and
the Win+H press happens by itself: the plugin's main side starts
PowerShell with `-EncodedCommand` (base64 of UTF-16LE, so the script's
double quotes survive argument quoting) whose script presses and
releases the keys through user32 `keybd_event`. Off Windows, or on a
failed start, the press refuses and the dialog shows one hint line —
"Dictation did not start — press Win+H, or type." — under the field,
cleared by the next successful start; typing is always the fallback.
On Windows the Description label row carries a **mic button** that
restarts the press. A ticket may now be created from a description
alone: its first non-empty line, trimmed and cut at 80 characters on
a word boundary with an ellipsis, becomes the title
(`titleFromDescription` in the shared contract; `parseCreate` derives
it — both empty still refuses). Specs: `dictation.spec.ts` (`execFile`
injected — a spec never starts PowerShell), `tickets.spec.ts`
(derivation), `commands.spec.ts` (create).

### req-75 W5a — New ticket from anywhere

**Not yet manually verified by the owner.** A second system-wide chord,
**Ctrl+Alt+T**, raises Drey from anywhere in Windows, reveals the
tickets board and opens the existing New ticket dialog with the cursor
in its Title field; with no tickets vault the reveal is all that
happens (the board shows its setup state). Built as a generic SDK seam
(1.37): a plugin command may be `global` — the base registers its chord
with the OS and never also fires it in-window, so it runs exactly once.
Settings → Keyboard shortcuts shows the row "New ticket (system-wide)",
rebindable like every other row, with the quick-capture row's "in use"
hint when another program owns the combo. Main's `GlobalShortcuts`
(modelled on the quick-capture hotkey, ADR-0073; the raise is the
quick-capture call, ADR-0002) registers exactly the renderer's list,
keeps the quick-capture accelerator reserved and reports failures
instead of throwing. Specs: `electron/global-shortcuts.spec.ts`,
`keybinding.service.spec.ts` (global commands leave the in-window
keymap), `shortcut-model.spec.ts` (the row label).

### req-75 W4d — The squirrel

**Not yet manually verified by the owner.** Owner request, 2026-10-31
(outside the list). The worker's pulse is now a small squirrel, where
the `✻` glyph and the plain dots stood: in the thread's progress line
(the `Thinking… 12s · ↓ tokens` line), in the Running rows of the Work
panel and on the Workers cards. While the worker works it **runs**
(bobbing, tail wagging, in the accent colour); when output streams fast
— the last activity less than 4 s ago — it **sprints** (twice as fast,
leaning forward, two speed lines); when there is nothing to do (no run,
idle, ended, waiting on the owner) it **sits** (still, muted). One pose
rule over the fields every run already carries
(`squirrel.ts`: `squirrelPose`), one inline SVG built with the SVG DOM;
all movement is CSS on `data-pose`, `transform` and `opacity` only, and
`prefers-reduced-motion` draws the poses still. The squirrel carries
`role="img"` with the pose as its aria-label (Worker running /
sprinting / idle). Specs: `squirrel.spec.ts`.

### req-75 W4c — Queue messages for a busy worker

**Not yet manually verified by the owner.** Owner request, 2026-10-31
(outside the list). While a worker is in the middle of a turn, what the
owner sends no longer cuts into it: Enter and the send button (now
reading **Queue**) put the message in a queue above the prompt box,
attachments riding with it, one row per message — click to edit inline,
× to remove. When the turn ends the first queued message is sent by
itself, the next at the following idle — one per idle turn, and never
while the worker waits on the owner (the owner answers first).
**Send now** beside the button, or Ctrl+Enter, keeps today's behaviour:
interrupt the turn, then send. The queue lives per run in the renderer
and is mirrored to localStorage, so a reload (or a closed Drey) keeps
it; a run that ends with messages still queued drops them with a notice
and a Copy button. Pure model: `message-queue.ts` with specs; wired in
`run-composer.ts`.

### req-85 — the Work rows lead with the ticket id

Owner request, 2026-11-01
(outside the list). The Work panel's rows showed only the title; the
board's stable handle lived in the tooltip alone. Every row — Needs
you, Shaping, Running, Ideas, Done this week — now leads with a muted
`work-row-id` span before the title; a Done row without a title shows
the id alone instead of doubling it as the title. Specs: the id-lead
assertions in `work-panel.spec.ts`.

### req-84 — explicit entry points: the ticket pair is no longer automatic

**Not yet manually verified by the owner.** Owner request, 2026-11-01
(outside the list). Pairing file and thread across panes proved
unreliable: landing follows the focused pane, so a normal note opened
later sat beside or inside the thread. Removed req-83's follow-the-active-tab
(`followActiveTicket`, `pageFollowsActive`, `boardCardByPath`). Now: a
**Work row** (also a Workers card, a wait notification, a Past-runs row,
the one-click dialog) opens the **thread alone** through the new
`openTicketThread` — one tab following the ticket, opened where the focus
is, no split, no anchor; the **Files panel** opens the plain file; the
ticket menu's **Open ticket** keeps the pair (`openTicketPage`, req-82's
pane reuse stays). Recorded in `specs/decisions.md`, ADR-0087 decision 3,
the manual's Work panel section.

### req-83 — a ticket opened from the Files panel brings its thread (removed again by req-84)

**Not yet manually verified by the owner.** Owner request, 2026-10-31
(outside the list). The ticket page (file + thread) opened only from the
Work panel; a ticket file picked in the Files panel (or any other route)
was a plain tab. The tickets plugin now watches the active tab
(`documents.onChange` `active-changed`): when it is a ticket file of the
board's vault and the thread is closed or shows another ticket, it runs
`openTicketPage` for it. The pure rule is `pageFollowsActive`
(`ticket-page.ts`); a `pageOpening` flag keeps the page's own tab changes
from re-entering. Specs: `pageFollowsActive` rows in `ticket-page.spec.ts`.

### req-82 — the ticket page reuses its ticket pane

**Not yet manually verified by the owner.** Owner request, 2026-10-31
(outside the list). Picking a new ticket in the Work panel while the
thread was open split a new column beside the thread every time (the new
file was closed, the thread open → `beside: thread, split: right`), so
the editor filled with narrow ticket panes. `ticketPagePlan` now takes
the pair's previous ticket file (`previousFile`, tracked in
`openTicketPage`): while that tab is still open the new ticket opens in
its pane without a split. The split beside the thread remains only for
the first ticket after the pair was closed. Specs: two new rows in
`plugins/tickets/renderer/ticket-page.spec.ts`.

### Milestone 96 — fleet stability, the rest: limits, prompt versions, edit counts, Tell/Nudge, soft pause

**Not yet manually verified by the owner.** Owner request, 2026-11-01
("everything but M3"): the roadmap's M1c, M2b and M4b.

- **Run ceilings per column.** `max-turns:` and `max-work:` (minutes of
  busy time) in `pipeline.md` set the column's own ceilings; the
  request carries them (`RunRequest.limits`), the reaper prefers them to
  the runner defaults (`ticket-schema.md`).
- **A waiting worker frees its pool slot** (the ticket stays busy): with a
  pool of one, one unanswered question no longer blocks the provider.
- **claude-code's context cap is enforced mid-run.** A run whose
  `lastTurnContext` reaches the cap ends (fails into the back-off) — the
  worker cannot compact; the next run starts fresh from the handover
  section and the diff stat. OpenCode keeps compacting its own session.
- **Prompt versions.** Shipped prompts carry
  `<!-- drey-prompt-version: N -->` (plan/build/commit are v2); the runner
  says once per prompt when the vault copy is older (a copy without the
  marker reads as v0 — all of today's) and strips the marker before
  composing. The owner resets from Settings → Prompts. Flag, not
  replace: a customised copy is never overwritten behind the owner's
  back (`FLEET.md`).
- **Fallback repo instructions are capped** at 16 KB (a `CLAUDE.md` /
  `AGENTS.md` used when no `instructions:` file is configured) with a
  pointer to search the rest; the configured file stays verbatim.
- **Edit counts.** Edit/MultiEdit/Write calls carry `changes` (lines added
  / removed, read off the call's input); the transcript shows `+4 −1`
  beside the `✎` row.
- **Pause after the current action.** `pauseAfterAction` (`/softpause`,
  `fleetControl softpause`): the turn is interrupted at the next finished
  tool call. The header's and the cards' Pause use it; the composer's
  square keeps the immediate interrupt.
- **Tell… and Nudge on the Workers cards.** Tell opens an input that sends
  a message (`fleetSend`; the draft survives the section's redraws); a
  stuck worker offers Nudge with a canned status request.

Specs: `orchestrator.spec.ts` (waiting slot, prompt-version note and
marker strip), `runs.spec.ts` (column limits, cap, soft pause),
`ticket-board.spec.ts` (keys), `default-prompts.spec.ts`,
`context-pack.spec.ts`, `providers.spec.ts` (`editChanges`),
`transcript-view.spec.ts`, `workers-view.spec.ts`. Left: roadmap
"Fleet stability" (M3 and three small items).

### Milestone 95 — fleet stability, part 4: the run view tells the truth

**Not yet manually verified by the owner.** Owner request, 2026-10-31
(the stability analysis's last open part but the column model, which
the owner postponed — roadmap M3). Matches
`docs/design/work-panel/Ticket.dc.html` / `Workers.dc.html` where noted.

- **The runner talks as a system line.** Runner notes carry
  `detail: 'runner'` in the stream (older streams are recognised by their
  wording); provider stderr and unparseable lines carry `detail:
  'stderr'`. `formatWatch` draws the first as a muted/amber/red *system*
  block with its clock time, the second as a folded *Diagnostics* line —
  none of them is a fake "Turn" tool step any more.
- **A paused turn says so.** The result that closes an interrupted turn
  draws as **⏸ Paused**, not "✓ Turn finished"; `RunInfo.paused` (set by
  `interrupt`, cleared by the owner's next prompt or Continue) turns the
  header word into *Paused*, swaps Pause for **Continue** (the
  milestone-94 hand-back-that-continues), and the Workers card and the
  fleet light read *Paused* (amber).
- **Controls only where they work.** No Pause on a standing or waiting
  worker (no turn to interrupt), none on a stopping run (`headerControls`).
  A refused or failed control now shows **in the thread** (an alert under
  the header) — the note used to live only in the closed Work panel.
- **The event list.** Every tool row carries its clock time; commands
  read `▶ Bash`, edits `✎ Edit` (amber); a running call is a pill
  `running · 0:42` that ticks each second.
- **A *Workers* section** tops the Work panel while workers live
  (`workers-view.ts`): a card per worker — state word and light, ticket,
  the "Now" line (activity, question or pause hint), working time,
  context and tokens — with Pause / Continue, Stop and Open; the ones
  that need a look first. Paused / *Looks stuck* (the milestone-93
  watchdog flag) have their own lights. A detached run counts as live in
  the footer and the cards.
- **Resume under the cap.** A warm-pause resume over `contextCap`
  compacts natively when the worker can, else starts fresh (it used to
  resume at any size).

Specs: `watch-format.spec.ts` (system/diagnostic blocks, paused result,
clock), `transcript-view.spec.ts` (system line, Paused chip, running
pill), `thread-steps.spec.ts` (Continue, no Pause where none works),
`worker-status.spec.ts`, `workers-view.spec.ts`, `handover.spec.ts`
(over-cap warm resume). Not done: per-edit `+n −m` counts, a soft
pause flag, Tell… / Nudge — roadmap "Fleet stability" M4b.

### Milestone 94 — fleet stability, part 2: clean hand-overs, pause that resumes

**Not yet manually verified by the owner.** Owner request, 2026-10-31
(stability analysis, parts 1/1b = milestones 92/93).

- **A `## Handover` section per step.** Every worker brief now ends with
  the handover discipline: replace the ticket's `## Handover` (State,
  Decisions, Open, Files, Verified; under 15 lines) before ending, keep
  Log lines to one short line. The next step's brief and a resumed
  session carry that section (capped at 2 KB, in the *changing* part —
  the cache-stable prefix and `briefDigest` are untouched) instead of
  the Log tail. `ticketSections` returns it; `specs/ticket-schema.md`
  documents it.
- **A paused run is not a finished one.** `interrupt` marks the run
  paused: the `result` the interrupt produces no longer counts as
  agent-done. **Hand back** after a pause prompts the idle worker with
  `HANDBACK_CONTINUE` ("continue where you stopped, do not start over")
  and lets it work on, instead of ending the run so the gate judged half
  a step (the owner's T-0081 report). The owner's own next prompt clears
  the pause as well. A plain takeover → release is unchanged.
- **The diff stat reads the branch, not the base's tip.** `git diff
  --stat <base>` compared against the base's *current* commit, so once
  main moved on every upstream change looked like the worker's own
  deletions (bdml: a worker spent its first turns reconciling it). Now:
  `<base>...HEAD` (commits since the branch left the base), then
  `git status --short` for the uncommitted paths.
- **Shipped prompts** (`plugins/tickets/prompts/`): plan — every acceptance
  command must be able to pass (existing scope/path), the ticket file is
  committed by the runner, not the worker, plus the handover; build —
  handover, one-line Log, "owner", not a review step; commit — no
  "owner-reviewed", work only in own worktrees and never git in the
  owner's checkout, a merge conflict aborts and ends the step.
- The resume continuation says "continue where you stopped".

**Not in the repo's reach:** the *vault* copies of the prompts
(`tickets/_meta/prompts/` in the tickets repo) are snapshots and keep
the old text until they are refreshed — "Add Drey's prompts" or by hand.
Specs: `fleet-fields.spec.ts` (handover in brief and resume, none for a
dialog), `context-pack.spec.ts` (merge-base stat), `runs.spec.ts`
(pause → hand back continues, no pause → no prompt).

### Milestone 93 — fleet stability, part 1b: limits, watchdog, clean exits

**Not yet manually verified by the owner.** Owner request, 2026-10-31,
the rest of the runner part of the stability analysis (milestone 92).

- **Per-run ceilings.** The lease reaper stops a run past 250 model
  turns or 90 minutes of *working* time (closed busy spans plus the open
  one — waits for the owner do not tick; `limitExceeded`,
  `DEFAULT_RUN_LIMITS`, overridable through `RunSupervisorDeps.limits`,
  0 = unlimited). The run fails with `run limit: …`, so the milestone-92
  back-off applies instead of a burn-on. Held and interactive runs are
  exempt. The defaults come from the live fleet root: ordinary runs end
  within 20 turns, the heavy legitimate ones within ~170 / 76 min, the
  runaways were 400 turns / 128 min / 87 M tokens in.
- **Hang watchdog.** A working run (not held, not waiting, not idle, not
  gating) silent for 10 minutes gets `stuck: true` on its record and a
  Log line "looks stuck"; the next event clears it. After 40 silent
  minutes it fails with `hung: …` (back-off retry). The long fuses keep
  ADR-0014's "a local model may think for minutes".
- **The gate shell** is a spawn that keeps only the output's tail (the
  old `exec` failed a chatty passing command at 1 MB) and kills the whole
  process tree on its 30-minute timeout (`taskkill /T`; `exec` killed
  only the shell on Windows).
- **A graceful runner exit halts the chain first** (`/shutdown`,
  SIGINT, SIGTERM), then stops the live runs — each stopped run used to
  trigger a dispatch pass that started fresh workers inside the wait
  window, and SIGINT/SIGTERM left workers running.

Specs: `runs.spec.ts` (ceilings, watchdog flag then fail, turn limit,
`execShell` exit codes and output). Remaining runner items — roadmap
"Fleet stability": `contextCap` for claude-code, the TTL for waiting
runs, per-phase limit keys.

### Milestone 92 — fleet stability, part 1: the runner stops looping

**Not yet manually verified by the owner.** Owner request, 2026-10-31
(analysis of stuck tickets, runaway token use, pause/resume).
Evidence from the live fleet root: runs of 28–87 M input tokens, a
ticket's failed run re-dispatched at once with its broken session
resumed, the breaker parking the wrong ticket, the reaper failing runs
whose last message was "done". Changes (all in `plugins/tickets/main`):

- **Retry discipline per ticket.** Every failed run — a provider error,
  a run that ended without a result, a reaper kill, not only a red
  gate — raises a per-ticket counter and an exponential back-off
  (`failureBackoffMs`: 1, 2, 4 … 30 min, persisted in `chain.json`).
  At the column's `max-red` the failing ticket is parked in inbox.
  Quota failures stay the provider's pause, not the ticket's fault.
- **The breaker parks the ticket that failed**, not the first free
  ticket of the column (`parkNextCandidate(…, failedTicketId)`).
- **A stop by the owner is sticky.** The ticket is held (persisted
  `ownerHold`) until it moves or a newer run of it starts; stops made
  by the chain itself (column brake, Notaus) do not hold.
- **The daily token budget gates the dispatch** (a spent column reads
  as held, logged once), it used to be looked at only after a red gate.
- **The retry brief carries only the same column's gate failure**, and
  none once a later run of the ticket there succeeded.
- **claude-code `result` with `is_error` / `error_*` subtype is an
  error**, not a completion (usage limit, auth, max turns no longer
  count as done and no longer let a green gate move the ticket).
- **The lease reaper replays a lost exit** for a worker that already
  finished its turn instead of failing the run; the exit handler
  ignores a second call while its gate runs.
- **Git:** every ticket-repo command has a timeout (2 min, network verbs
  10 min) and retries on `index.lock`; `chain.json` is written through a
  temp file + rename.

Specs: `orchestrator.spec.ts` (back-off, parking the right ticket,
sticky stop; the retry fixtures now carry their column),
`providers.spec.ts` (error result), `tickets-git.spec.ts` (lock retry).
Still open from the analysis — roadmap "Fleet stability": per-run turn /
wall-clock limits, the hang watchdog, handover blocks and prompt sync
(part 2), the phase-in-frontmatter column model (part 3), the run
messages and Workers view as in `docs/design/work-panel/` (part 4).

### req-81 — the checkpoint actions live in the thread's status row, the Ready card folds

**Not yet manually verified by the owner.** Owner request, 2026-10-31.
The Ready card popped exactly when a run had ended — for a ticket the
chain had already merged into main (the unattended pipeline's first
owner checkpoint is the one *after* the merge), its "Accept" arrived
too late to mean anything, and once gone the view could not be opened
again. Now the actions sit where the owner reads the state: the thread
header's control row carries **Launch**, **Accept** (titled with the
real move: archive in the terminal phase, `Approve → …` earlier) and
**Send back** whenever the ticket waits on the owner — beside the run
controls, separated by a hairline, always there and reopening with the
thread, whatever the card does (`checkpointControls` pure beside
`headerControls`; Launch only on a repo ticket — a removed worktree
refuses with a mutation hint). The Ready card itself folds: a **Ready
chip** in the header (its label is the waiting checkpoint, Ready to
try / Review) hides the card and brings it back any time; while it is
folded the decision bar above the composer returns. The terminal
button no longer reads a bare `Accept` but **Accept and archive** —
truthful about a phase whose merge already happened (`Accept and
merge` keeps meaning the earlier checkpoints).

### Fix — the thread composer's toolbar back in its box, the thread header on the meta-bar line

**Not yet manually verified by the owner.** Owner report, 2026-10-31.
The W4a merge (591be22) kept the branch's composer rows (input row with
send, a row under the box for attach and stop) while main's CSS for
them had already been replaced by the toolbar shape — so the rows were
unstyled: the send button fell under the prompt, the attach button out
of the box. The composer is the toolbar shape again: the prompt on top,
a toolbar inside the box (attach left, stop and send right), the two
quick-prompt chips above it, indented like the decision bar
(`run-composer.ts`, `board.css`). The thread header is now exactly the
editor meta bar's height (`--meta-h`, same padding), so its bottom line
runs level with the line of a note open beside it. In a narrow pane
the title and the meta line shrink to nothing first; the Ticket file
link and the controls always stay whole. The meta line's tooltip no
longer carries a ticking clock (a title rewritten every second closed
the open tooltip — it flickered while a worker ran); the line and its
tooltip are written only when their text changes.

### Fix - the Work panel holds still, the fleet status moves into the footer

**Not yet manually verified by the owner.** Ticket T-0086 (owner request,
2026-10-31, after req-75 W1b). Four findings from the owner's screen:

- **The fleet controls fell out of the panel head at narrow width.**
  `.head` had a fixed 32 px height with `overflow: hidden`, and
  `.head-actions` could neither shrink nor wrap — the header's right end
  (the fleet chip, run/halt, abort, ⋯) was clipped away and the buttons
  rendered displaced. The head now grows (`min-height`) and its action
  strip shrinks and wraps (`panel-frame.css`, `#pluginActions` gets
  `min-width: 0`), so the controls flow onto a second row instead of out
  of view — every dock panel's header may wrap now, an additive change
  under space pressure only.
- **The fleet status lives in the footer, at every width.** The owner's
  own proposal, taken literally: the header chip (`fleetHeaderNode` and
  its two width thresholds) is gone; the footer's line is the one fleet
  display — a live node (own paint, 1 s tick, fleet and panel-width
  listeners) over the pure `fleetLine` (`worker-status.ts`): the worst
  light, the states in words plus who is out there
  (`2 running · OpenCode 2`), tokens and the oldest run's age as a mono
  suffix (hidden under 360 px, kept in the tooltip), amber at least
  while a chain alert stands, and the alert itself when nothing runs.
- **The whole Work view is no longer rebuilt on every fleet update.**
  The daemon polls every 2.5 s and pushes whenever the JSON differs —
  tokens, `lastActivity`, `activity`, `execMs` move on every poll while
  a run is live, and each push cleared and rebuilt the whole list (the
  context menu survived in `document.body`, but the list under it was
  destroyed — hover lost, visible flicker, the 1 s clock made it read as
  "rebuilt every tick"). Now `applyChainStatus` re-renders only when the
  Work list's *structure* signature moves (`workListSignature`:
  per run id, state, column, waiting kind, turn, interactive, held, plus
  the alert keys); anything else paints in place (`workListLivePaint`:
  ages, run step/line/dot, shaped lines — never a node added or
  removed). The master buttons stay outside the gate; a run *state*
  change still re-pulls the board.
- **Submenus no longer linger.** Hovering another row of the open menu
  closes the submenu at once (the 250 ms grace stays only on leaving
  the trigger/panel — the diagonal move into the submenu needs it), so
  the panel and the trigger's gray background follow the pointer
  without a lag beat.



### req-75 W4b — All workers

**Not yet manually verified by the owner.** Built before the
fleet-stability milestones landed their own Workers section on main
(milestone 95/96); rebased onto it — the tab keeps the section's soft
pause (**Pause** = `softpause`, a paused card's primary is
**Continue** = `release`) and sends the same canned Nudge text, while
the section's cards stay as milestone 95 shaped them. The Workers tab
(`docs/design/work-panel/Workers.dc.html`, artboard "3b · All
workers"), part 2 of req-75 W4 (part 1: W4a, below): one card per live
run, opened from the Work panel footer's **Workers** link (right end
of the footer, a text link) or the header ⋯ menu's **Workers** row —
the stateless doc kind `tickets-workers` (key `workers://all`, title
`Workers`, icon `users`, restores itself). The top row: the h1, one
chip per provider pool — `<Provider> <live>/<size>`, bold numbers,
the sizes from the `fleet.pool.*` config read once at activation like
the main side does — the muted queue line (`<n> queued`, plus
` · <title> waits for <blocker id>` for the first blocked queued
ticket), then **Pause all after this step** (a soft pause per live
run under one busy line — each card's **Continue** releases it) and
the two-step armed **Stop all** (label
`Stop all — click again`, the chain's emergency stop `chainAbort` —
the master switch's ■; it disarms after 5 s). Each card (min 320 px
wide, 8 px radius, 1 px border: `--status-modified` while waiting,
`--accent` while you tell it something, a warning hue when stuck):
the run's dot, the bold ticket title, the time right; the muted
`state · Provider · model · context <pct>` line (state from
`liveStateWord`, or `Looks stuck`); the **Now** box — the current
activity (`run.activity`, else the newest action) in 12 px mono with
the two recent actions before it (`recentActions`); the state's
controls — working: **Pause** (the soft pause, `softpause`) /
**Tell…** (a one-line input labelled
`Tell the worker` with a **Send** button inside the card, sent over
`fleetSend`) / **Take over** / **Stop**; paused: **Continue**
(primary, `release`) / **Tell…** / **Take over** / **Stop**;
waiting: **Answer** (primary,
opens the ticket page) / **Take over** / **Stop**; stuck: **Nudge**
(the same canned status request milestone 96's section cards send,
through `fleetSend`) / **Hand to Claude Code** / **Hand to OpenCode** (stop
with the reason `handed to <provider> by the owner`, then `fleetStart`
for the same ticket with the other provider) / **Stop** — and the
**Open ticket** link right. A busy run without progress reads **Looks
stuck** — the fleet's own `stuck` flag on the run counts too — from
`stuckOf` in the new pure `plugins/tickets/renderer/stuck.ts`
(a hint, never an automatic action): no write/edit tool call for
`STUCK_NO_EDIT_MIN` = 8 minutes (from the last edit, else the run
start) or one path read `STUCK_REPEATS` = 4 times among the last 20
tool calls without an edit after it (the telemetry's
`READ_TOOLS`/`WRITE_TOOLS` vocabulary over both adapters' tool-call
shapes); waiting, idle, detached and ended runs never are. The hint
line says `No progress for <n> minutes and the context is filling up.`
— `No progress for <n> minutes.` under 60 % fill — or, on repeated
reads, `Read the same files <n> times without an edit.` The ticket
thread's header state word reads `Looks stuck` when either stuck
source says so.
Each live run's stream is pulled every 5 s while the tab is mounted
and the pull stops on unmount; the tab's muted footer says
`<n> workers · today <tokens> tokens` (tokensIn + tokensOut of the
runs started today). Specs: `stuck.spec.ts` (15),
`workers-view.spec.ts` (15, jsdom: milestone 95's six section tests
plus the tab's nine). Docs: roadmap's W4 bullet removed
(stage shipped), manual §13, docs/05 §5.41 "Workers view" row.

### Milestone 91 — ticket T-0084: the Work panel's phase colours, filter and running marks

**Not yet manually verified by the owner.** Ticket T-0084 (owner request
outside the list, 2026-10-31; [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md)
later change). The ticket was built on the morning base; by its merge
the canvas panel (req-75 W1b) had landed on main, so with the owner's
pick (this merge, option 1 of the commit step's question) the features
were **grafted onto the five canvas groups** — Needs you, Running,
Shaping, Ideas, Done this week keep W1b's order, and the ticket's
"In progress" vocabulary becomes Running. Landed:

- **Phase colours**: `color:` per phase in pipeline.md (`#rrggbb`,
  `PipelinePhase.color`; an invalid value degrades to a noise issue and
  the curated default palette — `TAG_AUTO_PALETTE` keyed on the column's
  board position, `renderer/phase-colors.ts`), edited in Settings →
  Tickets → Pipeline's new Color column (one commit per change, the
  worker-clear keeps it). Every Needs-you, Shaping and Running row
  carries a **phase chip** — a dot in the phase's colour plus its name.
- **The filter**: the funnel button in the panel header opens a popover
  of toggle chips — phases and statuses, positive selection, both axes
  at once, per-viewer localStorage beside the folds (`work-filter.ts`).
  `rowStatusOf` derives the eight statuses (Waiting for you, Needs
  review, Failed, Running, Queued, Blocked, Parked, Idle); heads show
  `<visible>/<total>` while active, and a group the filter emptied
  offers `Hidden by the filter — clear`.
- **Running emphasis**: the Running head counts its live runs
  (`2 · 1 running`) and live rows carry `data-running`. No extra accent
  bar — the open row already owns that visual and the run dot fills.
  The dependency order itself was already owner-locked earlier the same
  day (`dependencyOrder`, the runner-beside-ticket fix): a blocker
  before what it blocks, in Ideas as in the Running queue.
- **Option dots**: the thread's question pills (W2b) and the phone's
  option rows carry a leading dot; the recommended option's dot fills
  and rings.

Specs: `phase-colors.spec.ts`, `work-filter.spec.ts` (new),
`work-groups.spec.ts` and `work-panel.spec.ts` (adapted to the canvas
groups), `ticket-board.spec.ts`, `remote/dom.spec.ts`;
`specs/ticket-schema.md`, the manual §The Work panel, ADR-0087's
later-change note, the roadmap Status line.

### req-75 — Runner and ticket side by side, dialogs start quiet

**Not yet manually verified by the owner.** Ticket T-0052 (req-75's
remaining gap after W1/W1b/W2/W2b;
[ADR-0084](../docs/09_architecture_decisions/0084-interactive-runs-at-plan-and-checkpoints.md),
[ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md)).
The ticket page opened a third pane whenever focus sat elsewhere, an
interactive dialog ran its first interviewing turn before the owner
said anything, held resumes posted an internal continuation prompt
that caused no-op turns, and a question buried in a worker message set
no wait.

- **`beside` (SDK 1.37)** (`shared/plugin-api/`, `doc-open.service.ts`):
  `documents.open`/`addDoc` take `beside: <open tab's path or key>` —
  the anchor tab's pane is focused **before** the landing decision, so
  a plain open replaces inside that pane and `split` opens off it. An
  anchor that is not open makes `beside` a no-op; an already-open key
  reveals as today. Lint-clean cases in `editor.service.spec.ts`.
- **The ticket page anchors on the pair** (new pure
  `plugins/tickets/renderer/ticket-page.ts`, spec beside it): thread
  closed → beside the file; file closed → beside the thread; both open
  → reveal both, focus back on the file (W1's rule). Whatever pane is
  focused, whatever else is open — never a third pane; every ticket
  switch re-activates both tabs. The old `threadFocused` special case
  is gone. Merged onto the same day's *runner beside the ticket* fix:
  the side tab is the **live run's tab** while a run runs, the thread
  otherwise — whichever it is, the pair anchors on itself.
- **Dialogs start quiet** (`providers.ts` `holdAtSpawn`, `runs.ts`,
  `protocol.ts` `RunInfo.quietStart`): an interactive run spawns with
  no first prompt delivered — the composed brief wraps the owner's
  first send (exact wording pinned in `runs.spec.ts`), then plain
  steers; `quietStart` on the record until then. Claude Code has no
  hold at spawn and keeps today's first posted turn. The thread's
  composer pre-fills the step and its meaning (new
  `dialog-starters.ts`, spec beside it) and shows the pending hint
  `waits for your first message — the worker starts when you send`
  while the run waits.
- **Held handover resumes go silent**: the internal `HANDOVER_HELD`
  prompt (six observed no-op "I'm back" turns) is deleted — a held
  run taken over by a runner restart spawns held, no prompt
  (subsuming req-80's idle empty-prompt case); `HANDOVER_CONTINUE`
  still rides non-held resumes, and the fresh fallback re-holds a
  held run.
- **`questionOf` accepts a buried marker** (`providers.ts`): the text
  from the **last** line-start `QUESTION:` marker anywhere in the
  message (message start included); a marker in prose still sets no
  wait (`'Done. QUESTION: none'` stays null, pinned).

### req-80 — Fleet token economy

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31), from the analysis of T-0061's build run: 87.2M input
(86.7M cached) for 107k output. Its stream showed five causes, each
fixed here:

- **No context ceiling.** The run's context grew from 58k to 392k
  because GLM's 1M window never triggers OpenCode's auto-compaction, and
  each of about 240 model calls re-read all of it (about 60M real cache
  reads). The new `fleet.contextCapTokens` (default 160000, per
  provider/model overrides, Settings → Tickets → Fleet → *Context cap*)
  starts each OpenCode server with `OPENCODE_CONFIG_CONTENT` setting the
  pinned model's `limit.context` (`opencodeCapConfig`; measured on
  v2.0.32: a `context`-only override is dropped, so `output` rides too).
- **Replayed telemetry.** A session resumed in place after a runner
  handover re-emitted every old message, `turnUsage` included: 400
  recorded turns where 240 were real, and 102.5M cache reads recorded
  against 60.7M. The adapter now marks what predates its first prompt
  as seen (`seenBeforeMs`), on resume as on re-attach.
- **"I'm back" turns.** A held worker that stood idle got
  `HANDOVER_HELD` on every handover, a full-context turn for one line.
  `RunHandover.turnIdle` + `ProviderAdapter.promptless` now resume it
  without a prompt.
- **The brief twice.** A `resume` start posted the whole context pack
  into a session that already held it (three copies sat in T-0061's
  session). `composeInstruction` now also yields a short continuation,
  and the runner sends it while `briefDigest` matches the resumed run's.
- **Silent refusals.** Three runs ended in 6 s with 0 tokens, and each
  was gated on untouched code. An idle marker with no assistant message
  after the newest prompt now fails the run without a gate.

Specs in `providers.spec.ts` (no replay, the empty-answer refusal, the
cap config and env), `runs.spec.ts` (promptless held handover, the
continuation vs a changed brief), `request.spec.ts` (continuation and
digest), `handover.spec.ts` (`contextCap` precedence). FLEET.md
"Token economy", manual §13 and the settings page updated.

### Fix — the runner beside the ticket again, running tickets first, one Open row, the chain survives a rebuild

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). Since the Work panel (M89) the run tab itself stayed
empty: its composer paints once while it is built and read the run
through `live`, declared after it — a ReferenceError the doc host
swallowed, so every *Open run* showed a blank tab. A ticket also opened with its
file and the thread only — the run tab with its metrics was reachable
from the row menu alone (and from 15:31 no longer from the thread); the
menu offered *Open ticket* and *Open ticket file*; Running sat below
Shaping, sorted by phase; and a runner retiring for a newer build left
its successor halted, so the queue stopped after every rebuild. Now
`openTicketPage` puts the ticket's **run tab** beside the file while a
run is live (the thread otherwise — an ended run's decisions live
there), reusing the side pane like the thread did (`pageSide`); the
menu has one **Open ticket**; the groups run **Needs you → Running →
Shaping → Ideas**, Running with the live runs on top and the queue in
`dependencyOrder` — a blocker before what it blocks, carrying the most
urgent priority it holds up, then closest to done (Ideas: then newest);
a retiring runner stamps `handoverAt` in `chain.json`
(`Orchestrator.markHandover`) and a successor booting within five
minutes keeps the master (`HANDOVER_MASTER_MS`) — a cold boot still
starts halted. Specs in `work-groups.spec.ts`, `work-panel.spec.ts`,
`orchestrator.spec.ts`; e2e `work-panel.spec.ts` opens a waiting and a
planning ticket into their run tabs; manual §Work panel updated.

### Fix — the Work panel shows when the fleet stops, and resumes it

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). Three quota failures of T-0061 tripped the build
breaker at 12:48; the board kept quiet for three hours, because the
Work panel (ADR-0087) had dropped the kanban's per-column brakes with
nothing in their place, "Needs you" lists only runs (and T-0061's
failures left it once a new run started), notifications came only for
questions and approvals, and the header's fleet status had moved into
a footer count. Now `chainAlertsOf` (`renderer/chain-alerts.ts`) folds
the chain status into alert rows on top of the Work panel — a column
**stopped by the circuit breaker**, a machine column **on hold** while
tickets wait in it, a **halted chain** with work waiting, a provider
**out of quota** — with **Resume** (`chainColumn` playing) or **Run**
(`chainMaster`). A breaker trip and a quota pause raise one OS
notification each (`newChainAlerts`); the alerts count in the panel's
status; the header's fleet status chip is back (worst light, states,
tokens in flight, oldest age), amber while an alert stands. The runner
reports `tripped` (per column, persisted in `chain.json`) and
`quotaPausedUntil` (per provider) in `ChainStatus`; playing a column
clears its trip **and resets its red streak** — before, one more red
gate tripped the breaker again at once. Older runners omit both fields:
a hold with a full red streak still reads as a trip. Specs in
`chain-alerts.spec.ts`, `work-panel.spec.ts` and `orchestrator.spec.ts`;
manual §Work panel and `FLEET.md` updated. Running rows first (T-0084)
and a usage menu in the thread (roadmap follow-up) are separate.

### Fix — OpenCode servers no longer outlive their runs

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). Nineteen `opencode serve` processes (~3.7 GB) were
found running with no run behind them, every one with a dead parent.
On Windows the server runs under a `cmd` shell (the npm shim needs
one), and `attach.json` recorded the shell's pid: the shell died with
a retiring runner while the server lived on, so the successor read the
worker as dead, resumed the session in a second server and never ended
the first. Now `recordAttach` records the process listening on the
server's address (`listenerPid`, Windows; the shell pid elsewhere), so
a successor re-attaches instead, and a resume in place ends the
recorded server first (`killRecordedServer`, guarded by its creation
time). A boot that fails after the server came up (not ready in time,
a refused prompt) now ends that server too. Specs in `procs.spec.ts`
and `runs.spec.ts`.

### Fix — the thread's composer looks like Claude Code's, an ended run takes the next message

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). The thread header carried a green "Open the run in
its own tab" button the owner read as a restart, while the prompt box of
an ended run outside a dialog phase stayed read-only; the quick prompts
sat in a row under the box, offset by the attach button. Now the header
keeps only **Stop run** (live runs); the run's tab stays on the row's
menu (Open run / Past runs). A message to an ended run with a session
reopens it as a new run in the thread too (`run-composer.ts`
`isReopenable`; before, only the takeover tab did, and the thread could
only start a dialog — it still does when there is no session). The
composer is one box in Claude Code's shape: the prompt on top, a toolbar
inside it below — attach and the quick prompts left (scrolling sideways
when narrow), stop and a filled send button right. e2e
`work-panel.spec.ts` ("an ended run keeps the box free") checks the
header, the enabled box and the toolbar's place; manual §Work panel and
§dialogs updated.

### Fix — the ticket page no longer splits again per ticket

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). Opening one ticket after another from the Work panel
split the editor again each time the thread pane had the focus (after a
click into the thread), so the page fell into ever narrower panes and
the thread's composer squeezed its quick-prompt chips into broken
two-line pills. `openTicketPage` now remembers the ticket file it opened
last and reactivates that tab first, so the next ticket opens in its
pane and replaces it when it is clean — no new pane, no new tab; only
when that file was closed and the thread is focused does the page still
split once. The composer's row under the box wraps and a chip keeps its
label on one line, and the Ready card's buttons wrap instead of running
out of a narrow thread. e2e `work-panel.spec.ts` ("the next ticket lands
in the last ticket pane") opens four tickets with the thread focused and
expects two panes and one ticket tab throughout.

### Fix — a transition commit survives the runner's bookkeeping commit

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). Moving T-0052 plan-review → build stopped its run;
the runner's settle committed "fleet run bookkeeping", which already
recorded the old path's removal, so the board's own transition commit
(`git add -- <old> <new>`) failed with "pathspec … did not match any
files" and the move stayed uncommitted. `TicketsGit.commitPaths` now
drops a path git reports as unmatched (gone from disk and index) and
commits the rest; any other `add` failure still throws. The missed
commit was made by hand in the tickets repo. Specs in
`tickets-git.spec.ts`.

### req-79 — Fleet: the brief opens with a short worker file, not the whole CLAUDE.md (owner request, outside the list)

**Not yet manually verified by the owner.** The token audit of
2026-10-31 (52 runs since 2026-10-30, 3,236 model calls, ~372M input
tokens, nearly all cache reads) found the context pack (T-0048,
ADR-0081) inlining the 49 KB `CLAUDE.md` at the head of every brief —
about 12.5k tokens carried by every model call, ~11 % of the total —
and its pair-programming rules sending workers into whole-spec reads
(`changelog.md` read in 20 runs, `manual.md` in 18, `roadmap.md` in 16).

- **`instructions:` in `repos.md`**: the file, relative to the repo's
  checkout, the pack opens with verbatim (`RepoRef.instructions`,
  `parseRepos` / `reposFileText`, `readRepoInstructions`). Unset — or a
  configured file that is missing or blank — falls back to `CLAUDE.md`,
  then `AGENTS.md`, as before; an absolute path, one leaving the repo or
  a non-string warns and reads as unset. Settings → Tickets →
  Repositories gains the **Agent instructions** field.
- **`docs/agents/fleet-worker.md`** is written to be that file: it says
  it replaces `CLAUDE.md` in the brief and names the large files a
  worker reads only by line range.
- The board's `repos.md` needs `instructions: docs/agents/fleet-worker.md`
  under `drey` (owner's data; not set by this change).
- The other levers the audit found are under "Follow-ups" in the
  roadmap.
- Specs: `context-pack.spec.ts` (new: configured file first, the
  fallbacks), `ticket-board.spec.ts` (parsing, warnings, round trip).
  Docs: `specs/ticket-schema.md`, ADR-0081 later change, `FLEET.md`,
  manual §13.

### req-75 W4a — The worker on the ticket

**Not yet manually verified by the owner.** The worker lives on the
ticket thread (`docs/design/work-panel/Ticket.dc.html`, artboard
"3a · A ticket with its worker live"): the thread's header says what
the worker does now — a bold state word (`liveStateWord` in the new
pure `plugins/tickets/renderer/thread-steps.ts`: `Waiting for you`,
`Planning`, `Building`, `Merging`, `Idle`; `No run yet` without a run)
beside the run's dot, one muted meta line (provider · model · run time
· context fill) that carries the takeover tab's telemetry as its
tooltip, and the worker's controls — **Pause** (interrupt), **Take
over** (`fleetControl takeover`) and **Stop**, plus **Hand back**
while held and **Resume session** when a run ended with a session (the
takeover's two controls, same handlers). The pure choice is
`headerControls` (`thread-steps.ts`, owner request 2026-10-31: one
ticket, one session, the same controls in every state — exactly one
way on): Stop for any run not ended with Pause/Take over only while
the worker is connected (a detached run gets Stop and Resume session,
never Pause), Resume session for an ended run with a session, Start
(the existing manual start) otherwise; a detached run's state word is
`Running`, its meta line `not connected`. The transcript area becomes
the step list (`threadSteps`): each finished run of the ticket one
folded line (mark ✓/✕/■/●, label, duration; click unfolds that run's
transcript read-only — its stream is pulled once, never polled), the
live (or newest) run open at the bottom; the owner's own messages are
right-aligned bubbles. Above the steps: `Shaped with you · plan
approved <age>` when the ticket's Log has an owner `plan-review ->
build` line (`planApprovedOf` in `shared/changes.ts`, on the `changes`
IPC), and a **Changes so far** box (the new `worktreeChanges` IPC —
`git diff --numstat`/`--name-status` of the ticket's worktree against
its base ref, committed (`<base>...HEAD`) and uncommitted, parsed by
the new pure `plugins/tickets/main/worktree-changes.ts`; refreshed
when a run's state changes and every 30 s while one is live) with
`Safe beside others · ✓ own worktree · t/<id>`. The composer's quick
prompts become the design's two chips above the box (**What are you
doing and why?**, **Stop after this step**). The separate takeover tab
is gone (ADR-0087 decision 3): `openTakeover`/`mountTakeover` removed,
its doc kind restores old sessions onto the ticket page (an unknown
run does nothing; a leftover mount says the tab moved), the row menu's
`Open run` becomes `Open ticket`, and `Past runs` opens the thread
with that run unfolded. Specs: `thread-steps.spec.ts` (12),
`worktree-changes.spec.ts` (9), `planApprovedOf` in `changes.spec.ts`;
e2e expects the state word and no `Open run`. Part 1 of req-75 W4
(part 2: the Workers view, T-0081).

### Fix — a spent provider quota no longer reads as a finished run

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). When the z.ai plan's five-hour quota ran out,
opencode ended every turn at once with `outcome: failed`
(`provider.quota`, 429). The adapter ignored the outcome and reported
an ordinary end, so the runner gated untouched code: T-0061's build
went red three times and tripped the breaker (parking T-0081), and
T-0060's commit run moved it to done without merging. Now the adapter
reports the refusal as the run's error and no result
(`providerErrorText`), the run fails without a gate (the Log line names
the error) and the orchestrator pauses that provider's pool for thirty
minutes (`isQuotaError`, `QUOTA_PAUSE_MS`). Specs in
`providers.spec.ts` and `orchestrator.spec.ts`; ADR-0077 says so.

### Fix — an archived blocker no longer blocks

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31). A `blocked-by` id that names no board ticket —
archived, deleted or renamed — used to warn and keep the dependent
blocked; archiving T-0059 after it merged left T-0075 stuck in commit
(no commit run, run start refused). Such an id now does not block and
gives no finding (`plugins/tickets/main/blocked.ts`; specs in
`blocked.spec.ts`). `specs/ticket-schema.md`, `plugins/tickets/BOARD.md`,
docs/05 and an ADR-0076 later change say so; a mistyped id unblocks
too — the accepted price.

### req-75 W3 — Ready to try

**Not yet manually verified by the owner.** Ticket T-0060 (roadmap
req-75 W3; [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md)
decision 3, design reference `docs/design/work-panel/Ready.dc.html`,
artboard "3c · Ready to try — launch and accept"). When a ticket's
work is built, its thread says in plain words what changed for the
owner, where, which checks passed and how to try it — with **Launch
this version**, **Accept and merge** and **Send back…**, and beside it
"How it got here", the ticket's story from capture to now. Folds in
T-0057 (the owner's "start the program from the ticket" button): a
launch command per repository.

- **The `## Changes` section** (`plugins/tickets/shared/changes.ts`,
  pure + spec): the build worker writes it into the ticket before it
  ends (format below, in `specs/ticket-schema.md`); the page parses it
  tolerantly — labels case-insensitive, `-`/`*` bullets, missing parts
  left out — and never from a diff on the desk. `storyOf` reads the
  story from the Log lines alone (created → `Captured`, the phase moves
  → `Planning`/`Planned`/`Building`/`Merging`/`Ready to try`, a green
  build run → `Built and tested`, `sent back:` → `Sent back`,
  `archived` → `Accepted`; `you` for owner lines, else the worker the
  run named; totals: first-to-last stamp in minutes, tokens summed
  from the run-usage lines).
- **Launch this version** (`launchVersion` IPC): resolves the ticket's
  worktree (`worktreePathFor`), refuses `T-00xx has no worktree yet —
  nothing to launch`, picks the repo's new `launch:` key from
  repos.md — `runInNewConsole` (`open-terminal.ts`) runs it in a fresh
  console at the worktree: Windows `cmd /c start "<id>" cmd /k <one
  argument>`, detached and unref'd, no shell string ever built from
  ticket content — else the fixed default `powershell -NoProfile
  -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi` when the
  worktree has a `dev.ps1`, else refuses with a hint at
  Settings → Tickets → Repositories, where the per-repo **Launch
  command** field now lives (`RepoRef.launch`, parse + write + warning
  on a non-string).
- **Accept and merge** (`acceptTicket`): follows the pipeline — the
  terminal phase gets the archive treatment, then the worktree is
  removed when it is clean (a dirty one stays with the warning `The
  worktree has uncommitted changes and was kept`; a live run keeps it
  too); any earlier phase gets the ordinary transition to the next
  configured phase (with an agent `commit` phase next, that step
  merges). Built on the transition/archive cores extracted into
  `moveCard`/`archiveCard` (one queue, one commit each — no second
  implementation).
- **Send back…** (`sendBack`): a modal (heading `Send <id> back`, a
  note labelled `What should change?`, `Send back` disabled while
  empty) moves the ticket to the nearest earlier agent phase (the
  build column in the default pipeline) with two Log lines —
  `<from> -> <to>` and `sent back: <note>` (trimmed, max 500 chars) —
  in one commit.
- **The Ready page** (`renderer/ready-view.ts` + spec, the thread
  wiring in `renderer/index.ts`, `board.css`): for a ticket in Needs
  you as `Ready to try` or `Review` — and any ticket whose file has a
  `## Changes` section — the card sits above the transcript (kicker,
  title, track/repo/`Ready to try` chips, the sections, the buttons,
  the muted hint) and the story beside it as a right column from
  900 px pane width, below when narrower (a container query on the
  thread). The decision bar's Accept becomes the card's buttons while
  the card shows; a ticket without the section still gets the story
  and the buttons.
- The shipped `build-default.md` prompt now makes the worker write or
  update the section before it ends (exact format in the prompt and
  `specs/ticket-schema.md`); `default-prompts.spec.ts` pins it.
- Specs: `changes.spec.ts` (8), `open-terminal.spec.ts` (2, the
  argument list over an injected spawn), `ticket-board.spec.ts`
  (launch parse/write), `commands.spec.ts` (the send-back note),
  `ready-view.spec.ts` (5, sections render / missing sections left
  out / buttons call deps). docs/05 §5.41 gains the "Ready to try"
  row; docs/06 §6.60 the Accept sequence; the manual §13 describes
  the page and the launch command.

### req-75 W2b — The question reads like the canvas

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31, review of the req-75 chain). Ticket T-0082 (roadmap
req-75 W2b; [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md),
design reference `docs/design/work-panel/Home.dc.html`). W2 built the
question's data and the one-tap answer, but its wait card read like a
yellow form and its option buttons broke their text into two columns.
In the thread a question is now part of the conversation, drawn like
the canvas's centre column.

- **The ask view** (`plugins/tickets/renderer/wait-view.ts`,
  `questionNode`): the lead-in `One decision before I go on: ` with the
  question in bold, the why as a muted paragraph (left out when the
  shape names none), one pill per option with its consequence after a
  ` — ` in muted text, the recommended one accent-bordered and ending
  in `recommended` (the recommendation's reason rides its `title`), and
  a muted meta line — `<age> ago · the worker waits, nothing else is
  blocked`, or `; <n> other worker(s) keep going` while other runs are
  live (`1 min` / `4 min` / `2 h`, from `waiting.since`). A plain
  question (no shape) still renders: `The worker asks: ` and its text,
  not bold. On the desk the ticket and step lines are left out — the
  page already carries them; the phone keeps them.
- **In the composer** (`run-composer.ts`): a `question` wait (shaped or
  plain, no OpenCode form) is drawn with `questionNode` **instead of**
  the wait card — no label sentence, no card background or border, no
  `Ticket:` / `Recommendation:` lines; the prompt box below stays the
  free answer, an option tap sends `answerText(option)` through the
  ordinary `send` path and stands the pills by until the worker asks
  anew. Permission requests and question forms keep the card. The new
  `othersLive` dep feeds the meta line (both call sites in `index.ts`
  count the other live runs).
- **The pills fixed** (`board.css`, W1b's classes): the button is
  `inline-flex; align-items: baseline; flex-wrap: wrap; text-align:
  left; max-width: 100%` — label and consequence are inline spans of
  one wrapping text, never two flex columns; height grows from 30 px,
  radius 15, 1 px `--border` (the recommended one `--accent`).
- Specs: `wait-view.spec.ts` (the shaped DOM, the plain question, the
  meta line's ages and other-worker variants, the pick),
  `e2e/work-panel.spec.ts` expects the question in
  `.tickets-ask-question` with the wait card hidden.

### req-75 W1b — The Work panel looks like the canvas

**Not yet manually verified by the owner.** Ticket T-0075 (roadmap
req-75 W1b; [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md),
design reference `docs/design/work-panel/Home.dc.html`). W1 shipped the
behaviour; this closes the visual gap to the owner's canvas: the groups
**Needs you · Shaping · Running · Ideas · Done this week**, two-line rows
with a kind chip and an age, a track chip on ideas, the worker footer,
and the thread's header and composer drawn like the artboard.

- **The groups** (`plugins/tickets/renderer/work-groups.ts`): Running
  absorbs W1's In progress; the new **Shaping** holds every ticket the
  owner reserved for a dialog (`interactive: true`) or that has a live
  interactive run. New pure helpers: `needKindLabel` (Question /
  Approval / Gate red / Run failed / Plan to approve / Review / Ready to
  try — the checkpoint after the plan column is a plan, the terminal
  phase a result), `runningStepOf` (Planning / Building / Merging or the
  phase title, the run's activity as a mono line; queued shows why —
  `waits for "<blocker>"` or a free worker), `ageWords` (now / n min /
  n h / yesterday / n d). `statusLineOf` is the Needs-you line after the
  chip (the question itself, no prefix; `checks green`, `plan ready`,
  `waits for your review`).
- **The rows** (`work-panel.ts`): a row is information plus one click —
  the W1 action buttons moved into the thread's decision bar, and W2's
  option buttons into the thread's wait card (as pills). Ideas are one
  line: an Urgent/High mini chip when it matters, the title, a Queued
  chip, and the triage chip Auto / Shape / Triage. The first five ideas
  show, then `<n> more` unfolds the rest (remembered, like every fold).
  Needs-you rows keep the issue badge; the open ticket's row carries a
  raised background with a 2 px accent bar.
- **Done this week**: `BoardSnapshot.recentDone` (main, `recentDoneOf`
  over `parseArchivedStamp`) — the tickets archived within the last 7
  days, newest first, max 20, from the archive files the refresh lists
  anyway (no extra reads). The group starts folded; its rows are muted
  mementos.
- **The track key** (`track: auto | shape`, `specs/ticket-schema.md`):
  parsed with a visible warning for anything else, set from the row
  menu's Track › (Auto / Shape / Not triaged) beside Priority › — one
  `setTrack` command, one commit `tickets: <id> track <value>`, one Log
  line.
- **The panel chrome**: header project · spacer · + (New idea) · refresh
  · master · ⋯; the fleet chip left the header for the **footer** — the
  worst light plus `<n> workers · <Provider> <live>` (No workers
  running when idle). The widget's status says `<n> need you` while
  something waits. The thread grew its canvas header (the run's dot —
  modified-hued when it waits on you — the bold title, one muted
  `state · provider · model · age` line, a Ticket file link, icon-only
  run buttons) and the **decision bar** above the composer (Approve →
  next / Refine with agent, or Accept — W1's row buttons, same
  handlers). The composer is one rounded box with a round send button;
  attachments and quick prompts sit in a muted row under it; a shaped
  question's options are pills.
- Icons vendored for the stage and its successors: `external-link`,
  `messages-square`, `mic`, `rocket`, `hand`, `users`
  (`src/app/icons/icon.ts`).
- Specs: `ticket-files.spec.ts` (track parse + patch), `commands.spec.ts`
  (`parseSetTrack`), `normalize.spec.ts` (`recentDoneOf`),
  `work-groups.spec.ts` (the groups, `needKindLabel`, `runningStepOf`,
  `ageWords`, the Needs-you lines), `work-panel.spec.ts` (the DOM),
  `icon.spec.ts`, `e2e/work-panel.spec.ts` (the groups, kind chips, the
  decision bar).

### Fix — the gate typechecks what the build compiles

**Not yet manually verified by the owner.** Owner request, outside the
list (2026-10-31, review of the req-75 chain). Milestone 90 (W2) passed
`npm run test:all` but broke the app build: `run-composer.ts` handed
`string | null` where the renderer bundle's typecheck wants `string`.
`npm run typecheck` never compiled the plugins' own build configs, so
no gate could see it. Fixed the type (`[string, string | null]`) and
added `plugins/tsconfig.main.json` and `plugins/tsconfig.renderer.json`
to `npm run typecheck` (six configs now; CLAUDE.md and
`docs/agents/fleet-worker.md` say so) — every ticket's gate runs it.

### Milestone 90 — req-75 W2: Questions carry their context

**Not yet manually verified by the owner.** Ticket T-0059 (roadmap
req-75 W2; [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md)
decision 4). A worker asks in a fixed shape — the question, what the
ticket is about, where it stands, why it asks, two to four options with
their consequences, a recommendation — and every surface that answers
shows the shape and answers it with one tap, so a question can be
answered cold after a context switch. A question in another form still
shows as plain text with a free answer (req-64 unchanged).

- **The shape** (`ASKING`, `plugins/tickets/main/fleet/assignment.ts`):
  every dispatched run's instruction now tells the worker the exact
  lines and carries an example; `docs/agents/fleet-worker.md` says the
  same.
- **The parser** (`shared/question-shape.ts`, pure): both providers run
  `parseShapedQuestion` on the text after `QUESTION:` when they build
  the wait; the result rides it as `RunWaiting.shaped`. Total and
  tolerant: never throws, caps every field at 500 chars, case-insensitive
  labels, `- ` prefixes, ` — `/` - `/`: ` separators, unmatched lines
  ignored, a recommendation naming no option dropped; no 2–4 numbered
  options → no shape at all.
- **Answering in one tap**: the Needs-you row in the Work panel shows
  the option buttons (label only, the consequence as the tooltip, the
  recommended one marked) under an `Asks: <question>` status line; the
  ticket thread's wait card and the phone (Needs you and the run view)
  render the full shape with one button per option. A tap sends
  `<n>. <label>` (`answerText`) through the ordinary `send` path and
  disables the buttons; the free-answer field stays beside it
  everywhere. `NeedItem.shaped` carries the shape to the phone.
- Specs: `shared/question-shape.spec.ts` (the example parses, tolerances,
  caps, never throws), one shaped case per provider in
  `main/fleet/providers.spec.ts`, the ASKING shape pinned in
  `main/fleet-fields.spec.ts`, the row's option buttons in
  `renderer/work-panel.spec.ts`, the phone's one-tap answer in
  `remote/dom.spec.ts`. Docs: `specs/classifier-spec.md` (the new
  question-shape section), the manual's Tickets chapter, docs/06 §6.73.

### Milestone 89 — req-75 W1: the Work panel replaces the kanban board

**Not yet manually verified by the owner.** Ticket T-0058; owner request,
outside the list (2026-10-31); [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md)
is now accepted. The Tickets panel is the **Work** panel: no columns,
lanes, column brakes, drag and drop or order pins — one list in three
foldable groups that reads in a side dock (~240–340 px):

- **Needs you** (shown only when not empty): a worker's question
  (*Asks: …* + **Answer**), an approval (**Review**), a red gate or a
  failed run (**Open**, **Run again…**), a checkpoint (**Approve →
  *next phase*** + **Refine with agent**), and every ticket in the
  terminal phase with **Accept** — the ticket goes to the archive. A
  ticket sits in one group only; Needs you wins (owner, 2026-10-31).
- **Ideas**: the first phase plus the manual phases before the first
  machine phase, by priority, newest first within one; an idea in the
  fleet's queue carries a **Queued** chip.
- **In progress**: everything else up to the terminal phase, closest
  to done first, with the live run's light.

A row is the priority chip (a click changes it — the new `setPriority`
command, one commit), the title and one status line. A click opens the
**ticket page**: the file in the editor and its **thread** beside it —
one tab (`tickets-thread`, key `thread://ticket`) that follows the
ticket opened last, showing the ticket's live run (else its newest):
header with **Open run** / **Stop run**, the dialog's end moves, the
transcript and the prompt box with the wait card. Without a live run
the first message starts the phase's interactive dialog. The row menu:
Open ticket / file, **Queue for the fleet** / **Back to ideas**, **Move
to ›** every phase, the run rows, Past runs ›, **More ›** (copy branch,
claim rows, work folder in a terminal), Remove worktree…, Archive…. The
takeover tab stays (Open run) until W4 and shares the composer with the
thread (`run-composer.ts`). Notifications open the ticket page.

- Removed: `card-order.ts`, `column-collapse.ts`, the hide-blocked
  store and the blocked/blocks badges (a blocked ticket says *Blocked
  by …* in its row), the lanes and run-chip helpers in
  `worker-status.ts`, the dwell metrics in `shared/tickets.ts` and the
  status bar's *Avg. time in column*, 119 dead CSS rules; `order.md` is
  no longer read or written (validator check 8 retired), a transition
  carries no drop index. The iPad kanban of the remote stays until W8,
  without pin reordering.
- Specs: `renderer/work-groups.spec.ts`, `renderer/work-panel.spec.ts`
  (jsdom: groups, Accept, Queued, row click vs menu, folding, the
  question row, empty state); the removed helpers' specs went with them.
  e2e: `e2e/work-panel.spec.ts` (English demo vault, screenshots at the
  dock's ~340 px and the full window with the thread open), and
  `ticket-card-menu`, `board-issues`, `interactive-dialog`,
  `ticket-header` moved to the Work rows.
- Fixed on the way: a new ticket id is minted over the archive too
  (`archivedTicketIds`) — ids of archived tickets were handed out
  again (T-0051, T-0052 and T-0053 each exist twice in the owner's
  repo, once archived). The design canvas is in the repo as
  `docs/design/work-panel/` (the reference for the next stages).
- Docs: `specs/ticket-schema.md` (order.md retired, check 8), the
  manual's Tickets chapter, `plugins/tickets/BOARD.md`, docs/05 §5.41
  (Panel — the Work list, Ticket thread), docs/06 §6.64/§6.70 and the
  new §6.73.

### req-66 R10 — Tickets remote: the detail pane and the columns keep their scroll

Not yet manually verified by the owner. T-0056 (owner-reported defect,
outside the list). On the iPad a desk-side change repaints the whole
client view, and with the fleet chain pushing events every couple of
seconds the ticket detail pane — and every column list — snapped back
to the top while being read. The strip's scroll memory
(`kanban.ts`) now covers all three scrollers:

- **Per-scroller memory.** A `scroll` listener on each `.kcol-list`
  (keyed by its `data-phase`) and on the `.detail` pane records the
  tops; one `requestAnimationFrame` after the build restores them —
  remembered tops first, the selected card's `scrollIntoView` reveal
  last, so the reveal still wins where they overlap. Parity with the
  desk board's `restoreScroll`, which keeps the board's and its
  columns' scroll the same way.
- **Fresh content starts at the top.** A different selected ticket or
  a different tab resets the remembered pane top — the phone's
  route-change repaint-at-0 behaviour, mirrored.
- Complementary to T-0053's view-keyed repaint guard (merged into the
  base meanwhile): rarer repaints, and the ones that remain keep their
  position.
- e2e: the fixture's T-0053 grows a twelve-paragraph Description (the
  pane genuinely overflows at iPad-landscape height; every string other
  tests assert stays byte-identical), and the iPad spec scrolls the
  pane, lets a desk-side move repaint, and asserts the new pane is back
  where the reader was. The move — not a revision bump — is the
  trigger: the guard skips a repaint when nothing visible changed.
- Repaired on the way: R4's stop assertion in `e2e/tickets-remote.spec.ts`
  was stale against the req-66 follow-up's ended-run reopen composer
  (the suite failed on the untouched base); it now pins the Stop button
  gone and the reopen field there. Manual: the "On an iPad" paragraph
  says the pane and the columns keep their scroll while the board
  redraws live.

### req-74 — Due-date reminders

**Not yet manually verified by the owner.** The `📅` date was parsed and
sortable, but nothing notified. The Tasks plugin now shows **one system
notification per local day** — a counts-only digest, never one toast per
task — when open tasks with `due <= today` exist across every registered
vault (the main-side all-vaults index; the panel's All scope shows the
same set). Done and future tasks never notify.

- **When it evaluates:** whenever the task index settles — the boot
  sweep's `index-updated` push and every save / write / refresh re-pull
  (the end of the panel's `refreshVault`) — and once a minute while Drey
  runs, so the midnight day rollover is caught. The day is stored as
  `remindersLastDay` in the plugin config **only when a notification
  actually fired**: a disabled switch, an already-reminded day and an
  empty digest (the boot check before the index settled) never burn the
  day — and a fired digest counts even when the system shows nothing
  (`ui.notify` resolves false on denied permission, so it cannot
  re-fire on the next save's push). The notification carries
  `tag: 'tasks-due'`, so a later digest replaces the earlier toast; a
  click brings Drey to the front and reveals the Tasks panel.
- **While Drey is closed** nothing fires (no background process, no
  OS-scheduled toast): the next start's digest covers due-today and
  every open overdue task, so a missed reminder arrives once, late —
  not once per missed day.
- **Wording:** "Tasks due today — 2 due today, 4 overdue" when both,
  "1 task due today" / "3 tasks due today" when only due today,
  "Overdue tasks — 1 task is overdue" / "4 tasks are overdue" when only
  overdue.
- The digest reads the **disk index**, never open buffers — a task due
  today in an unsaved buffer counts after its save. Reminder state
  lives in the plugin config, never the panel's localStorage view
  prefs.
- Settings → Tasks ("Due-date reminders", default on) turns it off.
  Rejected alternatives: app-internal toast chrome, OS-scheduled
  reminders for the closed app (`decisions.md`).
- Implementation: `plugins/tasks/renderer/reminders.ts` (pure digest +
  `startReminders` controller with injectable seams — clock, tasks,
  settings, notify) + `reminders.spec.ts` (20 DOM-free cases), and
  `settings.ts` — the plugin's first Settings page (manifest 1.2.0,
  permissions + `settings`; `ui.notify` needs no permission). Manual
  §6, `docs/05` §5.0, `docs/06` §6.70 updated.


Renumbered from req-65 at merge: while T-0012 was in review, main
shipped its own req-65 (interactive runs, ADR-0084) and req-66 (the
tickets remote, ADR-0086), so the merged record takes the next free id,
req-74. The branch and the ticket file keep the review round's req-65
wording.

### Milestone 88 — the M76 tool-loop follow-ups: streamed answers, abort, the web_fetch guard, post-hoc replay

**Not yet manually verified by the owner.** The four milestone-76
follow-ups the roadmap carried ([ADR-0071 later
change](../docs/09_architecture_decisions/0071-unified-vault-toolset-and-agent-loop.md)).

- **A tool-carrying answer streams.** Both HTTP providers now send every
  round of the tool loop with `stream: true` when the caller asked for
  streaming: text arrives as deltas — interim text before a tool call
  included — and the loop, not the provider, owns the forwarding, so a
  final round that did not stream still arrives as exactly one call
  with the full text. Pure SSE sinks
  (`shared/llm/stream-assembly.ts`) merge the frames of both dialects
  into the canonical reply. A streamed round the endpoint answers with
  HTTP 400 is retried non-streamed once and the call's rounds go
  non-streamed from there (some local servers take tools only
  unstreamed); streamed rounds report no usage.
- **The cancel reaches the tools.** A cancel no longer waits for the
  tool call in flight: `onToolCall` gains the ask's abort signal as an
  optional third parameter (SDK `PLUGIN_API_VERSION` minor 1.35 →
  1.36), the loop hands it to every call and stops queued calls of an
  already-cancelled ask, `VaultTools` refuses a cancelled call and lets
  aborts through instead of flattening them into `Error:` text, and
  every wait on the user — the diff confirm, a move or delete
  approval, a template confirm — races the signal: a cancel during the
  dialog writes nothing. An already-open dialog stays until answered
  (the ADR-0011 dialog has no dismiss seam; the raced answer is
  discarded — the residual gap stays on the roadmap's M78 line).
- **`web_fetch` guards the local network.** Every hop of a fetch is
  address-checked before anything is fetched: literal private/special
  IP ranges (v4 and v6, IPv4-mapped included),
  `localhost` / `*.localhost` / `*.local` / `*.internal` without a
  lookup, every other name through a DNS lookup refused when ANY
  address is private, and redirects are followed manually (≤ 5 hops, a
  relative `Location` resolved per hop) so each hop is guarded — a
  refusal is `Error:` text for the model; the SearXNG instance address
  stays unguarded (the M79 follow-up, out of scope here).
- **The post-hoc task block replays as a text note.** The synthetic
  `tasks_list` pair the app appends when an answer talks about tasks
  (57b/57c) no longer replays to the model as a call it never made: the
  pair is dropped from the tool replay and its records ride after the
  turn's answer as a bracketed note through the usual 2 000-character
  cap. A real `tasks_list` call still replays as a call; the persisted
  note format is unchanged.

Specs: `shared/llm/stream-assembly.spec.ts`,
`electron/llm/tool-loop-streaming.spec.ts`,
`electron/llm/tool-loop-abort.spec.ts` (the real chain through
`buildLlmContext` and `runToolLoop`),
`electron/mcp/vault-tools-abort.spec.ts`,
`electron/mcp-client/web-fetch-guard.spec.ts`,
`plugins/assistant/shared/chat-replay-posthoc.spec.ts`; both provider
specs cover the streamed tool round, the 400 fallback and the unchanged
non-streaming path; the post-hoc note text is in
`specs/classifier-spec.md`.

### fix — the assistant button at a selection shows on a freshly opened note

**Not yet manually verified by the owner.** Owner request, outside the
list (found by the e2e run before the req-66 push). Selecting text in a
note that had just been opened showed no assistant button (milestone
74) until the editor lost and regained focus: opening a note focuses
the editor and dispatches right after, and CodeMirror drops its
focus-change transaction when another transaction lands first, so the
button's gate never learned the editor had focus. The gate is now
checked against `view.hasFocus` on every editor update and corrected
in a microtask (`plugins/assistant/renderer/selection-button.ts`).

Specs: the existing e2e `assistant.spec.ts` "a selection shows the
button…" is green again.

### fix — req-66 follow-up: a run follows a moved ticket; every run takes a message

Owner-verified (signed off 2026-10-31). Owner request, outside the
list. T-0054 refused "already has a live run — stop it first" although
no run was live: the owner moved the card (build → review → commit,
from the phone) while its run went on, the runner kept writing to the
old path (`ENOENT`) and its end never cleared the `run:` stamp — a
stamp no surface could stop.

- **The runner follows the ticket.** `RunSupervisor.patchTicket` looks
  the ticket up by id in every phase folder when its path is gone
  (`relocateTicket`) and points the run there, so Log lines and the
  stamp clearing land; the success move skips when the owner already
  moved the card (that move stands, no second one).
- **A leftover stamp heals on Run agent.** `startRun` clears a `run:`
  stamp whose run record settled with an end time (a down runner's
  synthetic `stopped` has none) — one Log line, one commit — instead
  of refusing.
- **Every run takes a message.** `POST /send` to an ended run
  (done/stopped/failed) with a session reopens it under a new held run,
  the message as its first prompt (`rung: resume`, the new `runId` in
  the reply). The phone's run view shows **Message to reopen the run…**
  on ended runs and follows to the new run; the desk's takeover tab
  keeps its prompt box open after the run ended and opens the new
  run's tab.

Specs: `runs.spec.ts` — a prompt to an ended run reopens with the
prompt; a ticket moved during the run is followed, its stamp cleared,
no second move. Manual "Following a run", `plugins/tickets/FLEET.md`
route table.

### fix — T-0053: the tickets remote paints only what changed (req-66 follow-up)

Owner-verified (signed off 2026-10-31). The remote's display
flickered as if the page loaded twice. Both causes sat in the phone
client's repaint guard (`render()`), whose key embedded more than the
page shows:

- **Startup / wake double paint.** The key embedded the connection
  flag; the first paint happened while `/api/events` was still
  connecting, and the connect — with `Api.listen`'s catch-up refresh
  250 ms later — tore the identical page down and rebuilt it. The same
  strike after every phone wake (reconnect → catch-up).
- **Live-run ticks.** The key embedded the raw board/fleet/needs JSON,
  so a running worker's tick (`activity`, token counts — nothing the
  Needs or Board page renders) repainted the whole page every few
  seconds although nothing on it changed.

`dom.ts` gains `bodyKey(view)` — the built view serialized (title,
body nodes, actions); `render()` repaints only when that key moves,
and the skip path still refreshes the header chip and the tab bar
(connection state, needs badge — node swaps outside the key). Visible
changes paint exactly as before, and a visible age bucket flipping
("13 h" → "14 h") repaints, as intended. `Api.listen`'s connect-time
catch-up stays as it is: it is free now, and still covers changes
missed while a first connect is slow.

- `plugins/tickets/remote/dom.spec.ts` (new) — the key's contract:
  stable across rebuilds, blind to `connected` and a live run's
  activity/token tick while the run is on the page, moved by a
  card-title or needs-list change.
- `e2e/tickets-remote-repaint.spec.ts` (new, own service on 47862) —
  startup paints exactly once (the event stream held back 600 ms so
  the first paint is deterministically offline), a desk-side run tick
  the page does not render paints nothing, a desk-side board move
  still paints. Paints are counted by a MutationObserver on `main`;
  on req-66's guard the legs measure red (2 startup paints, +1 per
  tick). The desk fixture gains `touchFleet(patch)`.
- docs/06 §6.71 — one sentence: the `event: board` re-fetch repaints
  only when the built view's serialized output changed.

### req-66 R8 — Tickets remote: images from the phone, the run view's pinned header

Owner-verified (signed off 2026-10-31). Owner request, outside the list (ADR-0086, later change):

- **Images into the phone's text fields.** An image pasted into
  Capture's Description or the refine view's Description/Plan — or
  picked through the new **Image** button under the field — uploads to
  the desk (base64 in JSON on the existing API,
  `POST /api/attachments`), is saved into the tickets vault's new
  reserved `tickets/attachments/` folder (`img-<stamp>-<rand>.<ext>`,
  type sniffed from the magic bytes — PNG, JPEG, GIF, WebP, ≤ 6 MB,
  never from a client-sent name) in exactly one commit
  (`tickets: attachment <name>`, no Log line — the Log lives in ticket
  files and an upload touches none), and `![](../attachments/<file>)`
  is inserted at the caret, followed by a bubbling `input` event so the
  refine draft saves. Acceptance criteria keep the affordance out (an
  image line would corrupt the gate); the desk shows the images as
  ordinary vault files. The gateway's body cap grows for this one route
  only (12 MB instead of 64 KB).
- **The run view's header stays put.** The run page opened with
  `followTail`, so the ticket title and the meta row (state, model,
  tokens, `started … ago`) scrolled away and never came back while the
  run streamed. Title + meta now sit in a sticky `.runhead` under the
  top bar — CSS only, because the 3-second live repaint rebuilds the
  DOM.
- **One composer button.** The run view's **Send** and **Stop** are one
  button now (owner request, in-run): with something typed in **Steer
  the run…** it is **Send**, over an empty field it is **Stop** (armed,
  two taps) — the composer keeps one narrow row.
- The phone does not display the images yet (an `<img>` cannot send the
  bearer token); an authed asset route plus the phone's markdown
  rendering is the recorded follow-up.

Specs: `main/commands.spec.ts` (the attachment parser: four magic-byte
types, the extension derived from the bytes, refusals for text bytes /
non-base64 / > 6 MB), `main/remote/router.spec.ts` (the route: ok path
with `owner@<device>`, a parser refusal as `{ ok: false }`, behind
auth), `main/remote/drey-port.spec.ts` (delegation with the actor, a
failed commit as a warning); `e2e/tickets-remote.spec.ts` (a picked PNG
in Capture → `#cap-desc` contains the embed, the call recorded with the
device actor; the run header still pinned after scrolling the
transcript to its end). Docs: ticket schema "Attachments (req-66 R8)",
manual "Images" and the run paragraph, ADR-0086 later change. In-run
owner addition: the composer's combined Send/Stop button (R4 case
extended: one button, Stop over an empty field, Send with text typed,
back to Stop after the send).

### req-66 R9 — Tickets remote: markdown in the reading surfaces, Run agent jumps to the run

Owner-verified (signed off 2026-10-31). Owner request, outside the
list (ADR-0086). Basic markdown renders where the phone/iPad client
reads ticket and worker text, and starting a run opens it:

- **One canonical inline parser** — `parseReplyInline`, `ReplySpan`
  and `splitRow` moved verbatim from `renderer/transcript-text.ts`
  into `plugins/tickets/shared/markdown.ts`; the desk renderer imports
  them (behaviour unchanged), the client buys its bold/italic/`code`
  spans from the same source (share, don't copy).
- **Block model** (`remote/model.ts`, breaking for the client-internal
  `Block` union): `blocksOf` additionally reads pipe tables (header
  row + `---` rule + body rows, cells via `splitRow`), `---` rules
  and in-section `####`+ headings; `p` keeps its space-joined
  soft-break text. A lone table-rule line stays a paragraph.
- **DOM builder** (`remote/markdown.ts`): `markdownBlocks` /
  `renderMarkdown` build the blocks as nodes through `h()` and
  `textContent` only — never `innerHTML`, ticket and worker text is
  untrusted (pinned by a literal `<img onerror>` spec case). The
  ticket view (and the iPad detail pane) renders through it, keeping
  the `.box`/`.box.done`/`.li-log` chrome and the Log tab's dotless
  look; the transcript's `text` and `result` rows render their
  markdown (the result's `---`/`**✓ Turn finished**` included) while
  `step`/`you`/`thinking`/`setup`/`error` stay plain — desk parity.
  Tables sit in an `overflow-x` wrapper so they are visible on a
  phone; the rendered container owns whitespace (the rows'
  `pre-wrap` would double-space it).
- **Run agent jumps to the run**: the primary button POSTs
  `/api/runs` and, on `ok`, switches to `#run/<runId>` (`#runs` when
  a host omits the id); a refusal or network error toasts the same
  text `ctx.act` shows. The success toast is dropped — the view
  switch is the feedback.
- Found by the e2e round: the iPad drag test failed on the untouched
  base here — the detail pane's reveal centers the selected column
  and pushed the source card off screen, so the press landed outside
  the viewport (verified against a pristine R6 build). The drags now
  scroll the source card into view before anything is measured, and
  the last scroll waits out the reorder's strip rebuild; no assertion
  changed.

Numbered R9 because T-0054 (images on the phone) built first and
claimed R8.

Specs: `plugins/tickets/shared/markdown.spec.ts` (moved cases),
`remote/model.spec.ts` (the new block kinds),
`remote/markdown.spec.ts` (jsdom: spans, table DOM, checkbox + inline
mix, no-HTML), `e2e/tickets-remote.spec.ts` (rendered strong/em/code/
table; after Run agent the hash is `#run/run-2`, the title
`T-0050 · Run`, the transcript's bold visible, Back returns to the
ticket). Docs: docs/05 §5.0 (takeover transcript + remote client
rows), manual "The board from a phone or tablet".

### req-66 R6 — Tickets remote: the iPad board

Owner-verified (signed off 2026-10-31). Owner request, outside the list
(ADR-0086). From tablet width the Board is a kanban:

- **≥ 768 px**: every column side by side in a sideways-scrolling strip
  (snap per column, the scroll position kept across live redraws), each
  column with its count/WIP, the checkpoint or Playing/Held chip
  (opens the column sheet) and its own vertical scroll.
- **≥ 1100 px** (landscape): the tapped ticket opens in a detail pane
  beside the strip — the phone's ticket view with its action bar — the
  selected card outlined and scrolled into view; the phone ticket page
  stays for narrower screens.
- **Press and hold to drag** (350 ms; moving earlier is a scroll): the
  card lifts as a ghost, a blue marker shows the landing, the strip and
  the column scroll near their edges; a drop in another column is a
  `transition` with the landing index, within the column a `reorder`
  pin, a drop in place nothing — the index counted without the dragged
  card, as the desk's board does (`dropIndexOf` / `dropActionOf`).
  While lifted, a non-passive `touchmove` keeps Safari from scrolling;
  pointer capture keeps a release outside the strip from leaving a
  drag behind.
- Found by the e2e round: a live redraw during the hold replaced the
  strip under the finger and lost the drag — redraws are now held from
  the first touch, not from the lift.

Specs: `remote/model.spec.ts` (drop index and action);
`e2e/tickets-remote.spec.ts` iPad case (iPad Pro 11 landscape: eight
columns, tap selects into the detail pane, drag across columns with the
index and the device actor, reorder within Build, an early move is a
scroll). Docs: docs/05 §5.41, manual "On an iPad".

### req-66 R5 — Tickets remote: refine from the phone

Owner-verified (signed off 2026-10-31). Owner request, outside the
list (ADR-0086, later change). Description, Plan, Acceptance criteria
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
- **Deviation from ADR-0086 as first written**: the remote was to refuse
  a refine while the ticket is dirty in a Drey tab, but no plugin seam
  reaches open tabs. It relies on ADR-0060 like every board write; the
  SDK seam is a roadmap follow-up. `specs/ticket-schema.md` records the
  refine commit and Log line.

Specs: `main/ticket-refine.spec.ts`, `parseRefine` in
`commands.spec.ts`, the refine route in `router.spec.ts`, the port in
`drey-port.spec.ts`, `remote/model.spec.ts` (section text);
`e2e/tickets-remote.spec.ts` R5 case (save, a desk-side change refused
with the draft kept through Reload, the header priority). Docs: ADR-0086
later change, docs/05 §5.41, docs/06 §6.71, manual.

### req-66 R4 — Tickets remote: runs on the phone

Owner-verified (signed off 2026-10-31). Owner request, outside the list (ADR-0086). The phone
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

Owner-verified (signed off 2026-10-31; the automated round runs
Chromium at iPhone size, WebKit is not part of the toolchain). Owner request, outside the
list (ADR-0086). The gateway now serves a real client instead of the
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

Owner-verified (signed off 2026-10-31). Owner request, outside the
list (ADR-0086). The tickets plugin now serves the board over HTTP to
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
  as in ADR-0086; a board refusal stays a 200 with `{ ok: false }`.
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
survives a reload, no CSP errors). Docs: docs/05 §5.41, docs/06 §6.71,
manual "The board from a phone or tablet", FLEET.md.

### req-66 R1 — Tickets remote: command layer and port

Owner-verified (signed off 2026-10-31). Owner request, outside the
list (ADR-0086). The first step of the tickets remote, behaviour-neutral
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
`remote/drey-port.spec.ts` (16 cases). Docs: ADR-0086, docs/05 §5.41.

### req-72 — Projects, multi-repo tickets, the repositories settings

Owner-verified (signed off 2026-10-30). Owner request, outside the
list. Four owner asks shipped as one round (2026-10-30):

- **Refine in every manual column** (req-65's column rule, amended in
  `end-moves.ts`): the first automatic column still plans; every manual
  column now refines — the queues before the first automatic column
  included, and a board without any automatic column offers the dialog
  everywhere but the terminal. Automatic columns (`agent`, and `ci`
  counted as one) offer no dialog: the runner works them. The last
  automatic column therefore loses its refine offer. End moves are
  unchanged — before the first automatic column only "On to" exists.
- **"Add Drey's prompts" reachable when the folder is not empty**
  (`settings-prompts.ts`): the restore offer lived only in the empty
  state, so a vault seeded before a prompt shipped could never re-add it
  — the interactive run's error message pointed at a button that did not
  exist. The section header now carries the button whenever shipped
  prompts are missing from `_meta/prompts/`, with the count and names.
- **Repositories settings** (`settings-repos.ts`, new): Settings →
  Tickets gains the `_meta/repos.md` registry as editable rows — name,
  url, branch, local path, policy, worker, worktrees base, `link:`
  folders — one commit per save, the owner's prose under the frontmatter
  kept. "Add from folder…" picks a folder, probes it (itself and its
  non-hidden subfolders) for git repositories over real git
  (`repos-scan.ts`: `.git` entry, origin remote, current branch) and
  offers the found checkouts as seeds; already-registered paths are
  marked.
- **Projects (req-72 naming): one tickets vault is one project.** The
  board panel header gains a project switcher (every registered vault
  with `tickets/_meta/pipeline.md`); switching writes the existing
  `vaultId` plugin config and the board follows on the next refresh.
  `listProjects`/`switchProject` are plugin IPC; the active project is
  what `detect()` already picked — the switch makes it explicit.
- **Multi-repo tickets**: a ticket's frontmatter may carry
  `repos: [a, b, …]` beside the legacy `repo:` line (which stays the
  primary); the list wins when both are set and a mismatch is a noise
  finding. The fleet prepares one worktree per named repo — all on the
  ticket branch, base per repo (`branch:` or HEAD, `link:` folders
  honored) — refuses the run when an extra repo has no local `path:`,
  names the extra checkouts in the brief, and removes them again with
  "Remove worktree". The primary repo keeps its role: gate cwd, worker
  pin, context pack (instructions, diff stat), the run record's
  worktree, "Open work folder". The card chip and the header show every
  repo; the create modal and the ticket header take checkboxes, the
  first checked one is the primary. Tests: `repos-scan.spec.ts`, the
  writer round-trip in `ticket-board.spec.ts`, parse/patch/create in
  `ticket-files.spec.ts`, the multi-repo compose in `request.spec.ts`,
  the amended column rules in `end-moves.spec.ts` (618 → 629 specs).

### req-71 — Settings → Tickets: each CLI runner's settings behind a switch

Owner-verified (signed off 2026-10-30). Owner request, outside the
list. The Fleet section listed every fleet setting in one column, so a
setting for one runner looked as if it applied to every runner:
OpenCode pool, OpenCode pool probe and Claude Code pool sat in one list,
and *Dispatched-run permissions* looked shared although only the Claude
Code adapter reads it (`--permission-mode`); OpenCode takes its
permissions from its own config and asks on the card (req-64). The
per-provider compact-threshold overrides T-0049 reads
(`fleet.compactAboveTokens.<provider>`) had no UI at all.

- **Fleet** keeps the shared settings: default worker, git executable,
  the four output caps, the shared resume compact threshold and the
  resume pause TTL.
- **Workers** (new, `plugins/tickets/renderer/settings-workers.ts`) has
  an OpenCode | Claude Code switch. It opens on the default worker's
  runner and shows the selected runner's fields:
  - OpenCode: pool size, pool probe, compact-threshold override.
  - Claude Code: pool size, dispatched-run permissions,
    compact-threshold override.
  An empty override uses the shared threshold.
- No config key changed, including `autoPermissionMode`. Nothing on the
  main side changed either, so existing settings carry over as they
  are. The kv/config field helpers moved from `settings-page.ts` to
  `settings-dom.ts`.

Specs: `plugins/tickets/renderer/settings-workers.spec.ts`. It pins the
table to the keys the main side reads per provider: probe for OpenCode
only, permissions for Claude Code only, unique control ids. Docs:
`plugins/tickets/FLEET.md` (handover config), the manual §13.

### Fix — fleet: run events fold in arrival order (the req-67 clock-freeze flake)

Follow-up of req-67. Its "the clock freezes when the run ends" spec was
flaky — 1 in ~3 full-suite rounds red on an otherwise untouched checkout
(seen during the req-65 merge). `RunSupervisor.onEvent` folded the req-67
busy spans after the event's stream append, so two events fired
back-to-back could resume out of order and the older event's fold landed
last-writer on the record: the newer busy stamp was lost (`execSince:
null` where the busy stamp was expected). A real provider fires the same
bursts (a usage event immediately followed by `turn: 'idle'` + waiting),
so the race could regress a live run's `turn`, `waiting` and token
counters, not just a test. Now:

- **`runs.ts`**: the async half of an event — stream append, fold,
  record write, the waiting Log line — queues per run
  (`LiveRun.eventQueue`); events fold strictly in arrival order. The
  synchronous prefix (`agentDone`, the telemetry fold) stays at arrival,
  as the racing-exit comment there requires.
- **`runs.ts`**: `persist` snapshots at call time and queues the
  `run.json` write per run (`LiveRun.writeQueue`) — an older snapshot
  can no longer land after a newer one on fs-timing luck (the record is
  what a restart's `adopt` reads).

The spec keeps its rapid-fire pair as the regression test (a comment now
says why), and two events can no longer append to `stream.jsonl` out of
order either. Specs: `plugins/tickets/main/fleet/runs.spec.ts` (the
rapid-fire pair; the fleet suite 314 tests green, the flaky spec 20
consecutive rounds green). Owner-verified (signed off 2026-10-30).

### req-70 — The ticket card's context menu, regrouped

Owner request, outside the list (2026-10-30). The card menu had grown to some twenty rows — up to eight
"Past run — …" rows in the middle of the actions, a terminal row as wide
as the repository path, both claim rows always listed with one greyed
out, and no keyboard navigation.

- **Past runs ›** (`plugins/tickets/renderer/index.ts`, `appendSubmenu`):
  one row with the count opens the finished runs beside the menu —
  phase · how it ended (failed in red, stopped muted) · `MM-DD HH:MM`,
  newest first, up to 15 (was 8), scrolling past 60 % of the window
  height; a row opens the run's transcript read-only, as before. Hover,
  click, Enter or ArrowRight opens it, ArrowLeft / Escape goes back; it
  flips to the menu's left side when the window has no room on the
  right. No row when the ticket has no finished runs.
- **Groups**: file and branch · work folder and worktree · order ·
  agent · claim · Archive, separated. "Open work folder in terminal"
  names the path in its tooltip instead of its label.
- **Claim rows that apply only**: a free ticket offers **Claim**, one
  you hold **Release claim**, somebody else's **Take over claim** and
  **Release claim** — the same `claim` calls as before.
- **Keyboard**: ArrowUp / ArrowDown move through the enabled rows (the
  header `⋯` menu shares the helper, `cycleMenuFocus`); every row is a
  `menuitem`.

Renderer only, no SDK, IPC or format change. Manual: the board section's
context-menu paragraph. e2e: `e2e/ticket-card-menu.spec.ts` (finished
runs pushed as a `fleet-changed` snapshot — the submenu, its keyboard
round trip, the claim rows for a free, an own and a foreign claim).

### req-69 — The board's view controls move into the Tickets header

Owner request, outside the
list. req-73 (then numbered req-66) had left one toolbar row above the columns holding only the
hide-blocked filter and the board issues chip — a whole line of panel
height for two small controls. Both now sit in the panel header as one
group (`boardViewControlsNode` in `plugins/tickets/renderer/index.ts`,
between the fleet status and New / Refresh), repainted with every board
update; the filter is an ordinary `.icon-btn` whose pressed state is
`aria-pressed`. The unfolded issue list still opens above the columns.
The `.tickets-toolbar` row and its CSS are gone. Fixed on the way: the
header's controls sat about 4px above the title since req-62, whose
editor ticket header (`ticket-header.css`) also used the class
`.tickets-head` — `display: block` and a 14px bottom padding leaked into
the panel header. The panel header's host is now `.tickets-panel-head`.

Specs: `e2e/board-issues.spec.ts` now finds filter and chip in the
header and checks they are centred on the title's line (within 2px).

### req-65 — Interactive mode at the plan phase and every checkpoint

Owner request, outside the
list (2026-10-30). Some steps the owner wants to do *with* a worker, not
hand to one — and until now the board had no way in: "Run agent" starts
a machine-shaped run (the worker alone, gate, auto-move), and takeover
(ADR-0079) presupposes one that is already going. Now a run can be
**interactive**: the owner's dialog from turn one.

- **The run** (`plugins/tickets/main/fleet/`): `RunRequest.interactive:
  'plan' | 'refine'` (ADR-0084) — held at spawn (`setHold` before the
  first turn ends, the `reopened` mechanism's sibling), and at its end,
  however the worker exits, neither the gate nor a move runs: the owner
  moves the ticket. The brief's completion discipline is replaced by a
  dialog discipline (end turns with a question, never claim a move); the
  `QUESTION:` asking protocol (req-64) is the interview loop. The start
  still lays the `run:` stamp plus **`interactive: true`** on the ticket
  (new frontmatter field), which keeps the dispatcher off the ticket
  between dialogs (`dispatchable` refuses it, the log says
  `dispatch holds <id>: reserved for an interactive dialog`); any board
  move drops the field. Reopening the session ("Resume session")
  continues the dialog later.
- **The prompts**: two shipped seeds —
  `plan-interactive-default.md` (plan-default's output discipline,
  interview-first: 2–4 focused questions up front, propose in the chat,
  write only the agreed result) and `refine-interactive-default.md` (one
  phase-aware checkpoint companion: verify together, owner-approved
  fixes as small commits on the branch, the verdict in the Log; at
  commit also the push). A phase's `interactive:` key in `pipeline.md`
  overrides the default per column; the acceptance-criteria refusal
  lifts for interactive runs.
- **The board** (`plugins/tickets/renderer/`): **Plan with agent** on
  the plan column and **Refine with agent** at the checkpoints and the
  last agent column (`end-moves.ts`, pure — offered in the card menu and
  the req-62 ticket header, one click, no form). The start opens ticket
  and dialog side by side. The takeover tab of an interactive run shows
  the **end moves** (stop the living run, then the ordinary transition —
  an owner move across the checkpoint): a plan dialog *Finish → next*
  and *Approve → past the checkpoint*; a refine dialog *On to next* /
  *Back to the nearest agent column*. Reserved cards carry a **dialog**
  chip; the mode pill reads "Interactive dialog".
- **SDK 1.35** (base seam): `documents.open(path, line?, { split:
  'right' | 'down' })` and `documents.addDoc(kind, key, name, { split })`
  land the new tab in a fresh split pane beside or below the focused
  pane (`DocOpenService.splitLanding`: split first, then add — the new
  pane is focused and `OpenDocsStore.add` always opens into the focused
  pane). A landing request, not a command: an already-open tab still
  just reveals, a focused dock band cannot split (plain open there), and
  a split-open never replaces the focused pane's clean tab — it asked to
  open alongside. `plugins/AUTHORING.md` documents it.

Specs: `plugins/tickets/renderer/end-moves.spec.ts` (the column rules
and end moves), `plugins/tickets/main/fleet/runs.spec.ts` (held from
spawn, stamp + reservation, exit without gate or move),
`chain.spec.ts` (the dispatcher holds reserved tickets),
`request.spec.ts` (dialog discipline replaces the completion
discipline, no move target), `ticket-files.spec.ts` (the field parses
only from a bare `true`; a move drops it, a claim does not),
`default-prompts.spec.ts` (the two new shipped files), and the e2e
`e2e/interactive-dialog.spec.ts` (the switches appear exactly where the
columns offer them). Also repaired on the way: the manual had a
duplicated Workers-strip paragraph (shipped in the req-64 entry), and
req-73's final chip shape had left its e2e expecting the old text.

### req-68 — Clean up worktrees sweeps the link-only leftover folders

Owner request, outside the list (the status bar kept showing "9 legacy
worktrees" after every cleanup). The folders under the legacy base
(`<userData>/plugins/fleet/worktrees/drey-T-*`) were no longer
registered with git and held nothing but the `.tools` / `node_modules`
junctions an older removal left behind. `cleanWorktrees`
(`plugins/tickets/main/fleet/worktree-clean.ts`) worked only from
`git worktree list`, so it never saw them, while the status bar counted
every folder. Now, after the per-repo prune, a sweep walks the bases in
scope (the legacy base on the boot sweep; home + legacy on *Clean up
worktrees…*): a top-level folder that is not registered, not protected
(live run) and not a `.stale-*` / dot folder, and holds only links, gets
its links removed (never followed) and a non-recursive `rmdir`. A folder
with any real entry is not touched and stays listed. The report gains
`leftovers`; the board's cleanup note and both log lines count them.
FLEET.md's cleanup paragraph says so. Specs: `worktree-clean.spec.ts`
(link-only folders swept with the link targets intact; real content,
protected paths and stale move-asides kept; `legacyOnly` leaves the home
base alone). Owner-verified (signed off 2026-10-30).

### req-67 — The elapsed clocks count only working time

Owner request, outside the list. The takeover tab's Elapsed metric ran on
the wall clock since the
run's start: it kept ticking while the worker waited for the owner, while a
held run stood idle, and after the run had ended — and the card's ▶ chip
and its tooltip showed the same wall clock. Now the runner folds the run's
busy spans on every stream event (the same fold pattern as the token
telemetry: a flip of `turn` or `waiting`, req-64, closes or opens a span at
that event's stamp) and the record carries them — `RunInfo.execMs` (the
closed spans) and `execSince` (when the open one began), persisted in
`run.json`, restored on adopt, frozen when the run ends or is detached.
`execClockMs` (`plugins/tickets/renderer/worker-status.ts`) adds the open
span for display; the Elapsed metric (its tooltip says what counts now),
the ▶ chip and the chip tooltip all read it. A record without the fields —
pre-req-67, or a provider that never reports a turn — falls back to the
wall clock, clamped at the run's end so an ended one stops ticking.
Startup counts as working; a turn not yet reported presumes working; the
fleet header's age stays wall clock.

Specs: `plugins/tickets/main/fleet/runs.spec.ts` (a wait closes the span,
the answer reopens it, standing pauses it, the end freezes it on the
record, an adopted detached run is frozen at its last stamp, a re-attached
busy run resumes at the next report without the unwatched gap) and
`plugins/tickets/renderer/worker-status.spec.ts` (`execClockMs` with the
fallbacks, the chip line). Manual: the workers strip and the takeover
paragraph.

### req-73 — Readable board issues, one toolbar row

Shipped and signed off as req-66; renumbered 2026-10-31 when the
tickets remote, which had reserved req-66 on its own branch, merged
into main. Owner request, outside the list. The board's own findings (pipeline / repos / order files) sat in a
full-width bordered box ("2 board issues") whose messages were only a
tooltip, above a second row holding just the hide-blocked filter — three
rows of different heights over the columns. Now there is one toolbar row
(`boardToolbar` in `plugins/tickets/renderer/index.ts`): the filter, then
a chip with the count, coloured by the worst level
(`plugins/tickets/renderer/board-issues.ts`), both 20px high. The chip
unfolds the messages under the row, worst first, each with its level and
an **Open** link when it names a meta file (`tickets/_meta/<file>.md`);
open/closed is view state for the session. The old `.tickets-board-issues`
box is gone.

Specs: `plugins/tickets/renderer/board-issues.spec.ts` (summary and worst
level, sort order, meta-file detection) and the e2e
`e2e/board-issues.spec.ts` (chip and filter at one height, unfold, the
messages, Open opens `order.md`, fold again).

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
  chip reads `▶ running · <turns> · <kIn>/<kOut>` (duration-free, see
  the round-2 bullet below).
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
- **Run duration displays removed again (round 2, owner call).** The
  elapsed-since-`startedAt` number "does not really mean anything",
  and the card chip's tooltip closed and reopened whenever the clock
  tick rewrote its `mm:ss` — so every run-elapsed surface goes: the
  chip text, its tooltip's "so far" phrase, the "running mm:ss"
  summary pill, the takeover stats clock and the lane age span.
  `runChipLine` is clock-free. Column-dwell
  ages, `⌀` column averages and claim ages stay: workflow aging from
  `entered-*` stamps, word-granular, no ticking clock. (Merged into
  `main`, the chip text, the tooltip and the lane age are duration-free
  as planned; the summary pills and the old takeover stats line no
  longer existed there — req-60's panel-header fleet summary and the
  req-58/67 takeover metrics had replaced them and stay as shipped,
  clocks included, so `spanClock` remains exported for those.)

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
