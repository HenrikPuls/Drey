# Build plan — the whole UI as the canvas boards show it

Status: the questions of section 3 were **decided on 2026-11-06 (afternoon)**; the roadmap ids named below exist in `specs/roadmap.md`. Planning state: branch `desktop-integration` @ `7323ac77` (2026-11-06), read-only. Sources: `CLAUDE.md`, `specs/roadmap.md`, `specs/changelog.md` (173 ↓), `docs/design/work-panel/{architecture-concept-v2,convergence-gaps,README,desktop-integration}.md`, ADR-0077/0086/0087/0088/0089/0090, and the code entry points named per row. "Built" below means present in code and specs — **nothing from milestone 97 on is owner-verified**.

Capacity (owner, 2026-11-06, corrected the same evening): **one pool of 6 slots** — a Fable session takes 4, Opus 2, Sonnet 1 (so 1 Fable + 1 Opus, or 1 Opus + 4 Sonnet, or 6 Sonnet); never two sessions on the same files. Waves 1–3 are merged (2026-11-06 evening, `desktop-integration`); the cut-over E14-7 is running with the owner.

**Owner's verdict after wave 3 (2026-11-06 evening): the screens are only structurally similar to the boards, not the same.** The cause is the method, not the items: the sessions built from text briefs and never saw a board. Section 4 is the correction; wave 4 is a fidelity wave, not a feature wave.

## 1. Coverage: board → roadmap / changelog → status

Status: **built** / **partly** / **open** / **unmapped** (no roadmap id exists — do not start without one).

