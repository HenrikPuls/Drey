# Mask audit 2: built screens against the design canvas

Roadmap item E12-10 (owner report 2026-11-05: many screens do not yet match the design state). A screen-by-screen audit of Drey's Work surfaces and Mission Control (phone, iPad, desktop) against the canvas "Drey Tickets — Workflow redesign". **Nothing was rebuilt**; product code is untouched. It extends [convergence-gaps.md](convergence-gaps.md) (milestone 134, strings and structure only, nothing was run); this audit **ran the app**.

State audited: branch `desktop-integration` at `4cb1642c` (milestones 1–162), production build from this checkout.

## How it was done, and what it did not cover

- **Drey desktop:** the built Electron app under Playwright against English scratch vaults (the e2e fixtures `desk-board-team`, `review-tab`, `shape-in-drey`, `flow-settings`, `assistant-targets`, plus one extra scratch spec that was deleted afterwards). Every run used a temp `USERPROFILE` / `--user-data-dir`, so the engine was spawned from this build, never adopted. Screenshots 1920×1203.
- **Mission Control:** a scratch engine on a temp home and a temp vault (7 English tickets, 4 personas), Mission Control served from `dist/mission-control`, driven by Playwright Chromium at 390×844 (phone) and 1180×820 (iPad). Nothing touched the owner's real vault, `drey-tickets` or `~/.drey-engine`.
- **Design source:** the canvas itself is not in the repo. The comparators were (a) the eleven stale repo copies `docs/design/work-panel/*.dc.html` (text, colours, radii, fonts read from the markup), (b) the board-by-board table of the earlier design-to-code audit (canvas version 1793758350-594f, boards 4a–7j) and `desktop-integration.md`, (c) `convergence-gaps.md` and the roadmap. **Pixel-level spacing against the live canvas was not measured** — where a row says "layout" it is a structural difference visible in the screenshot, not a measured pixel delta. Tokens come from `handoff/DESIGN.md` and the Anthrazit table in the earlier audit.
- **Not captured** (fixture work, listed so the gap is explicit): MC ticket screen with a **waiting question** (4b/5a) and with **proof + diff** (5h/7j on the phone); MC **plan to approve** card (5c/5e; the seed has Parts but no proposal, so the card did not render); MC **shape** session (4c/5b); the **Views menu** (7h; the right-click did not open in the scratch run, judged from `view-switcher.html`); the Work panel in a dricket store. These sections say "code only".
- **A mistake worth stating:** a first e2e batch included three specs that do **not** isolate their engine home (`ticket-card-menu`, `ticket-header`, `ticket-document`) and so adopted the owner's live engine. The owner's tickets repo showed no new commit after the batch started (last commit 22:10, batch started later) and the specs failed at the first lookup; the affected spec ids (T-0090, T-0091) exist on the real board, so the owner may want to glance at `git log` there. Those specs were not run again; the ticket-document screenshot is the owner-verified-era copy from the milestone-129 session's notes folder.

Legend. **Seen** = visible in a screenshot (path under `audit-2-screenshots/`). **Code** = read from source or strings only. **Gap id** = `convergence-gaps.md` row: *fixed* (verified shipped), *open*, *partly*, *new* (not listed before). Size: **S** ≤ half a day, **M** one focused session, **L** several sessions or needs an owner/design decision first.

## Counts

| Size | Deviations |
|---|---|
| S | 38 |
| M | 16 |
| L | 6 |
| **Sized deviations** | **60** (the ids in the tables below; 6 more rows are "matches the design" and carry no size) |

