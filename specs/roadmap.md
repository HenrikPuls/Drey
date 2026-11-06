# Drey — Concept & Roadmap

## Vision

An AI-powered knowledge hub for note-taking and task automation.

## Core Architectural Principles (fixed, apply to every phase)

- Everything stays plain Markdown with optional YAML frontmatter — no
  proprietary format.
- No server — Electron app, direct file access to any folder (including
  OneDrive).
- Folder structure is **the user's own**. The app imposes only
  `templates/`, the daily-notes root (`daily.dir`, default `daily/`),
  `chats/` (assistant conversations) and the hidden `.drafts/` (exit-time
  auto-saves); topics are free inline `#tag` labels, never directories,
  and the app never creates or moves folders on a tag's behalf. Nested
  tags (`#project/frontend`) are a label hierarchy — a naming convention,
  still not folders (ADR-0017).
- Classification/synthesis via a **local** OpenAI-compatible API, no
  fixed model (LM Studio default; Unsloth Desktop/llama.cpp/vLLM/Ollama
  also work). Cloud calls are **documented, opt-in exceptions, each off
  by default** (ADR-0047, ADR-0063): the hosted presets (`openrouter`,
  `anthropic`, `zai-glm`), the Claude Code CLI provider, and the
  assistant's `web_fetch` / external MCP servers. The one exception is
  the startup **update check** (ADR-0074) — on by default, because it
  sends no user content and everything after it asks. A `copilot-web`
  provider was prototyped but never merged (see `decisions.md`).
- Interactive requests (capture, chat) always take priority over
  background jobs.

## Tech Stack

Electron + Angular/TypeScript, CodeMirror 6 (editor), OpenAI-API-compatible
backend (LLM backend), Electron Builder (packaging). No embedding model
and no vector index — the assistant's vault context is text search
(ADR-0072).
No file watcher by default — vault is re-read on demand; opt-in chokidar
watcher for external changes (ADR-0045).

---

## Roadmap

Open work only. Everything implemented lives in
[`changelog.md`](changelog.md); everything decided against or excluded
lives in [`decisions.md`](decisions.md). When an item ships, move it to the
changelog and delete it here — no shipped history on this page.

**Status (2026-11-06):** version 0.8.1, milestones 1–151, 153–163, 165–169 and 171–183, plus req-98, req-101, req-102 (the i18n catalog, ADR-0091), req-99a, req-95a, req-95b, req-97, req-96 and req-99b built (109–111 are recorded in the changelog by the convergence audit backfill) — 1–83
owner-verified (milestone 82, auto-update from GitHub Releases ADR-0074,
end-to-end on a real install, the 0.7.0 → 0.7.1 update round included
docs/07 checklist; milestone 83, the tickets foundation ADR-0075/0076,
through the live board rounds T-0001 – T-0006 in the owner's tickets
repo). **Milestones 84 (the fleet runner) and 85 (continuous
orchestration, ticket T-0007, ADR-0077) — like the later owner requests
86–91 — are built and suite-green but await the owner's rounds** — see
their changelog markers. **Milestones 97 (the tickets-engine package cut), 98 (one transition
machine + status log + fleet ledger), 99 (the host-agnostic service
layer) and 100 + 101 (the remote/gateway move and the standalone engine
process, ADR-0088 E2b) and 102 (personas, ADR-0088 E3) and 103
(verify/proof, ADR-0088 E4) and 104 (the Mission Control chat engine,
ADR-0088 E5a) and 105 (the Mission Control app, ADR-0088 E5b) and 106
(the ticket screen + proof card + Drey hosting, ADR-0088 E5c) and 107
(the self-improvement loop, ADR-0088 E6) and 108 (the status log +
fleet ledger surface, ADR-0088 E7) and 109 (the Scout track,
ADR-0088 E8 — concept §5.6) and E9 (the chain delta, ADR-0088 E9 —
concept §5.7, the last concept item) are built
and suite-green but await the owner's
rounds** — with E9 the whole E0–E9 arc stands built and the concept
is complete, caveat:
none of it is owner-verified yet; the next step is the owner's
verification round before anything further. **Milestones 123 (E13-1, views — saved layouts with their own tabs, ADR-0089), 124 (E13-3, status bar slot), 125 (E13-4, link fallback to other vaults), 126 (E10-4, plan to accept), 127 (E13-2, view presets and home views, SDK 1.39), 128 (E10-5, flow editor), 129 (E13-6, the ticket as a document) 130 (E13-8, Board and Crew tabs, the Capacity band) and 131 (D-1, the Mission Control chat reaches its model: sync on change, both HTTP dialects, the error card, Settings → Chat), 132 (E10-6, you as a crew member: manual steps that park the ticket and notify), 133 (E12-6, the Markdown surface lib and Mission Control's View / Live / Source) and 135 (D-2, the paired-devices list with total and last connected, and pairing from Mission Control), 136 (E12-7, the Anthrazit design decisions: pastels, radius scale, type floor, text size scale) and 137 (the text size steps S / M / L / XL) and 140 (D-3, engine writes refresh Drey's vault views), 138 (E13-5, Assistant conversation targets), 139 (E13-7, the Review tab), 141 (E13-13 first cut, the Work view), 143 (D-5, the Mission Control frame stays put on iOS) and 144 (E13-9, Shape in Drey: Paul edits the open ticket through Mission Control, the Refine button removed) are built and suite-green and await the owner's round** (E13 is the desktop integration of Mission Control, below). The owner's verification round for 1–81 closed
2026-10-17: every "not yet
manually verified" marker below those entries is cleared, the bug-11
fix included. Milestone
ids are assigned when work starts — check `changelog.md` for the
highest used (latest: milestone 109 = the Scout track (E8, concept §5.6);
milestone 108 = the status log + fleet ledger
surface (E7); milestone 107 = the self-improvement loop (E6);
milestone 106 = the ticket screen + proof card + Drey hosting (E5c); milestone 105 = the Mission Control app (E5b); milestone 104 = the Mission Control chat engine (E5a); milestone 103 = verify/proof (E4); milestone 102 = personas (E3); milestone 101 = the standalone tickets engine (E2b); milestone 100 = gateway + fleet client in the engine (E2b-1); milestone 99 = the host-agnostic service layer (E2a); milestone 98 = one transition machine + the two data forms; milestone 97 = the tickets-engine package cut; milestone 96 = fleet stability, the rest (limits, prompt versions, edit counts, Tell/Nudge, soft pause); milestone 95 = fleet stability part 4 (the run view); milestone 94 = fleet stability part 2; milestone 93 = fleet stability part 1b; milestone 92 = fleet stability part 1; milestone 91 = ticket T-0084; latest requirement id: req-94
(req-94 = CI green again: the e2e suite rewritten for req-84/W4a and typechecked via tsconfig.e2e.json, the Ready-card fold CSS bug fixed; req-93 = JIT planning: the plan columns leave the default pipeline, the build step derives file-level detail itself; req-92 = BLOCKED keeps an incomplete step put; req-86 = the step card follows the pipeline, column editor, Settings tidied; req-81–85 see the changelog; req-80 = fleet token economy; req-75–78 added 2026-10-31: the Work panel, STRIDE, TARA, the red-gate
back-move; req-79 = the fleet brief's short instructions file; req-74 = due-date reminders, T-0012; req-73 is readable board
issues, renumbered from req-66 — the tickets remote holds req-66)),
the update check's positive answer is inline text — req-43 and req-44
were owner requests outside the list, shipped and owner-verified in
the same step).
Items A1–A5 of the architectural cleanup shipped on 2026-10-13, and
A10–A12 on 2026-10-17 (changelog); A6–A9 remain.

### Known defects

D-7 (b) was reproduced on the scratch build: Mission Control → ticket → Change by chat opens the chat field
pre-filled with "T-0002:". (a), (c), (d) need a model / a real phone — untested.

_Shipped defects:_ D-23, the ticket document's header on a dricket store, shipped as milestone 183; D-11 to D-22, the sweep on a dricket store, as milestone 181; D-1, Mission Control chat reaching no model, shipped as
milestone 131; D-2, the paired-devices list and pairing from Mission
Control, as milestone 135; D-3, engine writes not refreshing Drey's vault
views, as milestone 140; D-4, runs.spec flaking under full-suite load, as milestone 142; D-5, the page moving on iPhone/iPad scroll
(owner report 2026-11-04), as milestone 143; D-6, selecting a ticket switching the view and views saving themselves, as milestone 163; D-8, the flaky gate specs, as milestone 168; D-7, the phone chat about a ticket (unknown ticket, id prefix, view switching back, iOS keyboard) and D-5b (the phone wobble), as milestone 165; D-9, the Tickets panel footer on a dricket board, as milestone 171 — see the changelog.)

### Now (small, daily value)