| Board | Realized by (changelog ms. / roadmap id) | Status | Evidence |
|---|---|---|---|
| **Desktop** | | | |
| 7a Work layout | E13-13 (141 first cut), E13-8 (130), E13-5 (138), E13-3 (124); open: E12-11 panel body, E12-15 band + status items, E13-13 rest | partly | `plugins/tickets/renderer/view-preset.ts` (preset, no `assistantTarget`); `index.ts:1177` Board/Crew rows; `status-slot.ts` one item "2 running · 3 need you" |
| 7b Shape | E13-9 (144, Refine removed), E10-1..3 (120–122); open: E13-9b, E10-3b | partly | `ticket-document/shape*.ts`, `conversation/shape-binding.ts` |
| 7c Plan to accept (Parts block) | engine E10-4 (126, routes `parts`/`release`); open: **E13-10 / E12-17** (widget) | open | no "Parts" in `ticket-document/`; `libs/mission-ui/src/plan/approve.*` is the MC version |
| 7d Review tab | E13-7 (139), E13-20 (169 Ticket·Thread·Review strip); open: **req-97** (remove Accept), E12-19 splitter | partly | `review/view.ts:542` still builds the Accept button (`decide('accept')`) |
| 7e Board tab, six columns + Capacity | E13-8 (130), E12-9c (166: Inbox·Plan·Build·Review·Sign Off·Done); open: **req-99** names, E12-16 filter/cost toggle, E12-15 band rule | partly | `board/board-view.ts`; default stages in `packages/tickets-engine/src/migrate/convert.ts` |
| 7f Crew tab | E13-8 (130), E12-4 (115), 173 wording; open: E12-16 (E13-19), **req-95** Autopilot chip | partly | `team/team-view.ts`; no autopilot symbol anywhere |
| 7g Settings like VS Code | E13-12 (146); open: **E13-22** (width, section tree, search), E13-12b, E12-3b, D-17 | partly | `settings/desk-settings.ts`, `src/app/settings/settings-ui.css` (640 px cap) |
| 7h Views Notes·Work·Crew + Layout menu | E13-1/E13-2 (123/127), D-6 (163); open: E12-18 (Layout ▾ replacing dot/save/revert, descriptions, shortcuts, Edit views…) | partly | `src/app/titlebar/view-switcher.html` draws `.vs-mod` dot + save + revert, no Layout menu; views are Notes/Work only (Crew is a tab, not a view) |
| 7i Tabs belong to views | E13-1 (123); open: E12-18 ("Go to the Work view", "2 here · 3 elsewhere") | partly | `src/app/panes/` tab menu, `windows/open-windows.html` |
| 7j Ticket ready to try | E13-6 (129), E11-4 (119, `costTableOf`), E13-20/21 (169); open: **req-97**, **req-98** | partly | `ticket-document/model.ts:199` cost table; `ready-view.ts:160` + `end-moves.ts:69` "Accept → …" |
| 7k Persona setup | E12-4 (115), E13-8 (130); open: E12-16/E13-19 (editable Setup, New persona, Friction) | partly | `team/team-view.ts` tabs 1:1/Memory/Setup read-only |
| 9a Drey cleaned up (28 px dock headers, ticket card, Assistant without rail) | ticket card: E13-20 (169); Assistant row: owner-fixed 2026-11-05 (E12-19 note); **dock header height and panel chrome: no item** | unmapped | `--panel-head-h` = 32 px in `src/styles.css` / `dock/`; owner layout png `assistant-owner-layout-2026-11-05.png` |
| 9b Panels redesigned (Calendar, Source control, Outline, Search, Tasks) | **not a target** (owner, 2026-11-06 evening; `specs/decisions.md`; req-105 withdrawn) | sketch only | — |
| **iPad** | | | |
| 5b Shape / 5c Plan / 5d Crew / 5i Flow editor | E10-3 (122), E10-4 (126), E12-4 (115), E10-5 (128); open: **req-96** header + panes, req-98 format, E10-5b, E12-19 wording | partly | `apps/mission-control/src/app/app.html` wide layout = top tab bar Work/Chat/Team/Settings + right dock, not the Notes·Work·Crew header |
| 5f Settings | E12-3 (114), D-2 (135), E12-7 (136/137); open: E12-3b, E12-14, **5-step text size** | partly | `libs/mission-ui/src/theme.ts:66` `TEXT_SIZES = ['S','M','L','XL']` (canvas decision 8 wants S/M/L/XL/XXL) |
| 5h Review | E11-2/E11-3 (117/118); open: E11-2b wide layout, req-97 | partly | `libs/mission-ui/src/ticket/view.html:511` "Accept and merge" |
| 10e Work three panes / 10s portrait | **req-96** | open | `app.ts:97` `wide = (min-width: 768px)`, dock from 1024; no orientation state |
| 10f Mission Control chat | E5b (105), E12-1 (112), E12-8 (149), D-7 (165) | built (header pending req-96) | `libs/mission-ui/src/chat/` |
| 10n Notes / 10r Notes edit | **req-100** (running) → **req-101** | open | no `/api/notes` in `server/router.ts`; `mc-markdown` + `libs/markdown-surface` exist (E12-6, 133) |
| 10q Ready to try | E5c (106), E11 (116–119); open: req-97, req-98 | partly | `ticket/view.*` |
| **Phone** | | | |
| 10a Chat + answer card | 105, 112, 165, 170 (E13-24 app bar) | built | `app-bar/`, `chat/` |
| 10b Menu as root (Search, Notes, Work, Crew, Settings, chats) | E13-24 (170) partly: ☰ opens the chat history with Work/Crew/Settings rows; **root-screen rule (decision 17), Search and Notes rows: no item** | partly / unmapped | `app.html` `.menu-nav` inside `<mc-chat>`; `state.ts:71` `McTab = work|chat|team|settings` |
| 10c Work list | 105, E13-21 (169); open: E12-14 rows, req-99 names | partly | `libs/mission-ui/src/work/` |
| 10d Ticket | 106, E13-23 (169, Live·View·Source switch); open: req-97, req-98 | partly | `ticket/view.html` |
| 10g Settings / 10h Appearance | 114, 136/137; open: E12-3b, 5th text step | partly | see 5f |
| 10i Crew | 115, 173; open: req-95 icon | partly | `team/team.html` |
| 10j Plan to accept | 126; open: req-98 format (`median of n similar runs` today) | partly | `plan/approve.model.ts:119,125` |
| 10k/10l/10p Notes list, view, edit | req-100 → **req-101** | open | — |
| 10m Proposals Confirm/Dismiss | E5a (104) proposal cards; wording not verified against "Confirm/Dismiss" | partly (unverified) | `libs/mission-ui/src/chat/` |
| 10o Ready to try + cost by phase | 106, 119; open: req-97, req-98 | partly | `ticket/view.*` |
| 10t Autopilot (all devices) | **req-95** | open | `fleet/protocol.ts:671` `ChainMaster = 'run' | 'halted'`; `orchestrator.ts:275` persists to `chain.json`; route `/api/chain/master` in `router.ts:672` |
| Main 1 — the flow | concept v2 §5–§6 | reference only | — |

Contradictions noticed in the repo vs the canvas: (a) `apps/mission-control/src/app/app.html:51` still labelled the wide top-nav tab **"Team"** at planning time; milestone 173 on the `claude/crew-accept-rename-d8568c` branch fixes it (Crew everywhere); (b) text size has 4 steps, canvas 8 says 5; (c) the roadmap's E13-13 text and ADR-0089 still describe `assistantTarget` as unset although E13-5 shipped (138) — the preset in `view-preset.ts` indeed names none; (d) the wide (≥768) MC layout is the old tab bar — intended for desktop web (G-37) but it is also what an iPad gets today; (e) `desktop-integration.md` header said E13-11/12/13 "not built" while 145/146/141 shipped (docs drift only; corrected in the docs round of 2026-11-06).