Against the 35 rows of `convergence-gaps.md`: **verified fixed** G-01 (Work view), G-02 (targets), G-03 (Review tab), G-09 (Settings → Tickets), G-10 (panel title), G-13 (chord label), G-16 (Flow tab), G-18 (composer mic), G-23 (pastel tokens), G-30 (video rule); G-06 and G-08 are fixed per the changelog and were not re-checked on screen. **Still open or only partly fixed:** G-04 (`Plan with agent` still in the ticket header, Shape works), G-05 (no Parts block), G-11 (Workers block and footer, no Open Board icon), G-12 (one status item), G-14 (Team), G-15 (Board filter), G-19 (strings), G-24–26 (token residue), G-28 (menus), G-29 (header chips). Closed or decided: G-07, 17, 27, 31, 32. Documentation-only rows (G-20–22, 33–35) are out of scope for a screen audit. **New: 31 deviations** that no earlier row names (marked *new*).

## 1. Work panel (Home 2a, DeskWork 7a, left half)

Design: `Home.dc.html` (panel 340 px: one 40 px header row `Work` + icons; groups **Needs you · Shaping · Running · Ideas · Done this week**; one-line footer `3 workers · Local 2/2 · Claude Code 1/3` + `Workers` link); 7a retitles it **Tickets**, adds the icons *filter · New idea · Open Board tab · drag* and a footer *Team · Ben, Tessa busy*; row = id · kind chip · persona · title · line · age · cost.
Built: `plugins/tickets/renderer/work-panel.ts`, `work-groups.ts`, `board.css`. Screenshot: [desk-work-view.png](audit-2-screenshots/desk-work-view.png), [desk-waiting-ticket.png](audit-2-screenshots/desk-waiting-ticket.png).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| A-01 | **Header is three stacked rows (about 140 px) instead of one 40 px row**: vault dropdown + filter on row one, `Tickets 2 need you` with `+`, refresh, play/pause/stop on row two, an extra `…` on row three; the header icons are not ordered *filter · New idea · Open Board tab · grip* | Seen | new | M |
| A-02 | **A Workers block (live worker cards) sits above the groups** and takes half the panel; the cards repeat the question text, say `Looks stuck`, `Waits for your answer`, `Context — not reported yet`. Board 3b is superseded; 7a has no worker cards in the panel, workers live in Team/Capacity. Needs you is pushed below the fold | Seen | G-11 partly | M |
| A-03 | Footer is `1 need attention · 1 stalled · OpenC…` (truncated) + `Workers` link; design says `Team · Ben, Tessa busy` and links the Team tab. The Workers tab and Chain log still exist behind `…` | Seen | G-11 open | S |
| A-04 | No **Open Board tab** icon in the header (Board only in `…`) | Seen | G-11 open | S |
| A-05 | **Row title truncates at 340 px** (`Outline: drag headi…`) because persona chip + cost + kind chip take the line; the second line mixes phase dot, kind chip, a mono excerpt (`Queued waits for …`, `Building Run…`). Design: title on its own line, age right, one grey detail line | Seen | new | S |
| A-06 | Running rows show the mono strings `Queued`, `Building Running …` (a state word plus a raw status line) instead of a step line (`Step 2 · drop handler in …`) | Seen | new | S |
| A-07 | The Needs-you kind chip now uses the pastel peach and the `2` badge is peach (tokens landed) | Seen | G-23 **fixed** (E12-7) | — |
| A-08 | `Done this week` group not visible in the screenshot (scratch board had one done ticket under `Ready to try`); the Done group exists in code. **A done ticket appears as `Ready to try` under Needs you** (T-0100 sat in `70-done`) — scratch artefact of the seed (no `entered` data), recheck on real data | Seen | new (check) | S |
| A-09 | The panel carries a git warning `The tickets vault is not a git repository — transitions are not versioned.` in two lines at the bottom; correct for the scratch vault, but it takes panel height permanently with no dismiss | Seen | new | S |
| A-10 | Sort/filter control is a bare icon next to the vault dropdown; the design's filter lives in the header row (see A-01) | Seen | new | S |

## 2. Needs-you queue (Home "Needs you" group, 4b)