**Tickets-Engine extraction + Mission Control** (owner request, outside
the list, 2026-11-01; migration plan accepted by the owner,
[ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)).
The strangler restructure of the tickets system per the architecture
concept: `packages/tickets-engine` (domain, fleet, contracts — E0/milestone 97)
grew through E1 (one transition machine, status log + fleet ledger —
milestone 98), E2a (the host-agnostic service layer — milestone 99),
E2b (the standalone engine process: invoke channel + SSE, lockfile
adoption, the plugin as its client — milestones 100+101; phone without
Drey) and E3 (personas — milestone 102) and E4 (verify/proof —
milestone 103) and E5a (the Mission Control chat engine — milestone 104:
chat sessions + proposal cards, the confirm-executes-through-the-board
rule, the OpenAI-compatible bridge, invoke methods + SSE + gateway
routes; built and suite-green but awaiting the owner's round) and E5b
(the Mission Control app — milestone 105: `apps/mission-control`, the
Angular phone-first PWA with the Work/Chat/Team shell the engine serves;
built and suite-green but awaiting the owner's round, so the legacy
remote stays the fallback) and E5c (the ticket screen + proof card +
Drey hosting — milestone 106: the read-only-first ticket screen with the
gate bar, the proof card's swipable gallery and fullscreen shot viewer,
the capped per-file-zoomable diff, the warned raw-edit save, the
accept/send-back routes with the mandatory note, the name-pinned
bearer attachment route, and `RemoteService.localClient` with the
sandboxed BrowserView host that shows the same app in a Drey window;
built and suite-green but awaiting the owner's round) and E6 (the
self-improvement loop — milestone 107: the workers' friction becomes
the personas' improvement drafts, the owner accepts or dismisses each
in the persona 1:1, one armed decision at a time; built and
suite-green but awaiting the owner's round) and E7 (the status log +
fleet ledger — milestone 108: concept §3.3, the per-ticket
`<id>.status.log` with its verb grammar and keyed open decisions, the
`_meta/ledger.jsonl` fleet events behind optional writer seams, the
two new Needs-you kinds; built and suite-green but awaiting the
owner's round) and E8 (the Scout track, concept §5.6 — milestone
109: the scout form `form: scout` for exploration-only tickets, the
`## Report` chapter + decision list a scout run writes into its own
ticket file — no worktree, no gate, no move —, the report card in
Needs you and the chat's `promote` command with confirmation
flipping the ticket to ship; built and suite-green but awaiting the
owner's round) and E9 (the chain delta, concept §5.7 — the last
concept item: the ticket's `chain:` delta against the pipeline's
standard flow, the insert/skip/notify grammar with its semantic
write-guard, the merge that feeds the gate bar and the Bescheid
"Needs you" cards, and the chat's `setChain` command with
confirmation; built and suite-green but awaiting the owner's
round). **Milestone 111 completes the board itself**: configurable
priorities — pipeline.md's top-level `priorities:` names the vault's
own vocabulary (weight order, its middle entry the default, its first
half the dispatch's jump class), and every priority path — board
order, dispatch classes, chat digest + envelope validation, header
edits, `createTicket` — reads it instead of a hard-coded list — plus
the blocked-by chat/edit path: the chat's `setBlockedBy` command and
the engine's whole-list replacement (an empty list clears the
blockers), the last board field without a conversational/edit way to
write it. Built and suite-green but awaiting the owner's round.
**E9 completes the concept** — all of E0–E9 stands
built, none of it owner-verified; next is the owner's verification
round (§4.9's watcher depth now rides on
the status log in place). Drey keeps its
native Work panel/thread/editor throughout. Supersedes req-75 W6–W8 (E3/E5 replace the Shape
dialog, the rules-file orchestrator and the phone-client rebuild); W9 stays.
**Mission Control redesign — concept v2 (E10, E11, E12)** (owner request,
outside the list, 2026-11-03; owner decisions D5–D12 closed; the design
canvas "Drey Tickets — Workflow redesign" is binding for the UI;
[ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)
"Later changes" records the decisions). Worked in this order, one
milestone at a time, a pause after each; milestone numbers are taken
when an item ships (next free: 137; 133 = Markdown surface, 134 = the convergence audit, 135 = devices, 136 = design decisions; 112 = specs + the English pass, 113 = navigation, 114 = settings, 115 = crew states, 116 = proof mode + videos, 117 = diff review, 118 = line comments, 119 = cost table + estimate, 120 = parts schema, 121 = plan delta, 122 = shape mode; E12-1 – E12-4, E11, E10-1 – E10-6 shipped). Nothing here creates tickets — the
owner builds without the tickets system.

- **E12-3b — Settings pages still missing.** Chat (the model rows and
  "Test connection" shipped with D-1 / milestone 131; still missing: thinking
  trace, new chat, attachments), Repositories (launch command for verify, default
  branch) and "Away and alerts" — each needs a desk setting behind it
  first; away posture itself is out of scope.
- **E11-1b — Proof video follow-ups.** The 60-second cap is not
  enforced (the walk is short; Playwright cannot trim), the phone client
  fetches the whole video through the bearer header instead of
  streaming (a `<video>` tag cannot send it; the route itself answers
  Range), and the Drey-hosted Work panel shows no player.
- **E11-2b — Diff review, wide layout.** The iPad board's master-detail
  split (file list left, one file's diff right) and the viewed marks on
  the desk instead of per device; E11-2 shipped both inside the proof
  card's accordion.
- **E10-4b — Plan to accept follow-ups.** The desktop widget is E13-10;
  here: the parent ticket leaves "needs shaping" once its parts are
  released (today it stays in its phase with one Log line), a per-gate
  estimate for the whole flow (the card estimates the build gate), the
  estimate reading "not yet" until the desk's answer arrives (it cannot
  tell "asked, no basis" from "not asked yet"). Adding or renaming a part
  from the card stays out on purpose (owner, 2026-11-04: board 7c's "Add
  part" button was removed again): the cut changes in the plan or by asking
  Mission Control.
- **E10-3b — Shape mode follow-ups.** Tinted line marks inside the
  rendered plan and a line-level "tap a line to edit" on the phone sheet
  (both want the Markdown surface, built in E12-6 — the surface is there,
  these two are still to wire in); the iPad board's formatting
  strip over the plan; Paul on his own persona model instead of the chat
  model.
- **E10-5b — Flow editor follow-ups.** The switch that lets Paul propose
  a flow for **every new plan** (concept §5.7 point 3: he starts at the
  standard flow; today only the "Ask Paul" draft exists), a per-gate model
  pick (the model is the persona's today and shown, not set), the default
  flow under Settings → Tickets (E13-12 / E12-3), and the fleet executing
  `move` / `assign` (the dispatcher reads the delta nowhere yet — it is
  data and renders on the gate bar, the cards and the editor).

Decided against and not on the list: an overlap guard, touches or file
routing between parallel tickets (D5 — req-75 W7 and W8 dropped; their
tickets closed); a separate design persona (dropped, it was only an
example). The default crew is Paul (plans), Ben (builds), Ralf
(reviews), Tessa (tests); **Pia is the name of Mission Control itself**.
The product name "Drey Crew" needs a name check before any rollout, with
"Kobel" as the fallback (the code is not renamed). Out of scope: away posture / return briefing,
report intent, photo markup.

**Mission Control on the desktop, inside Drey (E13)** (owner request,
outside the list, 2026-11-04; design:
[`docs/design/work-panel/desktop-integration.md`](../docs/design/work-panel/desktop-integration.md),
boards 7a–7j of the design canvas; views:
[ADR-0089](../docs/09_architecture_decisions/0089-views-saved-layouts-with-their-own-tabs.md),
accepted, built as milestones 123 and 127). The desktop is not the iPad layout on a big screen: the ticket is
its Markdown file in the editor, Shape is that file plus Paul through the
Assistant, review and board are editor tabs, and the owner switches between
**Notes** and **Work** views. **Saved layouts (views) are mandatory, not a
second stage** (owner, 2026-11-04): without them the two kinds of work fight
over the same docks and tabs, so they come first. The desktop shows at least
what the mobile client shows (the cost above all). Base and SDK changes are
allowed, but the SDK stays content-agnostic: no function that only the
tickets plugin could use. Work happens in `src/app/` (docks, panes, session,
status bar, wikilinks), `shared/plugin-api/` and `plugins/tickets/renderer/`;
the E10–E12 line works in `apps/mission-control`, `libs/mission-ui` and
`packages/tickets-engine` and has not touched those (checked 2026-11-04), so
both lines can run side by side. Milestone numbers are taken when an item
ships.

Order and dependencies (an item needs everything it names):

10. **E13-10 — Plan to accept in the ticket.** The Parts block as an editor
    widget under the header (persona per part, move / delete with a second
    press, running parts locked, flow row, estimate, Approve plan). Needs
    E13-6 (built, milestone 129); the engine side (`GET/POST /api/tickets/<id>/parts`, `POST
    …/release`) and the proposal text shipped with **E10-4** (milestone 126).
    **Board 7c adds:** "starts first" / "after P1 ·
    blocked-by P1" lines, "Typical total $a–b", the per-part estimate reading
    "from N runs" or "not yet · fewer than 3 runs", "Ask Mission Control to
    change the split" and "Change flow ›". **Status per part lives here** (owner, 2026-11-04: no separate plan-step list in the ticket).
13. **E13-13 — The Work view (rest).** The first cut is built (milestone
    141: the preset, the Tickets panel / ticket / Assistant / Capacity
    arrangement, home views, Ctrl+2). What is left: the Capacity band **only
    while the Board or Crew tab is active** (board 7e; boards 7a–7d and 7j show
    no bottom dock) — today it is always shown; the centre opening on the
    Board when the view is first shown empty; **Mission Control as the
    Assistant's default target** (the `assistantTarget` field of the preset
    stays unset until E13-5 exists, then the preset names it); and the tabs it
    arranges once they exist (Review 7, Shape 9, Parts 10, Flow 11).

Parallel lanes: 1, 3 and 4 are disjoint and can run together; 5 and 8 can
start when their needs are met without waiting for 1. Relation to the
E10–E12 line: 10 and 11 waited for E10-4 and E10-5 (both built); E12-5 (device rules
audit) is independent of E13.
Persona names follow D7 (Pia = Mission Control, Paul plans).

**Follow-ups of E13-11 / E13-12 (milestones 145–146):**

- **E13-12b — Budget pause and runners dialog.** "Pause when the budget is
  spent" (running work finishes first) and a runners dialog behind *Manage*
  (board 7g) need a desk setting first (E12-3b); today *Daily budget* only
  adds up the personas' budgets and *Manage* scrolls to the Workers section.
  The "default flow for new plans" (E10-5b) would also get its row here.
- **E13-11b — Flow tab, what is left.** The tab opens from the ticket
  strip and Settings; the plan block's "Change flow ›" link arrives with the
  Parts block (E13-10, the tab can open `flow://<id>/<part>` already). The word
  helpers (`changesLabelOf`, `marksOf`, `moveRoomOf`, `addablePhasesOf`) exist
  twice, in `libs/mission-ui` and in the plugin; one pure module in the
  engine package that both import would remove the copy.

**Follow-ups of E13-5 (milestone 138):**

- **E13-5b — Assistant targets, what is left.** Streaming of Mission
  Control's words into the thread (the engine already streams `chat` events
  on its `/api/events` channel; the plugin's `EngineClient.onEvent` drops
  them, so a turn shows "Working …" until it is whole); the step cards
  ("T-0121 · step 1 · tests green · 7 actions ›", board 7a) once runs report
  steps to a chat thread; a 1:1 that
  answers (the persona thread holds only the owner's messages today, E12-4);
  the Claude Code CLI provider as the *Model* target with its tools switched
  off (`claude -p --tools ""` — the empty argument through `shell: true` on
  Windows is not verified); the Work view preset must name
  `assistantTarget: 'tickets.mission-control'` (E13-13); dictation reaching a
  speech service inside Electron (the Web Speech API needs a network service
  the packaged app may not reach — only seen as "button shown", not as words
  heard).

**Follow-ups of E13-9 (milestone 144):**

- **E13-9b — Shape in Drey, what is left.** The open tab follows the ticket
  when "Keep as one" moves its file (today the tab keeps the old path until
  reopened); Paul's edit as one Ctrl+Z step (needs the engine to return the
  plan instead of writing it, or the plugin to push the reloaded text as a
  buffer transaction); tinted lines for the marks inside the plan (E10-3b) and
  the line-level edit sheet; the Work view preset naming
  `assistantTarget: 'tickets.mission-control'` (E13-13) so the Assistant is on
  Mission Control without the owner picking it.

**Proposed by the convergence audit (2026-11-04, milestone 134)** — evidence
and severity per item in
[`convergence-gaps.md`](../docs/design/work-panel/convergence-gaps.md); the
owner confirms scope and order before any of it starts:

- **E13-17 — Board filter and cost toggle.** "Filter: all personas" and
  "Cost by column" on the Board tab (board 7e) (G-15).
- **E13-19 — Crew tab completion.** New persona from a template, Remove from
  crew, editable Setup, Friction tab, Notify / Runs after / This week /
  Typical run fields, "Talk to <name> 1:1 in the Assistant" (with E13-5), the
  per-persona slot share (needs an engine count) (G-14).
- **E12-9d — "Initialize board" seeds the default crew** (owner decision 2026-11-05,
  answering E12-9b Q2: yes). A new board gets the default crew of decision D7 — **Paul**
  (plans), **Ben**, **Ralf**, **Tessa** (roles as in the concept) — plus "You" and Pia as
  Mission Control itself, each with worker, model, colour and prompt. Which persona works
  which column follows E12-9c (Plan, Build = agents; Inbox, Review, Sign Off = manual). The
  default worker is **`opencode`** (owner decision 2026-11-05, E12-9b Q3: it supports all
  providers; the engine's `defaultWorker` already is `opencode`); `claude-code` stays
  selectable, and so is **Kimi Code** (milestone 167) — both are what the owner uses today. The names are plain persona files, so the owner's idea of a squirrel crew ("Nutty
  Nutcracker" …) is a later naming choice, not a code change. Existing boards keep their crew.

- **E12-9e — Follow-ups of the default pipeline (E12-9c, milestone 166)** (S–M). Open: (1) **Plan →
  Build has no checkpoint** in the default (both agent columns): decide whether a finished plan
  should park for the owner (a `persona: you` pin / an inserted `manual` gate in the default
  chain) — today the owner inserts one per ticket; (2) **Sign Off is manual**, so the merge and
  push of `commit-default` is by hand or by a session working the checkpoint (BOARD.md) — decide
  whether Sign Off should offer "Merge and push" as an owner-started agent run; (3) a **reverse
  converter that reads the store's own stage list** (today `--stages a,b,c`, default the new
  six); (4) the Work panel's *Prioritized* group is empty on a new board (its queue is Inbox only
  while Plan is an agent column) — keep, rename or retire it; (5) **Open question: migration of `prioritized` tickets** — `inbox` (today) or `plan` (an agent
  column: planning would start on arrival); (6) E12-9b Q2 (crew seeding) and Q3
  (default worker) are still open.