## 2. Waves

Rules: one roadmap item (or a tight bundle) per session; branch off `desktop-integration`; every session owns the files listed and touches no other listed file; the hot file `plugins/tickets/renderer/index.ts` (3,500 lines) is owned by **one** session per wave. Model: Fable = cross-cutting/ADR, Opus = engine/data/permissions/migration, Sonnet = board-specified UI. "Done" always includes: specs/changelog entry, roadmap item removed, tests, manual where visible, and catalog keys for every new string once req-102 has landed (until then: a `TODO(i18n)` list in the PR, migrated by the session itself before merge if the catalog lands first).

### Wave 2 (starts now; wave 1 still running → 1 Fable + 3 Opus + 6 Sonnet free)

| # | Session / branch | Model | Item(s) | Depends on | Owns (files) | Done when |
|---|---|---|---|---|---|---|
| 2.1 | `req-96-mc-shell-panes` | **Fable** | req-96 iPad panes + the phone menu-as-root (decision 17, req-103, part of req-96's scope, Q7) — the MC shell restructure: header with left toggle · Notes·Work·Crew · right toggle, three panes landscape / two portrait, state per orientation per device (D10), phone menu root screen with Search/Notes/Work/Crew/Settings/chats; Notes entry hidden until req-101 | none (concept §7, §8.1 point 5) | `apps/mission-control/src/app/{app.html,app.ts,app.css,api/state.ts}`, `libs/mission-ui/src/app-bar/*`, new `libs/mission-ui/src/shell/` if needed | 1194×834 both orientations and 390×844 match 10e/10s/10b; desktop web ≥1024 keeps its tab bar (G-37); persistence spec |
| 2.2 | `req-99a-state-list-engine` | **Opus** | req-99 engine half: stage vocabulary of the six states `Inbox → Shaping → Prioritized → Building → Ready to try → Done` (stage ids to be fixed by the session; Shaping and Prioritized manual, Building the only agent claim stage, Q6); **named req-99a in the roadmap; lands before the final import of E14-7 (Q1)**, default pipeline, checkpoint rule, migration mapping Plan→Shaping, Build→Building, Review+Sign Off→Ready to try, `legacyPhases`, reverse converter, `dk validate` round trip, schema note deferred to E14-9 | none; **must land before the final import of E14-7** | `packages/tickets-engine/src/{core/pipeline*,core/phase-dirs.ts,services/board-service*,migrate/*}`, `fleet/chain.ts` **only** the checkpoint/claim id lists, `plugins/tickets/BOARD.md`, `specs/ticket-schema.md` (default section) | `convert.spec`, `roundtrip.spec`, `board-service.spec` green with the six stages; old boards untouched |
| 2.3 | `req-95a-autopilot-engine` | **Opus** | req-95 engine half: three-state master + `resumeAt` persisted in `chain.json`, boot rule Off, resume timer, SSE announce, `/api/chain/master` extended, read-only device refused on write and Stop-now; ADR-0077 "later change" | none (strings arrive in 3.x) | `packages/tickets-engine/src/fleet/{protocol.ts,orchestrator.ts,runner.ts}`, `contracts/chain.ts`, `server/router.ts` (master route + needs), `server/drey-port.ts`, ADR-0077 | state machine spec incl. boot + timer + read-only; `fleet_*` MCP tools report the state |
| 2.4 | `e14-7a-cutover-prep` | **Opus** | E14-7a (engine reads config before the mirror) + cut-over guide refresh + the E14-2 findings the cut-over must settle (archive decision `--include-archive`, fresh allow list) | none; execution of E14-7 itself waits for 2.2 | `server/{standalone-host.ts,config.ts,file-config.ts}`, `plugins/tickets/main/` config mirror, `docs/design/dricket/cutover-guide.md` | shadow report describes the new store on first start; guide says one start |
| 2.5 | `req-97-accept-on-the-card` | Sonnet | req-97 all three clients (desktop: Accept lives on both Mission Control surfaces, the Work panel's Needs-you row / Ready card and the decision card in the Assistant conversation, Q2): Review tab loses Accept, gets "Decision waiting · go to the card"; ticket document action bar and Ready strip lose Accept/Send back; MC ticket body loses "Accept and merge" and gets the link; the decision card keeps Accept + Send back (note mandatory) | O-1 decided; Q2 answered | `plugins/tickets/renderer/review/{view,model}.ts`, `ready-view.ts`, `ticket-document/dom.ts` (action bar only), `libs/mission-ui/src/ticket/{view.html,view.ts,ticket.model.ts}`, e2e specs of those | no Accept outside the card on desk/iPad/phone; one e2e per client |
| 2.6 | `e12-11-work-panel-body` | Sonnet | E12-11 (supersedes E13-14): 40 px header row filter · New idea · Open Board tab · grip, Workers cards leave, footer "Crew · Ben, Tessa busy" → Crew tab, Workers tab + Chain log retire, rows per 7a | none | **`index.ts`** (panel part, owner of the hot file this wave), `work-panel.ts`, `work-groups.ts` (layout, not group names), `board.css` panel part, `chain-log.ts` removal | panel matches 7a–7c chrome; group titles still old (req-99b renames) |
| 2.7 | `e12-13-e12-5-mc-chrome-device-rules` | Sonnet | E12-13 + E12-5 bundle: sentence-case sans (33 rules), focus ring, placeholders, insets 47/34, 44 pt targets, 16 px inputs, hover/focus on iPad | none | `libs/mission-ui/src/**/*.css`, `apps/mission-control/src/styles.css`; templates only for label casing, **never** `ticket/view.html` (2.5) or `app.html`/`app-bar` (2.1) | audit table from E12-5 all green; screenshots 390/1194 |
| 2.8 | `e12-18-views-layout-menu` | Sonnet | E12-18 (+E13-18): Layout ▾ menu (save, reset, save as new view, rename, delete) replaces dot/save/revert, menu descriptions + shortcuts + "Edit views…", "Go to the Work view", "2 here · 3 elsewhere", tenth dock icon | D-6 (163) shipped | `src/app/titlebar/view-switcher.*`, `src/app/windows/`, `src/app/panes/` tab menu, `dock/dock-strip*` | 7h/7i strings verbatim |
| 2.9 | `e13-22-settings-vscode` | Sonnet | E13-22: one page width, section tree in the category list, search; Settings → Tickets split into sections per 7g | E12-9c/d labels (166 shipped) | `src/app/settings/**`, `src/app/plugin-host/plugin-settings-host*`, `plugins/tickets/renderer/settings/**`, `settings-page.ts` | every page same width; search filters all pages |
| 2.10 | `e12-15-capacity-statusbar` | Sonnet | E12-15: band only while Board/Crew tab is active, one line; status items "$4.10 today" + "● 3 need you", "in Work" in Notes; title-bar "Capture by voice" (chord ruled: Mod+Alt+T) | SDK status item exists (124) | `team/capacity-view.ts`, `status-slot.ts`, `src/app/status-bar/`, `src/app/titlebar/` **except** `view-switcher.*` (2.8) | 7a/7h status bar matches; band rule e2e |

Wave 2 load: Fable 1 (+req-102) = 2 · Opus 3 (+req-100) = 4 · Sonnet 6.

### Wave 3 (after wave 1 + 2.2 + 2.3 landed; the catalog exists)

| # | Session / branch | Model | Item(s) | Depends on | Owns | Done when |
|---|---|---|---|---|---|---|
| 3.1 | `e14-7-cutover` | **Opus** (owner present) | E14-7: freeze, final import into a fresh store with the six stages, `dk validate` + shadow diff clean, flip `tickets.backend`, smoke, owner round starts | 2.2, 2.4, E12-9c merged (yes) | `scripts/migrate-tickets.mjs`, `docs/design/dricket/*`, the owner's `drey-tickets` repo (owner-triggered only) | board on dricket with the six states; release note |
| 3.2 | `req-99b-state-names-clients` | Sonnet | req-99 client half: display names via catalog keys on desk (`work-groups.ts` titles, `board/board-model.ts`, `phase-colors.ts`, `end-moves.ts` "Accept → Done"), MC (`work.model.ts` groups, badges), phone; Needs-you groups; no Commit/Ideas/Sign Off anywhere | 2.2, 2.6, req-102 | `work-groups.ts` (names), `board/board-model.ts`, `phase-colors.ts`, `end-moves.ts`, `libs/mission-ui/src/work/work.model.ts`, `shared/i18n/*.json` keys | every surface shows the six names only |
| 3.3 | `req-98-e12-12-ticket-page` | Sonnet | bundle: E12-12 header strip (id, status caps, kind chip, persona, step, cost with basis inline) + req-98 cost-by-phase table at the end + estimate formats `$3.00–5.20 · from 3 runs` / `no estimate yet (first run)` (ICU, `Intl` currency) on desk and MC | 2.5, req-102 | `ticket-header.ts`, `ticket-document/{dom,model}.ts` (except shape*), wait/thread views, `libs/mission-ui/src/plan/approve.model.ts`, `ticket/view.*` cost table | 7j/10o/10j/5c texts verbatim |
| 3.4 | `req-95b-autopilot-clients` (built 2026-11-06) | Sonnet | req-95 clients: desktop status-bar item + `Mod+Alt+P` command, iPad header chip, phone app-bar icon + sheet (3 × 56 px rows, Stop-now below), read-only devices see but cannot change; keys `autopilot.*` | 2.1, 2.3, 2.10, req-102 | `status-slot.ts` (second item), `index.ts` (status + command only — owner of the hot file this wave), `libs/mission-ui/src/autopilot/` (new), `app-bar` slot usage | 10t on three devices; e2e for the refusal |
| 3.5 | `req-101-notes-clients` | Sonnet | req-101: Notes list (search, recent, folders), note view with pencil → Live, X/✓ icons, tags, ticket link, "Ask about this note"; Notes entry in the shell switch | req-100, 2.1, req-102 | new `libs/mission-ui/src/notes/`, `apps/mission-control/src/app/api/client.ts` notes calls, the hidden Notes entry of 2.1 | 10k/10l/10n/10p/10r; read-only device cannot edit |
| 3.6 | `e12-16-board-crew-completion` | Sonnet | E12-16 (E13-17 + E13-19): persona filter, cost by column, Empty columns, New persona, Remove from crew, editable Setup, Friction tab, Setup fields, "Talk to … 1:1 in the Assistant" (slot share waits for an engine count → follow-up) | 2.6 | `board/board-view.ts`, `team/team-view.ts`, `team/team-model.ts` | 7e/7f/7k minus slot share |
| 3.7 | `e12-14-mc-work-rows-settings` | Sonnet | E12-14: one row per ticket, detail line/age/persona/cost, Settings detail width, 5th text-size step XXL = 21 px (canvas 8) | 2.1, 2.7 | `libs/mission-ui/src/work/{work.html,work.ts}`, `settings/*`, `theme.ts` | 10c/5f |
| 3.8 | `d11-d22-dricket-defects` | **Opus** | the sweep defects on the store: D-11 priority vocabulary, D-12 comments in the desk thread + Needs-you from a decision comment, D-13 archived vanish, D-14 checkout prompt, D-15 tab titles, D-16 `rev:` block, D-19, D-20, D-22 (D-17 to 2.9's owner, D-18 to 2.7, D-21 reproduce) | 3.1 not required (scratch store) | `packages/tickets-engine/src/services/{board-service*,chat-service*}`, `store/`, `plugins/tickets/main/`, `conflict/` merge filter | each defect has a red-then-green spec |
| 3.9 | `e12-3b-settings-backends` | **Opus** | E12-3b desk settings: Chat extras, Repositories (launch command, default branch), "Pause when the budget is spent" state → unblocks E13-12b | none | `packages/tickets-engine/src/server/settings.ts`, `services/settings-service*`, `libs/mission-ui/src/settings/settings.model.ts` (rows) | settings round-trip specs |
| 3.10 | `9a-9b-drey-chrome` | **Fable** | 9a (req-104) and 9b (req-105) (Q7): 28 px dock headers (`--panel-head-h`), panel redesign Calendar/Source control/Outline/Search/Tasks; base + four plugins; ADR-0019/0057 later change | req-104, req-105 | `src/styles.css`, `src/app/dock/**`, `src/app/calendar/`, `plugins/{git,outline,tags,tasks}/renderer` panel parts | boards 9a/9b; e2e screenshots regenerated |

Wave 3 load: Fable 1 · Opus 3 · Sonnet 6.

### Wave 4 (as planned in the afternoon — **superseded by §4's fidelity wave**; these rows are now wave 5, after fidelity)

| # | Session / branch | Model | Item(s) | Owns |
|---|---|---|---|---|
| 4.1 | `e13-10-parts-block` | Sonnet (L) | E13-10 / E12-17 Parts block widget against the E10-4 routes, no direct file write, status per part, "Change flow ›" to the Flow tab | `ticket-document/{extension.ts,parts*.ts new}`, `flow/register.ts` link |
| 4.2 | `persisted-ids-crew-accept` | **Opus** | milestone-173 follow-up: `team` → `crew` tab/doc kind, `approve` kind, `desk-team` classes with read-both/write-new bridges; release note | `view layouts migration`, `plugins/tickets/renderer/team/`, `libs/mission-ui` tab ids, `packages/tickets-engine/src/contracts/` |
| 4.3 | `e13-5b-e13-9b-assistant-shape-rest` | Sonnet | E13-5b streaming + step cards, Work preset `assistantTarget: 'tickets.mission-control'` (E13-13 rest), E13-9b tab follows the file, one Ctrl+Z | `conversation/`, `view-preset.ts`, `plugins/tickets/main/engine-client*` |
| 4.4 | `e13-11b-e13-12b-e12-19` | Sonnet | Flow tab leftovers (shared word helpers into the engine package), budget pause + runners dialog, Review splitter, flow wording | `flow/`, `settings/desk-settings.ts`, `review/view.ts` |
| 4.5 | `e12-20-x-1-hygiene` | Sonnet | fixtures + canvas export, X-1 docs/code hygiene, docs/05 §5.0 diagram with `packages/apps/libs` | `e2e/`, `docs/`, dead `plugins/tickets/main/engine-host.ts` |
| 4.6 | `e14-9b-decommission` | **Opus** | only after the owner confirms no rollback: the files backend, shadow, legacy remote, schema supersession | per `docs/design/dricket/decommission.md` |
| 4.7 | `e11-2b-e10-3b-e10-5b-e10-4b` | Sonnet | iPad wide diff layout, tinted plan marks + line edit sheet, flow switch + per-gate model, parent leaves "needs shaping" | `libs/mission-ui/src/{ticket,plan,flow}/` |

## 3. Questions — all decided (2026-11-06, afternoon)

Each question below is marked **DECIDED** with the answer. "Owner" = the owner's own answer; "technical call" = decided by the coordinating session where the question was technical, to be revisited only if the build finds a reason.

**Q1 — Cut-over timing vs the state list. DECIDED (owner): the six-state vocabulary and the migration mapping land in the engine before the dricket cut-over import**, so the import writes the six stages once and no second store migration follows. Order: req-99a (2.2) → E14-7 (3.1).

**Q2 — Where is "the card" on the desktop? DECIDED (owner): Accept lives on both Mission Control surfaces** — the Needs-you row / Ready card in the Work panel (dock) and the decision card in the Assistant conversation. The ticket document, the Review tab and the ticket strip lose their Accept. No engine change: the `approve` command and `/api/tickets/<id>/accept` stay; the Review tab drops its `decide('accept')`.

**Q3 — Where the Autopilot state lives. DECIDED (technical call):** an `autopilot` record (`on | paused | off`, `resumeAt`) stored beside the existing `ChainMaster` in `chain.json`; the orchestrator derives the master from it; the engine resumes at the stored time, never a client; boot writes Off (O-5). The runner API, the `fleet_*` MCP tools and the specs keep working. Away posture stays out of scope (concept §6.1).

**Q4 — iPad pane state. DECIDED (technical call):** per device in `localStorage`, keyed by orientation, like the text size (D10: layout per device); no engine sync.

**Q5 — Markdown surface on the phone. DECIDED (technical call):** no new surface; req-101 reuses `libs/markdown-surface` and the Angular `mc-markdown`. View · Live · Source ship first; the pinned formatting strip is a follow-up of req-101.

**Q6 — Is Shaping an agent column? DECIDED (owner): no.** Shaping and Prioritized are manual columns (`persona: you`); **Building is the only agent claim stage**, with Plan, Build, Ralf's review and Tessa's test as phases of the chain inside it; Ready to try is manual; Accept = sign-off. This also answers "where does Review run": as a phase of Building, in the flow editor.

**Q7 — Missing roadmap ids. DECIDED:** added as "owner request 2026-11-06, outside the list": **req-103** the phone menu as the root screen with Search and Notes rows (decision 17; **part of req-96's scope**, named in both items), **req-104** board 9a Drey cleaned up (28 px dock headers, panel chrome, ticket card, Assistant without rail), **req-105** board 9b panels redesigned (Calendar, Source control, Outline, Search, Tasks).

**Q8 — Accept = merge + push: who merges, and where? DECIDED (owner, in the owner's framing):** the merge and push of Accept concern the **developed program's repository** — the target repository that the agents (Claude Code, OpenCode) changed in the phases — **not the dricket store**; the tickets in dricket are bookkeeping. Accept starts the existing commit step (`commit-default`, an owner-started run under the stop ladder) on the target repository: merge the ticket's branch, push; when that is green, the dricket ticket moves to Done as the bookkeeping result.

**Q9 — Text size steps. DECIDED (technical call):** the fifth step (XXL = 21 px, canvas decision 8) is bundled into the Appearance / theme item of wave 3 (3.7).

## 4. Fidelity rule — "done" means it looks like the board (2026-11-06 evening)

The goal the owner set at the start — **the whole UI is rendered as the boards show it, not approximately** — is the acceptance criterion of every UI session from here on. The boards are in the repo: [boards/](boards/README.md) (HTML with exact measures, colours, spacing and strings; a PNG per board; the canvas notes with decisions 1–31).

1. **Every UI session gets the whole boards folder**, not only its own board: the look is one system (tokens, chrome, spacing, type scale), and a session must see how its screen sits next to the others. It **changes only the files it owns** (per the wave table) — consistency comes from the shared tokens and the frame, not from one session doing everything.
2. **Frame first, then the panels.** On the desktop the base frame (title bar, 28 px dock headers and icon strips, tab bar, meta bar, status bar, panel chrome, the tokens in `src/styles.css`) is one session (9a, Fable), merged before any panel session starts: a panel inherits its chrome from the base, so a panel built before the frame changes is wrong again afterwards. On Mission Control the shell (req-96, merged) is the frame; the per-screen sessions follow.
3. **The comparison is part of the work.** A session starts the built app (`.\dev.ps1 -Built`, or the fake-desk e2e fixture for Mission Control), sets the window to the board's size (1440×900 / 1194×834 / 834×1194 / 390×844), takes the screenshot in the same state the board shows (same tab, same ticket, same panels open), puts it beside the PNG and writes a **deviation list**: every difference in layout, measure, colour, type, icon, string, order — each either fixed or justified in one line (a permitted deviation: the base's own chrome a plugin cannot draw into, a token in place of a hex, data instead of sample content). The list and both images go into the changelog entry. A screen with an unfixed, unjustified deviation is not done.
4. **Review against the board before the merge.** The integrating session (Fable) opens the board and the screenshot side by side and refuses the merge on a visible difference; the owner's round follows on the integrated build with the canvas open, board by board.
5. **SDK changes are allowed, but discussed first.** Where a board needs something the plugin SDK or the base cannot do today (a panel header drawn by the plugin, a status bar layout, a dock behaviour), the session stops, names the gap with the board and a recommendation, and the owner decides (the decision lands in the canvas notes and here); the change ships with its SDK version bump and the sample plugin updated.
6. **Tokens, not hexes; catalog, not literals** — unchanged (README rules, ADR-0057, ADR-0091).
7. **The working form is [fidelity-checklist.md](fidelity-checklist.md)** (2026-11-07): twelve steps every UI session's brief carries verbatim — read the board HTML and PNG first and hand in a *measure sheet* before the first edit, shoot the built app at the board's size, compare in [boards/compare.html](boards/compare.html) (side by side, overlay, swipe, pixel diff), write the deviation list into the changelog's `Fidelity:` block. The integrator checks the sheet, the screenshots and the list before a merge.
8. **Cheapest sensible model** (owner, 2026-11-07): the scoped board-to-screen sessions run on Sonnet, the frame and the review on Opus; Fable only orchestrates.
9. **The frame is given** (4.0 shipped as milestone 192): every panel inherits the 28 px header, the fold chevron, hover-only controls and the dock strips from `PanelFrame` / `DockService`; what a panel may draw inside and what it must not redraw is **the frame rule in ADR-0019** ("The frame rule for every panel"). A 4.2–4.8 session that needs more frame than that stops and asks (point 6 of the checklist), it does not draw its own header.
10. **Fidelity is not feature work.** A board element that is a feature the app does not have yet (7e's Filter popover and Cost by column, 7f's New persona / Remove from crew / editable Setup / Friction / Talk 1:1 — E12-16, E13-19) is **not built in wave 4**: the session builds the look of every surface that exists exactly, and lists the missing element as "feature not yet built — <roadmap id>" in its deviation table (a permitted justification since 2026-11-07, see the checklist). The features stay on the roadmap as wave 5; 7k gets row 4.9 because a whole page is missing, not an element.

### Wave 4 — the fidelity wave (replaces the feature list under "Wave 4" above, which moves to wave 5)

Order: 4.0 first, alone; then 4.1–4.6 in parallel within the pool; 4.7 last.

| # | Session | Model | Boards | Owns | Done when |
|---|---|---|---|---|---|
| 4.0 | `9a-frame` | **Opus** | 9a (req-104): title bar, dock headers 28 px + icon strips, tab bar, meta bar, status bar, panel chrome, ticket card, Assistant without rail; tokens | `src/styles.css`, `src/app/dock/**`, `src/app/titlebar/**`, `src/app/status-bar/**`, `src/app/panes/` tab bar, the SDK's panel header contract if a plugin panel needs one | 9a screenshot = board; the frame rule for every panel written down |
| ~~4.1~~ | ~~`9b-panels`~~ | — | **9b is not a target design** (owner, 2026-11-06 evening; `specs/decisions.md`). The panels keep their content; only the frame of 4.0 (headers, chrome) reaches them. | — | — |
| 4.2 | `desk-work-board-crew` | Sonnet | 7a, 7e, 7f, 7k, 7h, 7i | `plugins/tickets/renderer/{work-panel,board,team}/**`, `src/app/titlebar/view-switcher.*`, `windows/` | each board = screenshot |
| 4.3 | `desk-ticket-pages` | Sonnet | 7b, 7c, 7d, 7j (incl. E13-10 Parts block, E12-19 splitter) | `plugins/tickets/renderer/{ticket-document,review,ticket-header,ready-view}.*` | each board = screenshot |
| 4.4 | `desk-settings-autopilot` | Sonnet | 7g, 10t desktop part | `plugins/tickets/renderer/settings/**`, `src/app/settings/**`, `status-slot.ts`, `autopilot/`; **widened 2026-11-07 (owner): Settings becomes an editor tab as 7g draws it** — a core doc kind (`src/app/panes/**` registration, the `EditorService` open call, the overlay mount in `app.html`), ADR-0010 later change | boards = screenshots; Autopilot item seen running with a scratch runner |
| 4.5 | `mc-phone` | Sonnet | 10a–10d, 10g–10m, 10o, 10p, 10t phone part | `libs/mission-ui/src/**` phone templates/CSS, `apps/mission-control/src/app/app.*` phone rules | each board at 390×844 = screenshot |
| 4.6 | `mc-ipad` | Sonnet | 5b–5i, 10e, 10f, 10n, 10q, 10r, 10s, 10t iPad part | `libs/mission-ui/src/**` wide templates/CSS, `shell/` | each board at 1194×834 / 834×1194 = screenshot |
| 4.7 | `fidelity-review` | **Opus** | all | — (reads; small fixes only) | one deviation table over all 40 boards, every row fixed or owner-accepted |
| 4.8 | `desk-assistant` | Sonnet | 9a right side: the Assistant panel body without the rail (composer, chips, answer cards) — split out of 4.0 on 2026-11-07 (owner decision 4 of the 9a measure sheet); the ticket card in the editor belongs to 4.3; **also the decision card's "Send back with N comments" option** (7d): 4.3 exposes count + send through the document event and keeps an interim hover-only Send back on the Review tab's Files head until this row lands, then that control goes | `plugins/assistant/renderer/**` panel body + CSS | 9a right side = screenshot |
| 4.9 | `desk-persona` | **Opus** | 7k — the Persona page does not exist yet (E13-19 setup, the engine's `personaPatch` is there); a page of its own, after 4.2 lands (same `team/` files) | `plugins/tickets/renderer/team/persona*.ts` new | 7k = screenshot |

Engine-side items still open (req-99c phases in Building, E12-3b, E14-9b, the persisted ids) run as before in Opus sessions when the pool allows; they change no appearance.

## 5. Risks

- **Hot file `plugins/tickets/renderer/index.ts`** — six sessions want it; the plan gives it one owner per wave (2.6, then 3.4). Any other session that needs it rebases after that owner lands.
- **`fleet/chain.ts` shared by 2.2 and 2.3** (stage lists vs master) — small, but the second to merge rebases.
- **Cut-over on wrong names** if 3.1 runs before 2.2 lands (Q1) — a second store migration.
- **Owner verification backlog**: milestones 97–173 are unverified; the waves add ~20 more. Each wave should end with an owner round, not only wave 4.
- **i18n debt** if wave 2 sessions ship before req-102: new literals must be swapped before merge; otherwise the "no hard-coded strings" rule breaks on the first day.
- **Desktop-web vs iPad split** (G-37): 2.1 must detect "iPad" by pointer/touch + width, not by width alone, or the engine-served desktop browser loses its tab bar.
- **Dricket defects (D-11..D-22)** sit on the path the owner will use after the cut-over; 3.8 should not slip to wave 4.
- Unverified in this plan: no app was run; board matching is by strings and file presence; `10m` wording and the `Confirm/Dismiss` labels were not checked in the chat templates.