Design: group header `Needs you · 3`, each row `title · age`, kind line (`Question`, `Approval`, `Gate red`), tap opens the thread with the question pinned above the composer and options (`recommended`, `Send "…"`).
Built: the group is part of the panel above; the question lands in the **thread tab** ([desk-waiting-ticket.png](audit-2-screenshots/desk-waiting-ticket.png)).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| B-01 | Selecting a Needs-you row opens the **run thread** only; there is no way to read the ticket document from the same place (owner request E13-20, roadmap) | Seen | E13-20 | M |
| B-02 | The question reads as plain text `The worker asks: …` with a grey `4 min ago · the worker waits; 1 other worker keeps going`; no option buttons / recommended mark / `Send "…"` as in 4b. (This fixture sends no options, so the **options state needs a recheck**; the answer card above the *Assistant* composer, E13-9, exists only for Shape.) | Seen / code | G-17 decided | M |
| B-03 | Thread header: `Waiting for you  Outline: drag …` — title truncated at 20 characters while `OpenCode · qwen3-coder · 12 min` has room; the fold line `Waiting for you · 12 min ⌄` and `The stream is empty so far.` (italic) are dev-voice states, not the design's step list (`✓ Shaped and planned · 4 steps ›`) | Seen | new | S |
| B-04 | Ticket and thread are two tabs reached from different places; design has one ticket page with `Ticket · Thread · Review` | Seen | E13-20 | (in B-01) |

## 3. Ticket thread with a live worker (Ticket 3a, 7a centre)

Design: `Ticket.dc.html` — header (`Testing`, `Claude Code · sonnet · 18 min · context 44%`, icon controls), step cards (`✓ Planned · 4 actions · 6 min ›`), live action stream with timestamps, `What are you doing and why?` / `Stop after this step` chips, composer, file-conflict bar, `Safe beside others` card.
Built: thread tab ([desk-waiting-ticket.png](audit-2-screenshots/desk-waiting-ticket.png), [desk-plan-ticket-thread.png](audit-2-screenshots/desk-plan-ticket-thread.png)).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| C-01 | Chips and composer match (`What are you doing and why?`, `Stop after this step`, message composer). Matches the design | Seen | — | — |
| C-02 | **No step cards / `Safe beside others` / `Changes so far` blocks** in the thread; the stream is one list. The roadmap treats step cards as E13-5b (needs run step reporting), the rest of the right-hand 3a column went with the "no plan step list" decision | Seen | G-17 decided | L |
| C-03 | A ticket with **no run** (T-0130, Plan) opens a thread page `No run yet — write below to plan this ticket with a worker.` with a **pre-filled composer** (`Plan step — interview me first, …`) in running text. It reads like a dialog starter; Shape belongs in the editor + Assistant (7b) | Seen | G-04 partly | M |
| C-04 | Header icon controls (hand, stop, play) are icon-only with titles, as ADR-0057 asks; the pause hand is easy to confuse with "nudge" | Seen | new | S |

## 4. Ticket document: header, proof, cost (DeskWork 7a, DeskReady 7j, Ready 3c)

Design: header strip `T-0121 · NEEDS YOU` status caps, kind chip (`Ship`, `Fix`), persona, `build · step 2 of 4`, `$1.20 so far · est. $2–4 from 3 similar runs`, chain `✓ ● ○ ◆`, gate line; proof card; cost table; folded log.
Built: ticket document ([desk-ticket-document.png](audit-2-screenshots/desk-ticket-document.png) — a milestone-129 capture from a sibling session, English scratch data).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| D-01 | **A form row of controls above the title** (`T-0118`, phase chip, priority dropdown, repo checkbox `drey`, worker dropdown, branch chip, **`Refine with agent`** button, `</>`) — the design has none of it; 7b explicitly drops Refine/Plan-with-agent. `Plan with agent` is still in `ticket-header.ts:300` | Seen + code | G-04 **open** | M |
| D-02 | Status chip is the need label `REVIEW`, not `READY TO TRY` / `NEEDS YOU` / `PLAN TO APPROVE`; no kind chip; estimate basis only as tooltip | Code (dom.ts, model.ts) | G-29 open | S |
| D-03 | Proof card, checks list with timings (`0:12`), screenshots with captions: present and matching 7j | Seen | — | — |
| D-04 | The note `Video removed (size limit).` is gone (rule is 25 MB, no auto-delete) | Code | G-30 **fixed** | — |
| D-05 | The `Ticket file` / thread distinction: the document is a Markdown file in a tab named `T-0118.md`, the design calls the tab `T-0121 · Title`; thread tab uses the design's form (`T-0130 · Voice capture f…`). Inconsistent tab naming | Seen | new | S |