- **E12-16 — Board and Crew completion** (proposed by the E12-10 audit; M, partly
  L). `Filter: all personas` and `Cost by column` (E13-17); empty columns say
  `Empty` quietly, `New idea` moves to the board header; `New persona`, `Remove
  from crew`, editable Setup, the Friction tab, the Setup fields and `Talk to …
  1:1` (E13-19) [H-01–H-03, I-02]. Files: `plugins/tickets/renderer/board/`,
  `team/team-view.ts`.
- **E12-17 — Parts block in the ticket** (E13-10, restated; L). The screenshot
  evidence is the raw Markdown list with `persona:` / `reason:` lines
  [F-01, E-02]; no change of scope — this entry only records that the audit found
  it as the largest single gap on the desk.
- **E12-19 — Assistant labels, review layout, settings leftovers** (proposed by
  the E12-10 audit; S). (The Assistant's top row and its way of input stay as the owner adjusted them on 2026-11-05 — `docs/design/work-panel/assistant-owner-layout-2026-11-05.png`: icon-only target switch, composer with its field text, mic, send, icon row and model name; audit row M-01 is withdrawn. Only how the chat itself looks may follow the design.) A splitter and a
  taller diff in the Review tab; `Pause when the budget is spent` (needs
  E12-3b's setting first); the Default flow row without the ticket dropdown;
  the Settings list no longer clips `Panels & plugins`; the disabled `Split`
  button says why; flow wording `Move earlier / Add a gate after this one /
  Remove this gate` [M-01, R-01, R-02, K-01, K-02, E-03, J-01].
- **E12-20 — Audit fixtures and the canvas export** (proposed by the E12-10
  audit; S). Export boards 4a–7j next to the stale repo copies (or delete the
  copies), and add the fixtures the audit could not seed: an MC ticket with a
  waiting question, one with proof and a diff, an MC plan to accept, an MC shape
  session, the Views menu, a dricket-store Work panel — then run the audit's
  remaining rows [Z-02, A-08, B-02, R-04, F-02]. Docs and e2e fixtures only.

- **E12-7 — Token alignment** (owner decision 2026-11-04: the Anthrazit design
  system wins). Milestone 136 on branch `design-to-code` owns it: peach / pink /
  mint tokens in the three themes, badges re-pointed, radii 4/8/16, a 13 px
  floor on mobile, Settings text size (decided as S / L / XL / XXL / XXXL, superseded 2026-11-06 by five steps S / M / L / XL / XXL = 15 / 16 / 17 / 19 / 21 px, L = 17 px
  default; the fifth step, XXL = 21 px, is bundled into the Appearance / theme work of wave 3, build-plan item 3.7, Q9), the capture label Ctrl+Alt+T (binding `Mod+Alt+T`) (G-13, G-23–G-26).
  This entry only states the decision; the work is not duplicated here.
- **E2b-4 — The engine announces its writes to Drey.** Changed paths ride the
  `board` event and the plugin calls `ctx.vault.announceChanges`, so the
  Files tree, indexes and open ticket tabs stay fresh with the watcher off
  (G-08).
- **X-1 — Documentation and code hygiene.** The schema's noise promise
  versus the parser (G-20), delete `plugins/tickets/main/engine-host.ts` and
  reword the engine's package description (G-21), German code comments (G-22),
  undocumented commit subjects (G-33), the unaudited legacy parts of docs/05
  and docs/06 (G-34), a stray `apps/mission-control/node_modules` (G-35).


The assistant tool rework (owner request, outside the list, 2026-10-13)
shipped as milestones 76–79, the removal of the embedding retrieval
(owner request, outside the list, 2026-10-14) as milestone 80,
configurable shortcuts as milestone 75 (ADR-0073) and zen mode (the
former "Next" item 6) as milestone 81 — see the changelog. All of it is
owner-verified (verification round closed 2026-10-17), the bug-11 fix
included.

**Fleet stability, what is left** (owner request, outside the list,
2026-10-31; parts 1, 1b, 2, 4 and the rest of 1c/2b/4b shipped as
milestones 92–96). **(M3)** — postponed by the owner, last in line: the
column as a `phase:` frontmatter field — one atomic write instead of
rename + write, a revision check between runner and Drey, CRLF
tolerance (alternative if the migration is too big: journal the move and
add the live-run check to `moveCard`). Smaller leftovers: the runner
writing the handover section from the worker's answer (today the worker
edits the ticket file, the runner commits it); a runner-side check that
the plan's acceptance commands can pass (the plan prompt asks the
worker to; a generic check cannot tell a command for a file the build
still creates from a broken one); **the fork base of a fresh ticket
branch** (req-93 follow-up): `baseRef` is the repos.md `branch:` as a
*local* ref of the owner's checkout, which can lag the remote the
commit step pushes to (T-0062 forked 8 commits behind) — fork from the
freshest ref instead (fetch before `worktree add -b`, never touching
the owner's checkout); "Hand to Claude Code" on a worker
card (no defined meaning yet).

**req-75 — The Work panel replaces the kanban board** (owner request,
outside the list, 2026-10-31; [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md),
accepted with W1). The board goes; the owner sees **Ideas** and what is **in
progress**, plus **Needs you** for decisions; an accepted ticket goes to
the archive. Two tracks chosen at triage (**Auto** for bugs and small
changes, **Shape** for a plan-mode dialog), one page per ticket with the
live worker, questions that carry their context, an orchestrator that
routes phase tickets, and the phone as a chat client. Design reference:
the owner's canvas "Drey Tickets — Workflow redesign" (11 screens).
Usability findings that motivate it: ADR-0087 "Context". Stages, each
shipped and confirmed on its own, in this order (W1 shipped as
milestone 89, W2 as milestone 90, W4 as req-75 W4a + W4b — changelog;
W1b, W2b and W3 shipped as owner-requested additions, see the
changelog).

- **W5 — Capture by hotkey and voice.** A second global chord "New
  ticket" (ADR-0073) raises Drey and opens the New ticket dialog in the
  main window (no separate capture window — the quick-capture call,
  ADR-0002); the dialog starts Windows
  dictation (Win+H) — no own speech recognition (req-11 stays excluded;
  local Whisper may be reopened later). One model call tidies the
  dictated text into title and description (raw text kept in the Log)
  and suggests the track. W5a shipped: the system-wide New ticket chord.
  W5b shipped: Windows dictation in the New ticket dialog.
  W5c shipped: the tidy-up; W5 is complete.
- **W6 — Shape track (recut, 2026-11-03: carried by E10-2 – E10-4).** The plan-mode dialog with the project context
  assembled automatically and shown as chips (CLAUDE.md, specs, ADRs,
  related tickets — over the existing context pack); read-only on the
  work repo; the plan grows beside the dialog in the ticket file;
  "split into phase tickets". **Both edit the plan** (owner request
  2026-10-31): the owner changes text or the Mermaid architecture
  diagram in the editor (Mermaid only to start), and the next message
  carries **only the owner's edits** since the model's last turn —
  never the model's own (a shadow text that receives the model's edits
  but not the owner's; delta = shadow → file) — as diff + per-block
  summary, shown in the thread and as a removable composer chip, for
  discussion; gutter marks show who changed which block (ADR-0087
  decision 8).
- **W7 — Orchestrator (dropped, owner decision D5, 2026-11-03: no overlap guard, no
  touches, no routing; the chain delta of E9 replaced the gates).** Phase tickets with gates between phases;
  routing by a rules file in the tickets repository (first match wins:
  worker, model, review); `touches:` paths per ticket and an overlap
  guard that holds a ticket while a running one touches the same
  paths; rebase on the integration branch and re-test before Ready.
- **W8 — The phone as a chat client (dropped, D5: Mission Control, E5b, is that
  client).** The req-66 client rebuilt: each
  ticket a conversation, one composer for capture, answers and
  shaping, compact chips for options, the Needs-you list as home.
  Push notifications stay R7's own decision.
- **W9 — Audit runs (own decision before it starts).** Read-only
  architecture and security reviews (incl. a check against pinned OWASP
  cheat sheets) that write a report into the work repo's `docs/` with
  stable finding ids and propose tickets into Ideas. STRIDE and TARA
  are separate items (req-76, req-77).

Ideas order (owner, 2026-10-31): by the existing `priority:` field
(urgent / high / normal / low), newest first within a priority — no
exact hand order; the `order.md` pins go with the board (the file is
left in place and ignored, the validator stops reading it). Priority
is set from a chip on the row and in the capture window.

**Fresh worktrees check out CRLF; the tickets prompt specs require raw
LF.** The repo-local git config has `core.autocrlf=true`, so a fresh
worktree writes every text file with CRLF — while the main checkout
carries LF on disk (written directly, never re-checked-out). The spec
`plugins/tickets/main/default-prompts.spec.ts` reads the shipped prompt
files *raw* and asserts byte-exact LF, so it fails in every fresh
worktree (first seen in the req-52 gate run, 2026-10-19). A
`.gitattributes` marking the tracked text as LF would make checkouts
deterministic; owner decision (it touches every file type).

**Ticket system + agent fleet** (owner request, outside the list,
2026-10-17; ADR-0075 + ADR-0076, format spec in
[`specs/ticket-schema.md`](ticket-schema.md)). A kanban-style pipeline
over Markdown ticket files in a **dedicated tickets repository**
(registered as an ordinary vault), with external agent CLI sessions
doing gated work in the work repos' `t/<id>` branches and Drey as the
cockpit. The foundation shipped as milestone 83, the runner with
run control as milestone 84, and continuous orchestration as
milestone 85 (ticket T-0007, ADR-0077 — the board now runs itself
wherever a column has a worker; see the changelog; the owner's live
rounds on real runs are still pending there).

**Runner retirement of stamp-less daemons + board setup defaults**
(owner request, outside the list, 2026-10-18, milestone 87). A fleet
daemon that reports no build stamp predates the stamp and was never
retired, so an old build kept serving (it still pulled from
`prioritized`). Treat it as stale. And "Initialize board" seeds the
plan and build columns as agent handovers plus the three prompts
(`plan-default`, `build-default`, `review-default`) in
`tickets/_meta/prompts/`.

**Takeover follow-ups.** The Claude Code interrupt (stream-json `control_request`)
is not yet verified against the installed CLI. Also open: a token budget per run
(stop a worker that reads without writing), and a tickets-repo-side credit
figure for flat plans (GLM coding plan reports cost 0).

**req-66 — Tickets remote: the board from a phone or tablet**
(owner request, outside the list, 2026-10-30; ADR-0086). Move, run,
take over, answer and refine tickets from an iPhone or iPad on the
couch — the tickets plugin only, not Drey on the device (that stays
excluded as req-10). An HTTP gateway in the tickets plugin's main side
behind a host-neutral `TicketsRemotePort`, so a later standalone or
VS Code host serves the same client. Loopback by default, reached
through Tailscale Serve (HTTPS); a LAN mode is opt-in with a warning.
Off by default; QR pairing, per-device tokens (hashes only), revoke,
Host/Origin check, bypass runs refused remotely. Owner decisions D1–D5
of 2026-10-30 confirmed. R1 (command layer + port), R2 (gateway,
pairing, Settings), R3 (the phone client), R4 (runs on the phone), R5
(refine), R6 (the iPad board), R8 (images from the phone, the run
view's pinned header) and R9 (markdown on the phone) shipped — see the changelog; only the optional
R7 remains. The client's display flicker (a double paint at
startup/wake and one per live-run tick) was fixed as T-0053 — the
paint is keyed on the built view (see the changelog). Follow-up of R5: an SDK seam
over `OpenDocsBridge` so a plugin's main side (the remote's refine)
edits a ticket open in a Drey tab through that tab instead of relying
on the ADR-0060 save-conflict merge. Follow-up of R8: an authed image
route (query token or cookie) so the phone can *display* the uploaded
attachments — an `<img>` cannot send the bearer token; rides the
phone's markdown rendering. Remaining steps, each shipped on its own:

- **R7 (optional, its own decision)** — Web Push: needs HTTPS and
  Apple's push service, a further cloud exception.

### Tickets on dricket (proposed by the analysis, owner request 2026-11-04)

**Proposed, nothing built, nothing here reorders the lists above or below.**
The owner decided to move Drey's whole ticket handling, the fleet included,
onto **dricket** (`dk`, calls `dk ... --json`; no TypeScript
re-implementation). Analysis and plan: `docs/design/dricket/`
([fit analysis](../docs/design/dricket/fit-analysis.md),
[engine impact](../docs/design/dricket/engine-impact.md),
[migration plan](../docs/design/dricket/migration-plan.md),
[requirements on dricket](../docs/design/dricket/dricket-requirements.md));
decision draft
[ADR-0090](../docs/09_architecture_decisions/0090-tickets-on-dricket.md)
(status: proposed). Gaps in dricket are **requirements for dricket** (R-01 ..
R-21 in the requirements file), not Drey workarounds. Owner decisions
OD-1 .. OD-9 are open (migration plan §10). Each item is shippable on its own
behind `tickets.backend` (`files` stays the default until E14-7); the real-run
checks use a scratch store and a second instance, never `drey-tickets`.

- **E14-0 — dricket releases (owner's dricket repo, not Drey).** v0.6 read
  contract (full `ls`/`show` JSON, comments list, capabilities), v0.7 write
  contract (extension fields, `put`, configurable stages, `move`), v0.8 (import,
  change feed, stage log, Windows CI, dependency semantics). Gate for E14-4;
  not for E14-1..3, E14-5.
- **E14-2 follow-ups** (the shadow run against the migrated store is done, see the
  changelog's "Shadow run" fix): the 500-ticket benchmark no longer waits for dk
  R-05 — reads moved to the file reader (E14-4, milestone 154) — and the comparison
  of both read paths runs first there; ticket documents under `dricket` come with
  E14-4c. Findings of the shadow run, settled for the cut-over by E14-7a: **done and
  archived tickets** migrate (O-3, `--include-archive`), and with them **T-0017's
  `blocked-by T-0049`** stays a real link; the **allow list** is written fresh from the
  frozen vault (E14-7, step 2). Still true: **dk under a deep path**
  (the repo's scratchpad, > ~200 chars) fails with "Filename too long" /
  "clean local private worktree" — keep stores and `--data` short on Windows (dricket
  requirement candidate: report it to dk).
- **E14-4c follow-ups** (the editor save hook, the read-only guard, ticket
  documents from the checkout and the Settings fields shipped as milestone
  156). Open: the ticket header strip, the thread pairing and the Shape marks
  for a checkout document (they key on the vault card path, so a dricket ticket
  opens as a plain document today); the checkout vault is not marked managed
  in Source control (one `markManaged` claim per plugin, taken by the tickets
  vault); `saveAsset` into the checkout's `tickets/` tree is not guarded; the 5 s
  ref check and the real-run check of the watcher, the write moves and the editor
  save shipped with milestone 161 (E14-8: a 10 s ref check as a safety net, the run in
  a built app on a scratch store, the checkout vault flagged managed).
- **E14-5c — What E14-5b left** (milestone 160 shipped the chain on a store, `chainRefusal` lifted,
  `## Verlauf` inside the claim, R-31 as a write-back, needs-input release + re-claim, leftover claims).
  Open: (1) the **worker's own ticket chapters** (`## Handover`, the plan's acceptance criteria) have no
  door on a store - the instruction names a ticket path the worker cannot edit there; a run-scoped
  copy of the ticket that the runner `put`s back inside the claim (`RunLease.patchInClaim`) is the shape;
  (2) a **"release leftover claims" button** in Drey / Mission Control (the runner route
  `POST /claims/release-leftovers`, `FleetPort.releaseLeftoverClaims` and the plugin invoke
  `chainReleaseLeftovers` exist; the chain also runs it once per store before its first dispatch);
  (3) a **re-claim after a wait** lands in dk's first claim stage - unchecked for a ticket that waited in
  a later claim stage (`commit`), and with commit trailers on the claim is kept through a wait instead (the epoch
  the trailers carry must stand); (4) the chain on a **remote store**: the runner does not `dk sync` (the
  engine's change feed does); (5) a real run with a real worker on a second instance - only the scratch-store
  checks of milestone 160 were made; (6) dricket **R-31** stays a "nice" (one commit instead of two for a
  same-stage release), not requested.
- **E14-6 follow-ups** (comments, status verbs and the ledger shipped as milestone
  159; no dk feature was missing: Drey reads the `comments/` files itself, so R-08
  is not needed). Open: (1) ~~the chain orchestrator's status events~~ (milestone 160: on a store a run's end is the run's own release
  comment, the chain's parks are `paused:` comments, `working:` is not persisted);
  (2) an **answer reaches the next run only through the thread**: the answer is a
  `resolved: <key>` comment, but nothing yet hands it to the persona's next
  instruction (a run that waits for the owner now releases and re-claims on the answer, milestone 160, Q-03); (3) **no Needs-you answer control** in Mission Control or Drey —
  the route (`POST /api/tickets/<id>/answer`) and the engine method (`answerNeed`)
  exist, the button does not; (4) the story builder ("How it got here") reads the
  Log only, so a send-back shows from the short Log line, never from the comment;
  (5) a comment is not editable and the thread has no composer (a free comment from
  the board needs one `dk comment` call behind an input); (6) the ledger file sits
  in the meta vault's working tree and rides that repository's next commit
  (`tickets/_meta/ledger.jsonl`, uncommitted by Drey, as before); a meta vault that
  is also the store's checkout would make dk flag it `unexpected-path` — keep them
  two folders; (7) the real check on a second instance (answer from the phone, a
  send-back from the Ready card) — only the engine services ran, on a scratch store.
- **E14-7 — Cut-over (wave 3, the owner present).** One start, prepared by E14-7a (milestone 175) and
  rehearsed on a copy of the real vault
  ([`rehearsal-2026-11-06.md`](../docs/design/dricket/rehearsal-2026-11-06.md), milestone 169). The
  owner's real `drey-tickets` is only touched here. req-99a is merged, so the store is written
  once with the six stages `inbox shaping prioritized building ready done` (decision 27), and step B
  of the guide repeated after that merge: the rehearsal ran on the old names. The exact sequence, with
  what each step should show, is
  [`cutover-guide.md`](../docs/design/dricket/cutover-guide.md), section C:
  1. Freeze: quit Drey, stop the engine (`engine.lock` names the pid), commit `tickets/archive`,
     `git -C E:\projects\drey-tickets tag pre-dricket`.
  2. Fresh allow list: `Get-ChildItem <vault>\tickets -Recurse -File -Filter 'T-*.md' | % { $_.BaseName } | sort | Set-Content <allow>`.
  3. Dry run: `node scripts/migrate-tickets.mjs --legacy <vault> --allow <allow> --include-archive --pipeline-out <file>`
     (`0 skipped`; check the pids of the stale run stamps, T-0030 and T-0050 today).
  4. Import: `--legacy`, `--allow`, `--include-archive` as above, plus `--apply --allow-live-runs --store E:\projects\drey-board --dk <dk> --actor owner@legion --data E:\projects\drey-board-data --report <file>`
     (`dk validate: clean`, `shadow diff: identical`, the comparison of record; the exit code does not cover the diff).
  5. Store check: the six ids in `git -C <store> show main:dricket.toml`, `dk validate`, the `dk ls` count.
  6. Shadow: plugin config `backend: shadow`, `dk.store`, `dk.dataDir`; `.\dev.ps1 -Built` once;
     `<engine home>\shadow\board-diff.md` says `Identical` (only while no live ticket stands in `build` or
     `commit`: it reads one pipeline for both sides); quit, stop the engine.
  7. Flip: the `--pipeline-out` file is committed as `tickets/_meta/pipeline.md`, `backend: dricket`, `.\dev.ps1 -Built` once.
  8. Smoke: same tickets in six columns, move, priority, editor save, comment, short fleet run,
     Accept into Done, an archived ticket opens; each write one `dricket: ...` commit.
  9. The owner's round; then E14-9b.

  **Stages (req-99a):** the engine's file-versus-store shadow reads one pipeline for both sides and cannot match across the rename, so the clean comparison is the migration tool's (`--apply` maps the phases). The reverse's default `--stages` is now the legacy board.

  **Decided:** the archive migrates (`--include-archive`, O-3 replaces OD-7). **Follow-ups, not
  blockers:** the shadow report names the store it compared and a changed store bypasses the 30 s gap
  in `scheduleShadow` (`store/store-board-source.ts`; matters only for an engine left running, the
  guide stops it); the apply's exit code covers the shadow diff, and `--allow` over archive ids without
  `--include-archive` is refused instead of skipping them with exit 0 (`migrate/cli.ts`); a
  `--phase-dirs` flag for the reverse converter (legacy folder numbers); a commit step settles into
  Done without a connected client (one line in `server/engine.ts`, req-99a hand-over).
- **E14-9b — Decommission, part b.** After the cut-over **and the owner's
  verification round** (owner, 2026-11-05: no fixed 30 days), delete what part (a)
  proved cannot go earlier — the inventory with callers and evidence is
  [`docs/design/dricket/decommission.md`](../docs/design/dricket/decommission.md)
  (part a, milestone 162, found class A empty and removed nothing). Exact scope: (1) the
  files forks of the board writers, phase-folder numbering ("Number folders", reorder
  renumbering), the drift pass, the file IO half of `core/transition.ts` (keep its pure
  patchers — the dricket bridge uses them), `core/phase-dirs.ts`, `core/normalize.ts`;
  (2) run / claim stamps and takeover-as-overwrite on files, the `.status.log` writer,
  the files-only ledger writers (the ledger path in the meta vault stays),
  `FileTicketStore`, `files-guard`; (3) the `files` and `shadow` modes of
  `tickets.backend`, the migration tool's legacy reader, the shadow diff, the reverse
  converter and `scripts/migrate-tickets.mjs` — only once the owner confirms no rollback
  is wanted; (4) the legacy phone remote (`plugins/tickets/remote/`, `fallback-client`,
  the `engine-main` fallback, the two `tickets-remote*` e2e specs) once Mission Control on
  the phone is verified — a product decision, nothing depends on it; (5) supersede
  `specs/ticket-schema.md` and the ADR-0076 file layout; the manual. Not in scope:
  `core/ticket-files.ts`, `ticket-board.ts`, `legacy-bridge.ts` (the dricket path runs on them).
  Three orphan helpers (`parkLine`, `phaseIdFromTitle`, `columnWorkerPin`) can go with it.

**What this does to running or planned items** (marks, not reordering):

| Item | Effect |
|---|---|
| E13-9 Shape in Drey (running) | **Stays valid** (UI, live edit, plan delta). Finish on the `files` backend; it must add **no new direct file writer**; its write path is re-targeted by milestone 155 (E14-4b: every board write is `put`). |
| E13-10 Plan to accept in the ticket | **Stays valid**; the `### Parts` block is body text. The engine routes (`parts`, `release`) are the contract: build the widget against them and put **no direct file write** behind them; the release is children-first, parent-last, resumable on dricket since milestone 155. |
| E13-11 Flow tab, E13-13..19 (Work view rest, panel naming, status bar, capture button, board filter, views polish, crew completion) | **Stay valid** (UI/DTO driven). |
| E13-12 Settings → Tickets in Drey | **Stays valid** except the pipeline/column editor: **waits** for OD-4 (stage vocabulary) and Q-05 (who edits `dricket.toml`). |
| E11-1c video size rule, E11-1b, E11-2b, E10-3b/4b/5b, E10-7, E12-3b/5/7/8 | **Stay valid** (videos stay outside git; UI follow-ups). |
| E11-4 cost table and estimate; `## Verlauf` writer | **Stay valid**; the writer moves inside the runner's claim (E14-5); history for the estimate comes from `dk log` (dk R-07). |
| E7 ledger and status log | **Reshaped, shipped on the board side** (E14-6, milestone 159): the ledger stays in the meta vault, `phase` lines dropped on a store; the status log is keyed comments. No new work on `.status.log` files. |
| E2b-4 engine announces its writes | **Reshaped** into E14-8 (shipped, milestone 160); do not extend. |
| Fleet stability remainder, "Takeover follow-ups", req-78 (red gate sends back) | **Wait**: claims, takeover and moves are re-based on `dk` in E14-5; do not start new claim/takeover code. |
| req-66 remote (refine, claim routes, R7 push), req-75 W5 capture, W9 audit runs | **Stay valid**; their write calls go through the port. |
| ADR-0076 file layout, T-0041 numbered folders, req-50/req-86 "Number folders" and column renaming, archive folder and marker, "a file move is a ticket move" and the drift pass, `entered-*`, the `run:` map, `claimed-by`/`claimed-at`, the pipeline `push:` key | **Obsolete after E14-7** (kept only as a read fallback for migrated tickets); do not extend. |
| X-1 documentation hygiene | Stays valid for notes; skip the parts of `ticket-schema.md` that E14-9 supersedes. |
| Mission Control UI, chat (Pia), personas (Paul, Ben, Ralf, Tessa, You), flows and chains, plans and parts, proof/verification/video, costs, views, Assistant targets | **Unchanged.** |

### Next

~~7. **Screenshots in the app.** Capture a region or window and embed it
   as an attachment (`attachments/`, ADR-0024). ⚠️ Scope open: whole
   window, region, or another application's window.~~
8. **Code signing.** The installer is unsigned — Windows SmartScreen
   warns on the first run of every fresh exe, updates included
   (`docs/11`). **Owner decision 2026-10-17: deferred** — the update
   channel ships unsigned (integrity is the SHA512 in `latest.yml`,
   ADR-0074); revisit when distribution justifies the cost. Options
   evaluated:
   - **Azure Trusted Signing** (~$10/month) — key in Microsoft's HSM,
     CI-native (electron-builder `azureSignOptions`, GitHub Action). Open
     question: identity validation for individuals in Germany.
   - **Certum Open Source Code Signing** (OV, ~€25–50/yr) — for
     individual OSS developers; SimplySign cloud token, CI signing
     fiddly.
   - **SignPath Foundation** (free for OSS) — Drey qualifies on paper;
     an approval process, signing rides their service.
   - **EV certificate** (~€300–700/yr) — the only instant SmartScreen
     reputation, but needs a registered business and a USB token that
     fights GitHub-hosted runners.

   ⚠️ When it happens: once an installed build is signed,
   electron-updater pins the publisher identity — future updates must
   keep it, and a later certificate migration needs a deliberate
   manual-download hop. Cut the first signed release knowingly.
9. **Tags at scale.** The Autotag prompt embeds the whole vocabulary
    (fine to low hundreds) and there is no near-duplicate detection
    (`sailing` vs. `boat`). Add a pre-filter and a duplicate finder
    on top of the rename/merge tool (milestone 53) before the vocabulary
    grows — since milestone 73 the lossless template feeds it into a
    second prompt.

### Later

- **Text completion (autocomplete).** ⚠️ Latency with a local model is the
  open question — run a spike (time to first suggestion on the target
  model) before any design. Today only `#tag` and `:emoji:` completion exist.
- **Web clipper.** Save the in-editor browser tab's page as a Markdown note.
- **Tasks inside the document.** First define what the Tasks panel
  (filters, due dates, priorities, completion dates — ADR-0033) and the
  assistant's task block cannot do. If the answer is a live query block
  in a note, it borders the excluded dataview.js.

### Architectural cleanup (from the 2026-10-13 review)

Behaviour-neutral work on the structure, found in the architecture review
of 2026-10-13 — evidence and reasoning per item in
[`docs/11`](../docs/11_risks_and_technical_debt.md) ("Architecture review
2026-10-13", same numbering). Not ordered against the feature lists above:
the owner picks when one is taken. Within the section the order is by
value for effort. A1–A5 are done (see `changelog.md`), the follow-ups
A10–A12 shipped on 2026-10-17, and A6 on 2026-10-18; the ids of the
rest are kept so they still match `docs/11`.

- **A7 — One generic service registry between plugins.** Three provider
  slots (section search, task query; a third, semantic search, went
  with milestone 80) were each added to
  the base by hand, and the host names the assistant
  (`assistantToolbox`, `tagSuggester`, `origin: 'assistant'`). Before a
  fourth provider: a typed `provide` / `get` registry in the SDK.
  ⚠️ Needs an ADR; a real alternative, not a refactoring.
- **A8 — Large modules, when next touched.** `markdown-surface.ts`,
  `vault-manager.ts` (vault registry apart from file operations; delete
  the sidecar plumbing), `dock.service.ts` and the assistant's
  `renderer/state.ts`. No milestone of its own.
- **A9 — Make `docs/05` and `docs/06` readable.** Move the
  milestone-by-milestone record (§5.1–§5.40) into an archive file and
  group the 57 runtime flows by topic. Changes section numbers that
  `CLAUDE.md` and the ADRs link to — ⚠️ owner decision.

### Needs an owner decision

- **`copilot-web`** stays excluded (fragile prototype); the req-29
  remainder below is therefore `copilot-cli` only.

### Backlog (unordered, uncommitted)

~~- **Req-6** — further CodeMirror 6 themes on demand (bundled set + `@uiw`
  themes since milestone 16; Cyberpunk is the third bespoke theme).~~
~~- **Req-12** — automatic image captioning via a vision model.~~
- **Req-18** — flow descriptions / agentic workflow automation
  ("Description => Sebastian => Peter"). The "=> Jira" target is excluded
  (Req-17).
- **Req-27** — review internal prompts (partial: ask protocol reworked in
  milestone 31, ADR-0053).
- **req-76 — STRIDE threat analysis from docs and code** (owner
  request, 2026-10-31; not planned for implementation yet — to be
  detailed first). A read-only run that derives a STRIDE pass (spoofing,
  tampering, repudiation, information disclosure, denial of service,
  elevation of privilege) per trust boundary from the architecture docs
  and the code (IPC boundary, CSP, MCP server and client, remote
  gateway, fleet runner) and proposes tickets for findings. Open:
  scope per run, report location and format, how findings are kept
  stable across runs, relation to W9 of req-75.
- **req-77 — TARA per ISO/SAE 21434 from docs and code** (owner
  request, 2026-10-31; not planned for implementation yet — to be
  detailed first). Threat analysis and risk assessment: assets, damage
  scenarios, threat scenarios, attack paths, attack feasibility, risk
  value, treatment. ⚠️ A model is good at assets and attack paths but
  unreliable at feasibility and impact ratings — those stay drafts
  until the owner confirms them; tickets only after confirmation.
  Open: which parts of 21434 clause 15 apply to a desktop app,
  feasibility method (attack potential vs. attack vector), report
  format, relation to req-76.
- **req-78 — A red gate sends the ticket back** (owner request,
  2026-10-31). An optional `on-red: <phase>` key per phase in
  `pipeline.md`: a red gate moves the ticket back to that phase with
  the gate's failure log in the ticket (Log line + the next run's
  brief), instead of only backing off. The target is configured, so
  the back-move may cross a manual checkpoint — the checkpoint only
  stops the machine because nothing told it otherwise (owner,
  2026-10-31). Flow the owner expects (e.g. `test` red, `on-red:
  plan`): the plan worker revises the plan with the failure as
  feedback and tells the owner what failed; when that needs decisions,
  the ticket waits in Needs you until the owner has made them; then it
  goes straight back into the phase whose gate went red (the phase it
  had started), not through the queue again. The loop is bounded by
  the phase's `max-red:` — past it the circuit breaker parks as today.
  The pipeline stays linear apart from this one rule; a visual workflow
  designer (branches, parallel paths) is not planned. Open: where the
  "return to" phase is recorded (a frontmatter key vs. derived from the
  Log), whether a checkpoint between the two (plan-review) is skipped
  on the way back, and how it interacts with W7's gates and routing
  (req-75).
- **Req-29 remainder** — `copilot-cli` (GitHub Copilot CLI, `-p`) not on
  main; id unrouted in `electron/llm/providers/presets.ts`.
- **Req-22 remainder** — context-menu "add meeting log" + per-day
  appointment picker; needs a live calendar source.
- **Shared note parse for the per-vault indexes** — tags, tasks and
  backlinks each scan every `.md` on their own;
  only worth it once a large vault makes refresh slow.
- **Editor as a full dock panel** — the note editor living *among* a
  dock's panels (sortable like Files/Tasks), not only as an editor band
  above them (M20, ADR-0038); when nothing is open and a file gets
  opened, the default home stays the centre column. Owner idea
  (2026-10-17, "füge es nur als todo hinzu"), parked uncommitted — a
  core change to the dock/pane system that would need an ADR of its
  own.

### Follow-ups of shipped milestones (none committed)

- **Device saves in File history and save hooks (follow-up of req-100).** A note saved from a phone or iPad runs no plugin save hooks and leaves no version under `<userData>/history/`, because both live in the Drey process and the engine also serves with Drey closed. The conflict guard still protects the text; only the "File history…" row is missing. To decide: a version store the engine can write, or a catch-up when Drey next hears of the path.
- **An SDK event for the active vault (follow-up of req-100).** The Notes API follows Drey's active vault by a push at activation and with every board fetch; a switch without a board fetch reaches the engine late. A `ctx.vault` event for the switch would make it immediate.

- **Persisted "approve" / "team" / "Sign Off" values (milestone 173 follow-up, owner request 2026-11-06, outside the list).**
  The wording change of 173 left every stored or contract identifier alone. Candidates that would read better
  as the user-facing words, each needing a migration that is not done: the default pipeline's stage title
  **Sign Off** is not a candidate on its own any more: the owner fixed one state list on 2026-11-06 and the column goes away (next item). The rest: the engine's
  `approve` checkpoint action kind, the Mission Control tab id `team` and the
  `tickets-team` document kind (persisted in view layouts and the phone URL), and the `desk-team` CSS classes.
  Each is a rename with a read-both/write-new bridge and a release note; none is needed for the owner to see
  "Crew" and "Accept".

- **Order of the canvas-2026-11-06 items (dependencies, concept §8.1):** guide step B repeated on the six stages → E14-3b / E14-7 cut-over (the final import writes the six stages) → req-99c phases inside Building. Shipped: req-102, req-99a, req-100, req-95a, req-97, req-99b, req-96 (with req-103, the phone menu root), req-98, req-95b and req-101.

- **Migrate the existing UI strings into the catalog, area by area (follow-up of req-102 / ADR-0091; req-106).** The i18n catalog (`shared/i18n/`, ADR-0091) covers only the surfaces of the 2026-11-06 canvas round; every older surface keeps its literal English strings. Migrate as areas are touched, one area per change: move its strings into `shared/i18n/catalog/en.json` under its `<area>.` prefix, read them through the runtime's binding (`I18nService` / the `t` pipe, `api.i18n`, `McI18n`, `i18n` in main), replace assembled sentences with ICU messages and `toLocale*` calls with the `Intl` helpers, then add the area's directory to `shared/i18n/guarded-paths.json` (and the ADR's list) so the guard keeps it. Candidate order: the Work panel and the ticket page (closest to the new surfaces), Mission Control's existing pages, Settings, the editor chrome, the Files panel, the native dialogs; the assistant panel's `shared/duration.ts` retires into `formatDuration` when its area moves. Not built.

- **Phases of the chain inside Building (req-99c; follow-up of req-99a, needs `fleet/orchestrator.ts` and `fleet/runs.ts`, which wave 2 kept apart).** The owner decided (Q6) that Plan, Build, Ralf's review and Tessa's test are phases of the chain inside the one Building stage. The engine's chain is still built from pipeline columns (`mergeChain`, `validateChain`), so today Building runs one `build-default` run and then hands over to Ready to try, the same as the live board's one agent column. To do: the gates as data of the Building column, the fleet running them one after the other inside one claim, the flow editor and gate bar showing them instead of the stages. Also decides how `review-default` and `qa-default` come back into the default flow.

- **Formatting strip on the phone and iPad Notes (follow-up of req-101, canvas Q5).** The pinned formatting strip (44 pt, `libs/markdown-surface` actions) above the keyboard of the Notes editor. Today `mc-markdown` shows its own small strip while editing; the pinned, designed strip of boards 10p/10r (paragraph style, bold, italic, lists, link, table, insert) is not built. Reuse the desktop's reducer from `libs/markdown-surface`.

- **Merge view for a Notes save conflict (follow-up of req-101).** A `conflict` reply from `POST /api/notes/note` today shows the desk's text and the owner's draft side by side and lets the owner keep one ("Keep mine" / "Keep the desk's"). A per-block merge like Drey's (`conflict/`, ADR-0060) needs a diff over `shared/` that both clients can use; not built.

- **Notes API gaps found by req-101.** (1) "Ask about this note" cannot attach the note to the chat the way a ticket rides a shape session (`ticket` on `POST /api/chat/sessions`): the engine has no note attachment, so the composer is prefilled with `About the note <path>:` and the model reads it through the vault tools; a `note` field on the chat call would carry it as a file (ADR-0071). (2) `GET /api/notes/note` returns no ticket link; the client reads `ticket:` from the frontmatter fence itself (`specs/frontmatter-schema.md`). (3) There is no rename, move or delete and no folder creation; the clients create notes in the open folder only.

- **Review and flow tab titles (follow-up of milestones 181 and 183).** The thread tab reads `T-0121 · Title` and D-15 gave a `DocumentRoute` its own title, but the review tab still reads `Review · T-0121` and the flow tab its flow title (`review/register.ts`, `flow/`); milestone 183 left them waiting for that contract, which now exists.

- **The gate bar's cost line says what it is (follow-up of req-98).** `cs-total` in the ticket view's gate bar is still a bare amount beside the gate pills; every other surface reads `$1.20 so far` / `$1.84 in total`.

- **Comment composer for store tickets (follow-up of D-12 and E14-6).** The thread shows a store ticket's comments since milestone 181 but cannot write one.


- **Board 9a — Drey cleaned up (owner request 2026-11-06, outside the list; req-104).** 28 px dock headers (`--panel-head-h`, today 32 px), the panel chrome, the ticket card, the Assistant without a rail. Base plus the dock; ADR-0019 / ADR-0057 later change.

- **Board 9b — panels redesigned (owner request 2026-11-06, outside the list; req-105).** Calendar, Source control, Outline, Search and Tasks as drawn; the base and four plugins' panel parts; e2e screenshots regenerated.

- **Mission Control over the CLI providers (D-1 follow-up, 2026-11-04).**
  The chat bridge speaks the HTTP providers (OpenAI-compatible, Anthropic
  Messages) and refuses `claude-code`, `copilot-cli` and `copilot-web` by name.
  An engine-side CLI bridge (headless `claude -p` per turn) would let the
  chat follow those too; until then the owner picks an HTTP provider in
  Settings → Assistant.

- **Chain alerts fix (owner request, 2026-10-31):** the run's usage
  in the thread as a menu, like Claude Code's context indicator — a
  small context gauge in the composer toolbar whose click lists context
  used / window, tokens in (cached) / out, cost, turns, reads and the
  elapsed time. Waits for T-0061 (W4a), which rewrites the thread and
  only carries these numbers as the meta line's tooltip.

- **req-79 (fleet token audit, 2026-10-31):** the other levers the audit
  of 52 runs / ~372M input tokens found, by size. (1) A run had no
  context ceiling — req-80 added OpenCode's mid-run compaction at
  `fleet.contextCapTokens`; still open: a Claude Code worker has no cap
  (its CLI exposes no window override), and a turn budget that ends a
  run and starts it fresh from the diff remains the alternative if the
  compaction's fidelity loss shows. (2) The
  commit phase is mechanical (merge, push, verify from a fresh fetch)
  yet spent 7 % at 15–92 calls per run; the runner could do it in code
  and call a worker only on a conflict. (3) `plugins/tickets/main/index.ts`
  and `renderer/index.ts` (~80 KB each) were read 40 and 89 times;
  splitting them makes every tickets ticket cheaper. (4) The board's
  own `_meta/prompts/` copies predate req-55's "keep the context small"
  rule (Settings → Tickets offers "Reset to the shipped version").

- **req-75 W1 (Work panel):** the per-phase brakes (pause / stop / play
  one automatic phase) are no longer drawn — only the master switch is;
  a single phase is held over the runner's `POST /chain/column`. The
  Workers view (W4b) shipped without them; decide whether they come
  back there. The thread is one
  tab that follows the ticket opened last; one thread per ticket needs a
  plugin SDK way to put a tab into a given pane. The remote client's
  iPad drag still sends a drop index, which the desk now ignores — it
  goes with W8.
- **req-65 (interactive dialog):** the fleet's MCP tool `fleet_run`
  cannot start an interactive dialog — `interactive` rides neither its
  input schema nor `fleetStart`'s MCP mirror; an assistant-driven
  dialog would want it. Also open: a per-column picker for the
  interactive worker (today the assignment ladder decides silently).
- **req-62 (ticket header):** move the ticket from the header's phase
  chip. A board move renames the file, and an open tab whose file
  vanished turns into a draft that a save recreates at the old path (a
  duplicate id) — the same trap a card drag has today while its ticket is
  open. Needs the open tab to follow the move (a rename-follow on
  `announceChanges`, or a `documents.close` for plugins) before the chip
  can move anything.
- **req-53 (fleet usage):** the second-opinion worker (M85 quality rungs,
  flagged off) runs in a fresh session under the same run, and its usage
  events replace the first worker's counts instead of adding to them —
  the run then under-reports. Carry the first worker's totals forward
  when the second opinion starts.
- **req-50 (Tickets settings):** a `pipeline.md` (or any tickets meta
  file) with CRLF line endings does not parse — `splitFrontmatter` finds
  no fence — so a fresh clone of the tickets repo under
  `core.autocrlf=true` shows an empty board; and plugin pages cannot
  take Ctrl+S (the keybinding layer swallows it at window capture; an
  SDK way to pause or scope chords would let the prompt editor save on
  Ctrl+S).
- **Milestone 63 (MCP, ADR-0063):** OAuth-protected servers, handing
  servers to the Claude Code CLI provider, MCP resources / prompts.
- **Milestone 77 (vault toolset, ADR-0071):** moving a note across
  vaults; deleting a folder; a per-call cache of file contents when one
  search reads a large vault; `tasks_list` and the template tools for a
  vault other than the active one.
- **Milestone 75 (configurable shortcuts, ADR-0073):** more than one
  chord per command; rebinding the mouse side buttons; the plugins' own
  key handlers (the Git panel's Ctrl Enter, the assistant composer) are
  neither listed nor rebindable; chords match `KeyboardEvent.key`, so a
  chord recorded on one keyboard layout (AltGr layouts in particular) may
  need recording again on another.
- **Milestone 80 (vault context by text search, ADR-0072):** the
  context block reads the section index, not unsaved buffers; a question
  finds only sections that contain its words — no stemming beyond
  part-word matching, no synonyms (a tool-capable model searches further
  itself); the number of sections (4) is fixed; the templates folder is
  not in the section index and so never rides as context.
- **Milestone 79 (web search, ADR-0063):** a key per search provider
  (switching the provider clears the one key); a config-change event for
  plugins, so the Web chip follows Settings at once instead of when the
  pointer or the focus returns to the composer; the private-address
  guard of milestone 88 for `web_search`'s SearXNG address too; the
  DuckDuckGo page reader breaks when that page changes — watch it.
- **Milestone 78 (open note through the tools, ADR-0071):** a
  confirmation dialog that opened before the ask was cancelled stays
  open until the user answers it (the cancel discards the raced answer
  and nothing is written — the ADR-0011 dialog has no dismiss seam);
  an edit of a chat note or of a file opened from outside the vaults
  keeps the whole-document reply form (and such a file cannot be
  live-edited); the tag filter of `vault_search` reads the
  section index, not unsaved buffers; several attached files as edit targets.
- **Milestone 64 (draw.io, ADR-0064):** dirty state / manual save for plugin
  tabs, "New diagram" in the Files context menu, SVG ⇄ PNG conversion,
  embedding a plain `.drawio`, letting the assistant read a diagram.
~~- **Milestone 65 (Git, ADR-0065):** clone as a new vault, rebase /
  cherry-pick, partial staging, dotfiles in the tree.~~
- **Milestone 74 (assistant on a selection):** the button on a selection
  in the assistant composer, a PDF or the browser tab; a prompt that
  rewrites only the selection (today a rewrite is a manual Action over
  the whole document, with the selection as its focus); showing the
  quoted selection as its own element in the chat card.
- **Milestone 73 (lossless template):** enforcing the vocabulary on the
  reply (today the prompt only instructs; an invented tag is caught in
  the confirmation diff), offering the built-in trigger to installs from
  before the template (they add it once in Settings → Actions), running
  it on a selection only.
- **req-42 (Cyberpunk app mark):** the desktop / Start-menu shortcut icon
  following the theme (`shell.writeShortcutLink`, installed build only —
  brittle, see the changelog entry), and a themed mark on the splash.
- **Milestone 66 (Office, ADR-0066):** rendering Office documents in a tab,
  "Open in default program" for other file types, a setting for the drop
  behaviour (copy or link).

---

## Open Risks / Undecided Details

- Stale view with the watcher off: external file changes go unnoticed
  until manual refresh. Opt-in watcher (req-14, ADR-0045) covers it when
  it bites. A dirty tab no longer wins silently: the save asks
  (milestone 60, ADR-0060).
- Model contention: assistant usage vs. parallel benchmarking runs —
  needs an availability check before every call.
- Tag sprawl: no near-duplicate detection. Autotagging biases toward
  existing vocabulary; the rename/merge tool (milestone 53) allows
  consolidating by hand — detection stays missing (Next, item 9).
- Very large vocabularies: the Autotag and lossless-template prompts embed
  the full tag list —
  fine to low hundreds, needs a pre-filter beyond that (see
  `classifier-spec.md`; Next, item 9).
- Documentation drift: `CLAUDE.md`'s milestone summary and the manual's
  version footer were found behind the code on 2026-10-12. Keep them in
  step when a milestone closes.