## 5. Shape (Shaping 2b → DeskShape 7b, PhoneShape 4c, PadShape 5b)

Design (7b): ticket in Ideas in the editor with a tool strip, `Paul edited this · 2 min ago` / `You edited this · rides along` marks, **answer card above the Assistant composer** (`How many parts does this need?` / `Send "3 parts"`), **no** Plan/Refine buttons in the header.
Built: [desk-shape.png](audit-2-screenshots/desk-shape.png) — editor + Assistant on the Mission Control target; `via Mission Control` chip, `You edited the plan — 1 edit · +1 −1` card, the Split/Keep proposal card.

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| E-01 | Shape in Drey is built (answer in thread, edit marks as thread cards, split proposal) — a different shape from 7b: marks are **thread cards**, not tinted lines in the document; the answer is a thread message (`3 parts`), not `Send "3 parts"` above the composer | Seen | G-04 **partly fixed** (E13-9) | M |
| E-02 | Ideas row in the panel shows `Triage` button inline, panel header collapses `Tickets 1 open`; the Parts of the plan render as raw list items with `persona:` and `reason:` lines as plain text (Parts block missing, see F-01) | Seen | G-05 | (F-01) |
| E-03 | `Split` button disabled-grey beside `Keep as one` looks unavailable; no hint why | Seen | new | S |
| E-04 | MC shape (phone 4c, iPad 5b): **code only** — raw-mode editor opens as a full text view with a warning bar (`Raw mode — this file is the machine interface…`), see [mc-pad-ticket-edit.png](audit-2-screenshots/mc-pad-ticket-edit.png). No `You / model / Show diff` switch, no formatting strip, no tinted marks (E10-3b / E12-6 follow-ups) | Seen | E10-3b open | L |

## 6. Plan to approve (Orchestrator 2c → DeskPlan 7c, PadPlan 5c, PhonePlan 5e)

Design: Parts block under the ticket header — persona per part, ↑↓ / delete, `starts first` / `after P1 · blocked-by P1`, per-part estimate `from N runs` or `not yet · fewer than 3 runs`, `Typical total $a–b`, `Ask Mission Control to change the split`, `Flow: standard · Plan, Build, Review, Test · Change flow ›`, `Approve plan`.
Built on the desk: nothing — the ticket's Parts show as a Markdown list ([desk-plan-ticket-thread.png](audit-2-screenshots/desk-plan-ticket-thread.png), [desk-shape.png](audit-2-screenshots/desk-shape.png), [mc-phone-ticket-plan.png](audit-2-screenshots/mc-phone-ticket-plan.png)).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| F-01 | **No Parts block in Drey** (E13-10 open): checkboxes with `persona:` / `reason:` as plain text lines, no controls, no estimate, no Approve | Seen | G-05 **open** | L |
| F-02 | MC plan card (5c/5e) exists in code (`plan/approve.html`); **not rendered in the scratch run** (no proposal text in the seed). Strings `Run part 1 only`, `Show diff`, `Change 1 of 1`, `Move earlier`, `Add a gate after this one`, `Remove this gate` still not found by grep | Code | G-19 open | M |
| F-03 | On the phone the ticket page shows `PLAN` chip, `phase: plan`, gate chips and `Chain: standard flow + the frontmatter delta · tap to adjust` in mono — raw engine words (frontmatter) in user chrome | Seen | new | S |

## 7. Ready to try, Review (Ready 3c → DeskReady 7j, DeskReview 7d, PadReview 5h)

Design (7d): Review tab with proof strip, `N files · M of N viewed`, file diff with `Changes / Whole file`, `Open in editor`, `Git history`, line comments, `Send back with 2 comments`, `Accept and move to Commit`.
Built: [desk-review.png](audit-2-screenshots/desk-review.png) — the tab `Review · T-0118`, proof gallery, `2 files · 0 of 2 viewed`, file chips (`A src/drag.spec.ts +2`), `Changes`/`Whole file`, `Open in editor`, `Git history`, `Viewed`, footer `Checks green · 3/3 · Send back… · Accept and move to Done`.

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| R-01 | Review tab built and close to 7d. Differences: the diff area is only ~100 px tall because the proof gallery and the file list take the height (no splitter, no master-detail), the footer button says the next column (`Accept and move to Done`, deliberate req-86) | Seen | G-03 **fixed** | S |
| R-02 | The Needs-you row for the ticket says `Review` + `waits for your review`; the status-bar item says `1 need you`; fine. The `1` chip next to the title is an unexplained number (comment count?) with no label | Seen | new | S |
| R-03 | MC review (5h): inside the proof card as an accordion, no master-detail (E11-2b), `Change 1 of 1` stepper missing | Code | E11-2b open | L |
| R-04 | MC ticket page in Commit shows only `Open thread` / `Change by chat` for this seed (no proof, no Accept/Send back) — cannot judge 7j-on-phone; verification needs a harness seed | Seen | — | recheck |

## 8. Board (DeskBoard 7e)

Design: columns Inbox, Prioritized (parent plan card with parts P1–P3), Build, Commit, Done this week; cost per column; persona chips; `New idea`; header `Filter: all personas` and `Cost by column`.
Built: [desk-board.png](audit-2-screenshots/desk-board.png).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| H-01 | No `Filter: all personas` and no `Cost by column` toggle; header is `Board  7 tickets · 2 running` | Seen | G-15 **open** | S |
| H-02 | Empty columns show a bare `Empty` in the column head's row (`Plan 0  Empty`), the same weight as a title; a horizontal scrollbar sits mid-height at 400 px and the Build/Review/Commit columns are off-screen at 1030 px centre width | Seen | new | S |
| H-03 | `New idea` sits inside the **Inbox** column header, the board design has it in the board header | Seen | new | S |
| H-04 | Cards: id + title only in the scratch data (cost/persona chips arrive with ledger data — present in the e2e fixture, matches 7e there) | Seen | — | — |

## 9. Team and Capacity (Workers 3b → Team 5d, 7f; Capacity band 7e)

Design: Team head `1 running · 2 waiting · 1 stuck`, `Today $ of $`, `Pause all`, `Stop all`, persona cards (state, ticket, Nudge / Hand to Claude Code / Stop), detail tabs `Setup · Memory · 12 · Friction · 3`, `Talk to Ben 1:1 in the Assistant`, `New persona`, `Remove from team`.
Built: [desk-team.png](audit-2-screenshots/desk-team.png), capacity band in every Work-view screenshot, [mc-phone-team.png](audit-2-screenshots/mc-phone-team.png), [mc-pad-team-detail.png](audit-2-screenshots/mc-pad-team-detail.png).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| I-01 | Team header reads `Team  4 personas` — the grid shows **five** cards (the `You` card is not counted) and the design's state summary and `Today $` are absent; the pool chips `Local 2/2`, `Claude Code 0/3` are as designed | Seen | new | S |
| I-02 | `New persona`, `Remove from team`, editable Setup, `Friction` tab, `Notify` / `Runs after` / `This week` / `Typical run`, `Talk to … 1:1` — all missing (desk tabs `1:1 / Memory / Setup`) | Seen / code | G-14 **open** | L |
| I-03 | **Capacity band is always open in the Work view** (about 330 px of the centre), with the persona list stacked vertically in the middle and a large empty left/right; it should appear only while Board or Team is the active tab (7e) and be one line | Seen | E13-13 rest | M |
| I-04 | Persona colour dots in Capacity (blue, purple, amber, teal) are plain hex colours from the persona files, outside the three pastels | Seen | new | S |
| I-05 | Duplicated surfaces: the Workers cards in the panel (A-02), the Capacity band and the Team tab all list workers | Seen | G-11 | (A-02) |
| I-06 | MC team (phone 6d): `Chain` master switch, `Pause all after this step`, `Stop all` as designed; persona cards show role in **uppercase mono** (`BUILDER · BUILD`), a full-width `Pause` button per persona | Seen | new | S |
| I-07 | MC pad 1:1 detail: tabs `1:1 / MEMORY / SETUP` (mono uppercase), `Teach Ben something…`, `No improvement proposals yet — the loop aggregates friction into drafts.` explanatory prose (breaks "no unnecessary UI text") | Seen | new | S |

## 10. Flow editor (PadFlow 5i; the Flow tab 7)

Built: [desk-flow.png](audit-2-screenshots/desk-flow.png), [mc-pad-ticket-flow.png](audit-2-screenshots/mc-pad-ticket-flow.png).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| J-01 | Desk Flow tab: gates as stacked cards with `+` between them, `Current` chip, `Ask Paul to change this flow`, `Reset to standard flow`, `Save flow` — close to 5i. The `Standard flow` button top right reads as a status, not an action; no `Move earlier / later`, `Add a gate after this one`, `Remove this gate` wording | Seen | G-16 **fixed**, G-19 open | S |
| J-02 | **MC "Gate chain" is a bottom sheet of form blocks** (`Edit the flow`, `INSERT A GATE` three dropdowns, `NOTIFY ME`, `STANDARD FLOW`, `Prefill chat`), full-width **green** buttons (the success hue, not the accent/peach) — not the 5i screen; headings in uppercase mono | Seen | new | M |

## 11. Settings: Tickets and root (DeskSettings 7g, 5f/5g/6c)

Built: [desk-settings-tickets.png](audit-2-screenshots/desk-settings-tickets.png), [mc-phone-settings.png](audit-2-screenshots/mc-phone-settings.png), [mc-phone-settings-appearance.png](audit-2-screenshots/mc-phone-settings-appearance.png), [mc-phone-settings-engine.png](audit-2-screenshots/mc-phone-settings-engine.png), [mc-pad-settings-devices.png](audit-2-screenshots/mc-pad-settings-devices.png).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| K-01 | Desk Settings → Tickets rebuilt: Team (`Edit team`), Default flow (`Open flow editor`), Daily budget, Runners (`Manage`); page description matches 7g. Missing: `Pause when the budget is spent`, runners dialog (E13-12b), the budget row is text (`$12 across 3 personas · $0 spent today`); the Default flow row has a ticket dropdown beside `Standard flow` that makes it look like a ticket flow | Seen | G-09 **fixed** (partly, E13-12b) | S |
| K-02 | Settings root list is not in the design's order: `Panels & plugins` clipped at the top of the left list (title overlaps) | Seen | new | S |
| K-03 | MC settings root has four rows (`Appearance`, `Chat`, `Devices`, `Engine`); design 6c adds `Away and alerts`, `Repositories`. The `Engine` row's only content is `Videos`, a one-word row | Seen | G-19 / E12-3b open | M |
| K-04 | **MC iPad: Settings → Devices is crushed into a ~120 px column** inside the three-column layout (title `Devi…` cut, name field overlapped by its label, `Show pairing code` wrapped to three lines) — the detail should take the middle/right area (design: settings as a full master-detail page) | Seen | new | M |
| K-05 | MC Settings page headings and labels in uppercase mono (`PAIRED DEVICE`, `PAIR ANOTHER DEVICE`) | Seen | new | S |

## 12. Views, tabs, title bar, status bar (DeskViews 7h, DeskTabs 7i, 7a chrome)

Built: [desk-tab-menu.png](audit-2-screenshots/desk-tab-menu.png), [desk-open-windows.png](audit-2-screenshots/desk-open-windows.png), the title and status bars in [desk-work-view.png](audit-2-screenshots/desk-work-view.png).

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| L-01 | Segmented `Notes | Work` switcher built; the **Views menu** has no description lines, shortcut text (`Ctrl+1/2`), `Edit views…` or footnote (code only, `view-switcher.html`) | Code | G-28 open | S |
| L-02 | Tab menu has `Show this tab in ✓ Work`, dock moves, splits; **no `Go to the Work view`** | Seen | G-28 open | S |
| L-03 | Open windows header reads `Open windows 1`; design `2 here · 3 elsewhere`. The group `In other views` + `Show here` exists as designed | Seen | G-28 partly | S |
| L-04 | **Status bar** has one item `2 running · 2 need you` (and a transient `waits for you` on the left); design has `$4.10 today` and `● 3 need you` as separate items and `in Work` when in Notes | Seen | G-12 **open** | S |
| L-05 | **No `Capture by voice (Ctrl+Alt+T)` button in the title bar**; the capture hotkey exists, the button does not | Seen | G-13 label **fixed**, button open (E13-16) | S |
| L-06 | The dock strip shows nine icons wrapping to a second line (`Tickets` icon alone on row two) at 372 px, before any panel opens | Seen | new | S |

## 13. Assistant header and targets (DeskWork right column, 7a)

> **Owner note 2026-11-05:** the owner adjusted the Assistant panel layout himself after the design:
> header = list icon, a rounded pill with three icon-only targets (chat, rocket, team), the conversation title, `+`;
> messages with a `vault context · N sections` chip; composer with an `Ask anything …` field, a mic and a send button, a row of
> attach / edit / vault / web / read icons and the model name on the right. [assistant-owner-layout-2026-11-05.png](assistant-owner-layout-2026-11-05.png)
> is the reference for this panel; deviations below that contradict it (M-01 'text labels on the target switch') are withdrawn.


Built: [desk-assistant-target.png](audit-2-screenshots/desk-assistant-target.png), the right column in every Work-view shot.

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| M-01 | Target switch is **three icon buttons** (chat bubble, rocket, people) with no labels; design: segmented `Model | Mission Control | 1:1 ▾` | Seen | G-02 **fixed**, labels new | S |
| M-02 | Composer: mic exists (G-18 fixed), chips `Vault`, `Web`, `<ticket>.md attached` are icons (`…` row) plus a pill; `No model set` text at the right bottom while LLM is off — correct state | Seen | G-18 **fixed** | — |
| M-03 | Step cards in the thread, streaming of Mission Control words (E13-5b) | Code | E13-5b open | L |

## 14. Mission Control — Work (PhoneInbox 4a, PadWork 5a)

Built: [mc-phone-work.png](audit-2-screenshots/mc-phone-work.png), [mc-pad-work.png](audit-2-screenshots/mc-pad-work.png), [mc-phone-ticket-ready.png](audit-2-screenshots/mc-phone-ticket-ready.png) (iPad). Design 4a: sans, sentence-case section labels (`Needs you`, `Running`, `Shaping`, `Ideas · drey ▾`), row = title, one detail line, age.

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| N-01 | **Chrome in uppercase monospace everywhere** (`WORK`, `NEEDS YOU · 1`, `COMMIT · 1`, chips `BUILD`, `PLAN`, `CHECKPOINT`, tabs, settings headings) — 33 `text-transform: uppercase` rules in `libs/mission-ui`; the design system (handoff, ADR-0057 for Drey) is sentence-case sans, mono only for ids and code | Seen + code | new | M |
| N-02 | **A ticket appears twice** on the phone list: in `Needs you` (`CHECKPOINT`) and again in its column `Commit` | Seen | new | S |
| N-03 | Rows show id + phase chip + title only: no detail line, age, persona or cost (design 4a: line + age; later boards add cost) | Seen | new | M |
| N-04 | Header `WORK vault · 0 active` vs design `Drey · desk`; the empty-state text on iPad `Tablet: work + detail · Desktop: + chat docked right` is **developer text** (`libs/mission-ui/src/empty.html:5`) — breaks "no unnecessary UI text" | Seen | new | S |
| N-05 | Chat composer placeholder (`"New ticket: …" or "T-0094 back to Ralf"`) is clipped to one and a half lines in the 390 px sheet and the field has no visible focus ring | Seen | new | S |
| N-06 | Phone has no bottom tab bar: Work/Team/Settings are in a drawer behind a hamburger (`Chats` sheet that also lists `New chat`); design 6a/6b has the chat as home with the menu — matches 6b structure, but the drawer is titled `CHATS` while holding navigation rows | Seen | new | S |
| N-07 | Ticket page (phone/iPad): `Live | View | Source` segmented control, gate chips in mono (`✓ Inbox → ✓ Prioritized …`) clipped at the card edge, `Open thread` / `Change by chat` buttons; the design's ticket page has the proof first and the gate bar at the bottom (not captured with a waiting/ready state, see above) | Seen | new | M |

## 15. Screens that no longer exist as designed (Main 1, Workers 3b, Orchestrator 2c, PhoneCapture 4d)

| Screen | Status |
|---|---|
| Main (1) "The flow, idea to running code" | Overview only, no UI to compare. |
| Workers (3b) | Superseded by Team (5d/7f); the code still ships the Workers tab and Chain log tab behind `…` and the footer link (A-02, A-03) — delete with E12-11. |
| Orchestrator (2c) | Superseded by 7c (F-01) and MC 5c (F-02). |
| PhoneCapture (4d) | The canvas still holds it as a text-capture sheet; the phone has capture only through the chat composer (mic button, M149); the board is not marked superseded. Owner call whether the board goes (see Z-02). |

## 16. Cross-cutting

| id | Deviation | Evidence | Gap id | Size |
|---|---|---|---|---|
| Z-01 | Tokens: the three pastels exist (peach seen on badges and chips); radii scale 4/8/16 added next to the old five values (`--radius-xs … -lg` still in use, 6 distinct values in the screenshots); hard-coded `#d64545` / `#5aa9ff` / `#1b1a19` (`board.css`) and 8 hex literals in `libs/mission-ui` not re-checked; MC `--text-3` contrast not re-measured | Code | G-24/25/26 partly | M |
| Z-02 | The repo design copies are **stale** (README says so); until the canvas is exported into the repo (or read through the design-sync tool), every audit compares against second-hand text. An export of boards 4a–7j next to the old ones (or deleting the stale copies) would make the next audit checkable | — | new | S |

## Ordered proposals

See `specs/roadmap.md` → Now → "Proposed by the E12-10 audit". Summary of the grouping (one session per group, disjoint files):

1. E12-11 Work panel body (A-01–A-06, A-09, A-10, L-04's panel half) — `plugins/tickets/renderer/work-panel.ts`, `work-groups.ts`, panel CSS.
2. E12-12 Ticket page: header, `Ticket | Thread | Review` (B-01, B-03, C-03, D-01, D-02, D-05; extends E13-20/E13-21).
3. E12-13 Mission Control chrome (N-01, N-04, N-05, N-06, I-06, I-07, K-05, J-02, F-03) — `apps/mission-control`, `libs/mission-ui` CSS and templates.
4. E12-14 Mission Control iPad layout and Work rows (K-04, N-02, N-03, N-07, K-03).
5. E12-15 Capacity band and status bar (I-03, L-04, L-05, I-01, I-04, A-03, A-04).
6. E12-16 Team and Board completion (H-01–H-03, I-02) — extends E13-17, E13-19.
7. E12-17 Parts block (F-01) — this is E13-10, restated with the screenshot evidence; stays one item.
8. E12-18 Views and tabs polish (L-01–L-03, L-06) — extends E13-18.
9. E12-19 Assistant header labels + review layout + settings leftovers (M-01, R-01, R-02, K-01, K-02, E-03, J-01).
10. E12-20 Audit fixtures and the canvas export (Z-02, the not-captured screens).
