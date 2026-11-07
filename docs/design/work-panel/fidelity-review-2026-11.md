# Fidelity review, November 2026 (wave 4, row 4.7, milestone 202)

One session read the boards and the built app, screen by screen, and wrote this one table. It starts the owner's own round.

**Method.** Tree: `desktop-integration` at `2a208316` plus the fixes below, built with `npm run build`. Every fidelity spec was run on the final tree (screenshot machine). The hand states (7a's document, 7f's stop confirmation, 7i's tab menu, the composites of 7b, 7c, 7j) came from temporary specs that are not committed; the list went to the integrator before the first fix and was agreed. Window: 1440×900, 1194×834, 834×1194 or 390×844, scale factor 1. Each pair was read side by side and region by region, with crops at 2–4× where a region looked off, and diffed at `compare.html`'s own threshold (sum of RGB deltas over 48) by a script that reproduces its diff. `compare.html` itself was not opened. Captures: `<Board>.board.png`, `.shot.png`, `.diff.png` in the shared notes folder `w4-7/`; shots in `test-results/fidelity/`.

**Not checked.** Hover states other than those the specs shoot; themes other than Anthrazit; a real iPad or phone (browser emulation over the fake desk); 7a and 7d as one composite state (noted per board in the table). Sample text was not compared word by word.

**Verdicts.** *fixed* (by this session), *justified* (a permitted reason, checked), *open* (the rules do not cover it; recommendation in one line).

## Open for the owner

| # | Board | Difference | Recommendation |
|---|---|---|---|
| O1 | 7a | A Needs-you row opens the Thread face with the old Ticket · Thread · Review strip, and Ticket opens a second tab. 9a's note says that switch is gone. | The row opens the one ticket document; Thread only from its button. |
| O2 | 7a, 7b, all Work panels | Shaping-stage tickets list under Prioritized; a Shaping group appears only with a live dialog. | Group by stage, as the board and decision 15 say. |
| O3 | All Work panels | The foot adds the store path, an orphan chip or the git warning (D-9, milestone 171). | Move the store line to a tooltip on the foot; keep only errors visible. |
| O4 | Row 7, 9a, 10t | The boards draw three status-bar orders and framed items; the running summary has no id. | Take 10t's order (newest), add an id for the running item, no frames. |
| O5 | 7a–7k | The layout-changed and needs-you dots are identical, so `Work` can show two. | Layout changed goes grey (`--text-4`); the orange means needs you only. |
| O6 | 9a, 7b | One ticket has two tab titles: `T-0017.md` from Files, `T-0002 · title` from the panel. | Always `id · title`, the plugin's title wins. |
| O7 | 7e, 7f | Capacity opens at 280 px by default against the board's 103, and a preset cannot set a height (SDK). Crew with the Assistant open clips its cards; the boards draw it with the dock folded. | SDK: `bottomH` on a view preset, 103 for Work; fold the right dock on the Crew tab or wrap the card. |
| O8 | 7a–7c | The desktop draws the persona's illustration on Crew cards and an initial on the ticket card and Parts; 196's reason is stale. | Use the Crew cards' illustration everywhere; a small change, but it crosses two plugin areas. |
| O9 | 7g, 10t | Tree pages beyond the board, extra page rows, Devices rows, search hits as names, recurring resume: open since 197, no id. | Accept the extra pages and rows (no setting is lost); give recurring resume and full-row hits ids. |
| O10 | 5c | The iPad Flow row is plain, without tick, current step or `standard ·`, unlisted in 198. 10j draws it plain, 5c and 7c do not. | Use the desktop's line on the iPad. |
| O11 | 10i, 5d, 10k, 10n, 10r | `waiting` and queued runs, and note titles apart from file names, were justified as data, but no data can draw them. | Roadmap ids: queued runs in the fleet report; the note's H1 as its title. |
| O12 | 7e, 7f, 7k | Personas read Ben, Paul, Ralf, Tessa on the desk fixture, Paul first on every board. Not traced whether fixture or engine order. | Pipeline order everywhere. |
| O13 | 7i | The tab menu is a flyout in a longer menu; `Go to the Work view` is in the catalog but was not seen in this state. Not on 194's list. | Keep the longer menu, inline the view list as drawn, add Go to. |
| O14 | 10l, 10n, 10f, 5d | One-pixel offsets with no cause traced: task rows, pencil, bubble, pool name. Not provably rasterization, so not justified. | Accept, or a session traces them; none changes the reading. |
| O15 | 5d | The board clips a run title (`to re`); the build ends it with an ellipsis, as every other board does. | Keep the ellipsis. |
| D-48 | 7f | New defect: after opening Crew with the Assistant open, the Tickets panel frame has `scrollLeft` 75, so the panel is cut on the left. Reproduced twice in the hand state; cause not traced. | Fix on the roadmap as D-48. |

## Fixes made

| # | Board | What changed | File |
|---|---|---|---|
| F1 | 7a, 7b, 7c, 7e, 7f, 7k | Work rows 52 px, not 56: the row's hidden menu button no longer makes the title line 24 px | `plugins/tickets/renderer/board.css` |
| F2 | 7a, 7e | A plain Work row (Prioritized, Inbox) 29 px, not 28 | `plugins/tickets/renderer/board.css` |
| F3 | 7a, 7k | The step word at the meta line's 13 px, not 10.5 | `plugins/tickets/renderer/board.css` |
| F4 | 7a | `Building · queued`, not `Queued` | `plugins/tickets/renderer/work-groups.ts`, its spec |
| F5 | 7a, 7e, 7h, 10t, 7k | The needs-you dot in the board's orange: a new token `--needs-you` (#e8a25a, Anthrazit; Mission Control's `--warn` value) instead of the git-status yellow `--status-modified`; other themes fall back to the old token | `src/styles.css`, `src/app/status-bar/status-bar.css`, `src/app/titlebar/view-switcher.css`, `plugins/tickets/renderer/board.css`, `desk.css` |
| F6 | 7h | Layout menu 294 px (the board's 280 is a content box), its description wraps as drawn | `src/app/titlebar/view-switcher.css` |
| F7 | 7f | Crew detail list 167 px + border (the board's 150 is a content box), so Setup starts at the board's x | `plugins/tickets/renderer/desk.css` |
| F8 | 7e | Capacity's budget bar grey (`--text-4`), not accent | `plugins/tickets/renderer/desk.css` |
| F9 | 9a, 7a–7d, 7h | Composer text under the chip, not 6 px to its right (CodeMirror's line padding) | `plugins/assistant/renderer/assistant.css` |
| F10 | 5h | Accept and merge at 17 px: the shared rule's 16 overrode the intended 17, so the button was 9 px narrow | `libs/mission-ui/src/ticket/pad.css` |
| F11 | 5h | The video length 4 px lower: it inherited the page's line height | `libs/mission-ui/src/ticket/pad.css` |
| F12 | 5h | The strip's amount at 15 px, not 14 | `libs/mission-ui/src/ticket/pad.css` |
| F13 | 5h, 10q, 10o, 10d | `4/4` and `checks` two items of the row (gap 6), not a text space, so the rest of the strip sits 2 px right | `libs/mission-ui/src/ticket/view.html` |
| F14 | 10f | The bar's trailing `+` 4 px further right while a back button shows | `libs/mission-ui/src/app-bar/app-bar.css` |
| F15 | 10p, 10r | Live Preview: title 26/32/700 (was 500 and about 25 px), section heading 20/700, tag gap 8 (was 13), tag line 24 high, `##` grey in the source box, iPad's box 42 high, the spacing round it | `libs/mission-ui/src/markdown/markdown.css` |
| F16 | spec | `fidelity-desk-work`: the Capacity band at the board's 103 px (the spec set 140, older than the 100 px minimum of milestone 199) | `e2e/fidelity-desk-work.spec.ts` |
| F17 | spec | `fidelity-desk-tickets`: the 9a test failed at tip; it now waits for the panel and opens the group's fold when the row is behind it | `e2e/fidelity-desk-tickets.spec.ts` |

## Rows a build session justified that do not hold

| Milestone, row | Justified as | Finding |
|---|---|---|
| 194, "Counts, names … `Prioritized`/`Inbox` totals" | data | Hides a real difference: a ticket in the Shaping stage is listed under *Prioritized*, and no Shaping group shows unless a dialog is live (`workGroups`). No fixture can reach the board's group. O2 |
| 194, "Fixed in the build: every Work row" | fixed | Rows were 56 px, the board's are 52. F1 |
| 194, "the dot" and 199, "the token the status bar's attention dot uses" | fixed | The token was git-status yellow #e0bb6e, the board's orange is #e8a25a. F5 |
| 195, 10d, 10o Flow; 198, 10e, 10q, 10s, 5b Flow | data instead of sample content | Not sample data: no data can draw `Plan · Build · …` until the phases exist. Right reason: feature not yet built — req-99c (roadmap, "Phases of the chain inside Building"). Applied in the table |
| 195, 10i and 198, 5d persona `waiting`, a queued run | data instead of sample content | The fleet reports live runs only, so no sample can draw them: feature not yet built, and no id names it. O11 |
| 195, 10k and 198, 10n, 10r note titles | data instead of sample content | The client shows the file name, so no sample can draw a title apart from it: feature not yet built, no id. O11 |
| 196, 7b, 7c persona picture | feature not yet built, row 4.9 | Row 4.9 shipped as 201 without a portrait; the roadmap's E13-19 says so. The cited target is stale. See O8 |
| 196, 7c hint; 198 Q1, Q5, Q6; 195 Q6 | owner decision | These are the integrator's rulings on measure sheets. They bind, but `decisions.md` does not record them, and the checklist asks for an owner decision from `notes.md` / `decisions.md`. 198's Q1 itself is covered by `notes.md` navWidth. Recommendation: enter the rest in `decisions.md` |
| 197, 10t "2 running · 1 stuck · 1 queued" | feature not yet built — no id | A cited id is required and none exists. O4 |
| 197, recurring resume `every day` | feature not yet built — no id | As above. O9 |
| 197, four rows "open — for the integrator" | open | Still open with no id. O9 |
| 198, table | | 5c's Flow row and its missing Paul message are not listed at all. O10 |
| 200, "geometry files agree to the pixel" for the composer | fixed | The text was 6 px right of the board. F9 |

## System check: one element, two drawings

| Device | Element | Boards | Build | Verdict |
|---|---|---|---|---|
| Desktop | Persona picture | Illustration on 7a–7c, 7f | Illustration on the Crew cards, an initial on the ticket card and in Parts | open, O8 |
| Desktop | Dot on a view tab | One dot, needs you | Layout changed and needs you share one class, so `Work` can show two equal dots | open, O5 |
| Desktop | Ticket tab title | `T-0017 · title` on all boards | `T-0002 · title` from the panel, `T-0017.md` from Files, both for one ticket | open, O6 |
| Desktop | Status bar | Row 7, 9a and 10t disagree | One order, 10t's without the running item | open, O4 |
| iPad, phone | Flow row | 5c, 7c tick and current step; 10j plain | Plain on 5c and 10j, ticks on 10e, 10q | open, O10 |
| iPad, phone | Linked ticket card | 10l `T-0121 · Building · linked ticket`, 10n `· linked ticket · Needs you` | 10l's on both | justified: the boards disagree, data |
| iPad, phone | Question line of the chat link | 10a `Building · question from Ben`, 10f `Question from Ben` | 10a's on both | justified: the boards disagree, data |
| All | Radii, mono font | Boards vary (12, 6, 18, Consolas) | 4 / 8 / 16, `--mono` | justified: owner decision, token |

No other element differed across boards of one device in the regions read.

## The table

Rows that hold on every board of a device are listed once under *all*.

| Board | Region | Board shows | Build shows | Verdict |
|---|---|---|---|---|
| all desktop | Title bar logo | `D` tile | Drey logo | justified: owner decision 2026-11-07 (decisions.md) |
| all desktop | Docks under the strip | 4 px lower | One line at y 77 | justified: owner decision 2026-11-07 (decisions.md, milestone 192) |
| all desktop | Tickets, Source control glyphs | Ticket, three-node glyph | `layers`, `git-branch` | justified: owner decision 2026-11-07 (decisions.md), the set lacks them |
| all desktop | Text | Headless Edge | Electron | justified: text rasterization, no CSS difference found |
| all row 7 | Tab bar and meta bar | 32 and 40 px, X on every tab, Lines, Save pill | 37 and 37 px, 9a's tabs and meta | justified: base chrome, 9a wins for the frame (milestone 192) |
| all row 7 | Right strip | Search, Tasks, Assistant | Tasks lives in the left dock | justified: a panel lives in one dock (milestone 192) |
| all row 7 | Under a tab whose Capacity hides | No band | Empty band | justified: feature not yet built — D-47 |
| all desktop | Status bar | Row 7 framed items, `2 running`, 9a and 10t other orders | Autopilot, cost, need you, no frames | open, O4 |
| all desktop | Work tab | One dot | Layout-changed and needs-you dots look alike | open, O5 |
| all desktop | Needs-you dots | #e8a25a | #e0bb6e | fixed (F5) |
| all Work panel | Foot | `Crew · Ben, Tessa busy` | Plus store path, orphan chip or git warning | open, O3 |
| all Work panel | Groups | Shaping group | Shaping-stage tickets under Prioritized | open, O2 |
| all Work panel | Row height | 52, plain 29 | 56, plain 28 | fixed (F1, F2) |
| all Work panel | Step word | 13 px, `queued` | 10.5 px, `Queued` | fixed (F3, F4) |
| all Work panel | Issue badge on a row | None | `1` chip beside the title on seeded store tickets | justified: data instead of sample content |
| all Work panel | Done this week | Group | Absent: nothing archived in the fixture | justified: data instead of sample content |
| all Work panel | Running row cost | Orange at 82 % | Grey | justified: feature not yet built — req-113 |
| all Assistant | Composer text | Under the chip | 6 px right | fixed (F9) |
| all Assistant | Option descriptions | Grey second part per option | None | justified: feature not yet built — req-138 |
| all Assistant | Chip | `T-0121.md ×` | `T-0121.md attached` | justified: feature not yet built — req-140 |
| all Assistant | Icon row on a target | Attach, edits, vault, web | Attach, vault | justified: feature not yet built — req-141 |
| all Assistant | Bubble wash | 14 % | `--accent-surface`, 15 % | justified: a token in place of a hex |
| 9a | Ticket card | Start build, dropdowns | Thread only, plain values | justified: feature not yet built — req-120, req-121 |
| 9a | Tab | `T-0017 · A8 large modules` | `T-0017.md` | open, O6 |
| 9a | Flow, Repo, tree, Outline counts, chat text | Sample | Seeded vault | justified: data instead of sample content |
| 9a | Outline, Tasks bodies | 26 px rows | Panel's content | justified: owner decision, 9b is not a target (decisions.md) |
| 9a | Files head hover | Actions shown | On hover only | justified: the board forces its hover on (shot `DeskClean.files-hover.png`) |
| 7a | Centre | Ticket document with Parts in one tab | Row opens Thread face with Ticket · Thread · Review; Ticket opens a second tab | open, O1 |
| 7a | Assistant step rows | `✓ T-0121 · step 1…` | None | justified: feature not yet built — req-139 |
| 7a | Strip | 7 icons | 8, with Open windows | justified: 7i draws the eighth, the boards disagree |
| 7b | Formatting strip | Bold … Insert | Base strip | justified: base chrome (milestone 192) |
| 7b, 7c, 7j | Type row | Ship / Fix | None | justified: feature not yet built — req-119 |
| 7b, 7c | Persona picture | Illustration | Initial | open, O8 |
| 7b | Bullets, ids, paths, cost | Sample | Store fixture | justified: data instead of sample content |
| 7c | Part `blocked-by P1` | In the line | `after P1` and reason | justified: feature not yet built — req-123 |
| 7c | Hint under the title | Line | None | justified: integrator's ruling Q3, milestone 196; not in decisions.md |
| 7c | Step rows, estimates | `✓ Shape…`, per part | None, one per persona | justified: feature not yet built — req-129; data |
| 7d | `Ralf: no blockers` | Third fact | None | justified: feature not yet built — req-122 |
| 7d | Video length, thumbnails, line numbers | `0:48`, sample | Fixture | justified: data instead of sample content |
| 7d | Thread | Ralf, Tessa relays | Mock lines | justified: data instead of sample content |
| 7e | Header | Filter, Cost by column | New idea | justified: feature not yet built — E13-17, E12-16 |
| 7e | Capacity height | 103 | 103 in the spec; 280 by default | open, O7 |
| 7e | Capacity width | Inside the page, inset 16 | Edge to edge | justified: base chrome, the bottom dock is the frame's |
| 7e | Budget bar | Grey | Accent | fixed (F8) |
| 7e | Slot dots | All a persona's slots | One per live run | justified: feature not yet built — E13-19 (G-14) |
| 7e, 7f, 7k | Persona order | Paul, Ben, Ralf, Tessa | Ben, Paul, Ralf, Tessa on the desk fixture; order not traced | open, O12 |
| 7e | Card persona, costs, left status hint | Sample, `412 words` | `unassigned`, `2 running` | justified: data instead of sample content |
| 7f | Detail list | 167 wide | 150 | fixed (F7) |
| 7f | Head, cards | New persona, Edit, Talk 1:1, Friction, Runs after, Notify, slot bars, tiles, Remove | Absent | justified: feature not yet built — E13-19 |
| 7f | Stop confirmation (hand state) | Fits the card, right dock folded | Same with the dock folded; with the Assistant open Stop overflows the card, `waiting` clips | open, O7 |
| 7f | Tickets panel (hand state) | In place | Scrolled 75 px sideways after Crew with the Assistant open | open, D-48 |
| 7g | Tree | Commonly used | None | justified: feature not yet built — req-133 |
| 7g | Tree pages, page rows, Devices, search hits | Board's lists | The app's | open, O9 |
| 7g | Filter, `Changed · default` | Shown | None | justified: feature not yet built — req-132 |
| 7g | Budget field, pause | Field | Sum of budgets | justified: feature not yet built — E13-12b |
| 7g | Resume unit | `every day` | None | open, O9 |
| 7g | Field placeholder | `Search settings` | Same | justified: integrator's ruling 2026-11-07, milestone 197 |
| 7g | Data | Paul, Ben…, `On` | The vault's | justified: data instead of sample content |
| 7h | Layout menu width | 294 | 280 | fixed (F6) |
| 7h | Rename, Delete | Enabled | Disabled on Notes | justified: Notes is built in, ADR-0089; the board's view is a user view |
| 7h | Files head and rows | `Notes vault`, 26 px, icons | 9a's head and 33 px rows | justified: the boards disagree, 9a is the frame's |
| 7h | Placeholder | `Ask the model…` | `Ask anything…` | justified: the boards disagree, 9a's |
| 7i | Tab menu (hand state) | Inline list: Notes, Work, Go to the Work view, Close, Move, Split | Flyout, longer menu, no Go to the Work view | open, O13 |
| 7i | Panel rows | `2 here · 3 elsewhere` | Fixture's | justified: data instead of sample content |
| 7j | Verdict | `The verifier recommends accepting.` | None | justified: feature not yet built — req-124 |
| 7j | Meta `T-0118 · $1.84` | Shown | None | justified: base chrome (milestone 192) |
| 7j | Counts, thumbnails | 4/4, labels | 3/3, fixture's | justified: data instead of sample content |
| 7k | Upload, Allowed to, tokens, Add skill, one line | Shown | Absent | justified: feature not yet built — E13-19, req-142, req-143, req-137, req-144 |
| 7k | Skills sentence | Shown | Absent | justified: feature not yet built — D-46 |
| 7k | Paths, save state | `personas/ben.md`, committed | `personas/ben/…`, `Saved` | justified: data; E13-19 |
| 10t | Desktop bar | `2 running · 1 stuck · 1 queued` | None | open, O4 |
| 10t | Desktop dot | Grey off, peach paused | None off, orange paused | justified: feature not yet built — req-134 |
| 10t | Popover radii, resume chip on On | 12 / 6, shown | 16 / 8, Paused only | justified: owner ruling 2026-11-07 (decisions.md); engine, milestone 189 |
| 10t | iPad, phone frames | Sample frame | Real screen behind | justified: data instead of sample content |
| all MC | Radii, mono | 12, 6, 18, Consolas | 8, 4, 16, `--mono` | justified: owner decision 4, token |
| all MC | Text | Headless Edge | Chromium | justified: text rasterization, no CSS difference found |
| all MC | Composer placeholder grey | Browser default | Token | justified: a token in place of a hex |
| all iPad | Assistant target | `Model · Mission Control` | `Mission Control · Capacity` | justified: owner decision notes.md navWidth; feature not yet built — req-127 |
| 10a | Question why | Paul's chat questions | Worker questions only | justified: feature not yet built — req-118 |
| 10b | Chat weekday | `Mon` | Fixed clock's `Fri` | justified: data instead of sample content |
| 10c | Row detail | `plan v3`, `$0.00` | Age, no cost before a run | justified: data instead of sample content |
| 10d, 10o, 10e, 10q, 10s, 5b | Flow | Phases, one or two lines | The six states, one line more, all below 23 px lower | justified: feature not yet built — req-99c |
| 10d, 10e, 10s | Parts cost | Spent, per part | Empty, per persona | justified: feature not yet built — req-116 |
| 10o | Cost by phase names | Plan, Review | Shaping, Ready to try | justified: feature not yet built — req-99c |
| 10o, 10q | Check run time | `tessa · 0:12` | Tester | justified: feature not yet built — req-117 |
| 10o, 10q, 10d, 5h | Proof strip spacing | Gap 6 | Text space | fixed (F13) |
| 10g | Away and alerts, Repositories | Rows | Absent | justified: feature not yet built — E12-3b |
| 10g | Resume | `18:00` | Empty while On | justified: the record holds it only while Paused, milestone 189 |
| 10i, 5d | `waiting`, queued run, `1 queued` | Shown | `running`, live runs | open, O11 |
| 10i, 5d | Setup rows | Runs after, Notify, tiles, slot bars, Remove | Absent | justified: feature not yet built — E13-19 |
| 10i | Pause all label | y 250 | y 251; icon and box in place | justified: text rasterization, no CSS difference found |
| 10j, 5c | Estimates | Per part | Per persona | justified: data instead of sample content |
| 10k, 10n, 10r | Counts | `84 notes`, `14` | Absent | justified: feature not yet built — req-115 |
| 10k, 10n, 10r | Titles | Apart from file names | File name | open, O11 |
| 10l | Task rows, link card | y 369 | 1 px lower from the first task row; no CSS cause traced | open, O14 |
| 10m | Autopilot icon | None | Icon | justified: integrator's ruling Q6, 10a and 10t win; not in decisions.md |
| 10m | Second change | `Shape →…` | `Inbox → Shaping` | justified: data instead of sample content |
| 10p, 10r | Live Preview title, heading, tags, source box | 26/700, 20/700, gap 8, `##` grey | Lighter, gap 13, white | fixed (F15) |
| 10p | Keyboard | iPhone keyboard | None, bar at the foot | justified: the OS's, the client cannot draw it |
| 10r | `See T-0121` line | Shown | Not in the fixture's note | justified: data instead of sample content |
| 10n, 10r | Thread | Conversation | Empty | justified: data instead of sample content |
| 10n | Pencil x | 826 | 827 | open, O14 |
| 10f | Back | None | `‹ T-0121` | justified: integrator's ruling Q2 (decisions.md) |
| 10f | `+` | x 1168 | x 1164 | fixed (F14) |
| 10f | Bubble y | 200 | 201; message below in place; not traced | open, O14 |
| 5b | Mark age | `· 2 min ago` | None, so text wraps later | justified: feature not yet built — req-128 |
| 5b | Thread, bold, list meta | Sample | Fake desk's | justified: data instead of sample content |
| 5c | Step rows | `✓ Shape…` | None | justified: feature not yet built — req-129 |
| 5c | Flow | `✓ Shape Plan (waits…)`, `standard ·` | Plain list | open, O10 |
| 5c | Paul's message | Shown | None; the card sits 20 px lower | justified: data instead of sample content |
| 5d | Run title overflow | Clipped `to re` | Ellipsis | open, O15 |
| 5d | Pool model name | Local y 322 | y 320 | open, O14 |
| 5d | Crew bar, cards below | Sample | Fake desk's | justified: data instead of sample content |
| 5f | This vault, filter, Open sidebars, Editor | Shown | Absent | justified: feature not yet built — req-130 |
| 5f | Categories | Assistant, Editor, Tickets | Chat, Devices, Engine, Autopilot | justified: integrator's ruling Q5; not in decisions.md |
| 5h | Accept width | 177, 17 px | 168, 16 px | fixed (F10) |
| 5h | Video length y | 333 | 329 | fixed (F11) |
| 5h | Amount | 15 px | 14 px | fixed (F12) |
| 5h | Viewed marks, range hint | On the desk, press and drag | Per device, `Tap a second line…` | justified: feature not yet built — E11-2c |
| 5i | `View as command`, dictate, model select, `Paul proposes…` | Shown | Undo draft, read-only | justified: feature not yet built — req-131, E10-5b |
| 5i | Who, Model, gate sub | `Ralf · reviewer`, `sonnet` | `Ralf`, `sonnet, pinned` | justified: data instead of sample content |
| 10e, 10q | Decision link, thread, tiles, runs | Sample | Fake desk's | justified: data instead of sample content |
| 10s | Under the Parts | Empty | Cost by phase | justified: owner decision 19 |
| Main | Whole board | Concept diagram | No app screen | justified: reference only (boards/README); nothing to shoot |
| 7b | Composite (hand: ticket document, Mission Control target) | Document and Assistant conversation | `DeskShape.composite.png`: one shot reached; thread and card empty, the store fixture seeds no conversation | noted: the board's conversation is compared on the desk-assistant half |
| 7c | Composite (hand) | Document, step rows, decision card | `DeskPlan.composite.png`: one shot reached; no decision card, the fixture seeds no proposal | noted: the card is compared on the desk-assistant half, whose document is an old-store ticket |
| 7j | Composite (hand) | Document, decision card | `DeskReady.composite.png`: one shot reached, no decision card | noted: as 7c |
| 7d | Composite | Review tab, Mission Control target with card | Not shot as one state; the Review tab is in desk-tickets, the target and card in desk-assistant | noted: compared half by half, the target differs per half |
| 7a | Composite | Ticket document, Mission Control target with card | Not shot as one state; document in the hand state with target Model, target and card in desk-assistant | noted: compared half by half, the target differs per half |
| 9a | Ticket card shot | Card | From `fidelity-desk-tickets` (test fixed, F17): matches the board but for the rows above; the frame from `fidelity-deskclean` | noted: as the integrator ruled |

## Per board

- **1 (Main)**: reference — 0 fixed, 0 justified, 0 open
- **5b (PadShape)**: pass — 0 fixed, 7 justified, 0 open
- **5c (PadPlan)**: rows open — 0 fixed, 7 justified, 1 open
- **5d (PadTeam)**: rows open — 0 fixed, 5 justified, 3 open
- **5f (PadSettings)**: pass — 0 fixed, 5 justified, 0 open
- **5h (PadReview)**: pass — 4 fixed, 4 justified, 0 open
- **5i (PadFlow)**: pass — 0 fixed, 5 justified, 0 open
- **7a (DeskWork)**: rows open — 4 fixed, 16 justified, 5 open
- **7b (DeskShape)**: rows open — 4 fixed, 17 justified, 5 open
- **7c (DeskPlan)**: rows open — 4 fixed, 18 justified, 5 open
- **7d (DeskReview)**: rows open — 4 fixed, 17 justified, 4 open
- **7e (DeskBoard)**: rows open — 4 fixed, 14 justified, 6 open
- **7f (DeskTeam)**: rows open — 4 fixed, 11 justified, 7 open
- **7g (DeskSettings)**: rows open — 1 fixed, 9 justified, 4 open
- **7h (DeskViews)**: rows open — 2 fixed, 10 justified, 2 open
- **7i (DeskTabs)**: rows open — 1 fixed, 8 justified, 3 open
- **7j (DeskReady)**: rows open — 4 fixed, 18 justified, 4 open
- **7k (DeskPersona)**: rows open — 3 fixed, 13 justified, 5 open
- **9a (DeskClean)**: rows open — 1 fixed, 8 justified, 3 open
- **10a (MPhoneChat)**: pass — 0 fixed, 4 justified, 0 open
- **10b (MPhoneMenu)**: pass — 0 fixed, 4 justified, 0 open
- **10c (MPhoneWork)**: pass — 0 fixed, 4 justified, 0 open
- **10d (MPhoneTicket)**: pass — 1 fixed, 5 justified, 0 open
- **10e (MPadWork)**: pass — 0 fixed, 7 justified, 0 open
- **10f (MPadChat)**: rows open — 1 fixed, 4 justified, 1 open
- **10g (MPhoneSettings)**: pass — 0 fixed, 5 justified, 0 open
- **10h (MPhoneAppearance)**: pass — 0 fixed, 3 justified, 0 open
- **10i (MPhoneTeam)**: rows open — 0 fixed, 5 justified, 1 open
- **10j (MPhonePlan)**: pass — 0 fixed, 4 justified, 0 open
- **10k (MPhoneNotes)**: rows open — 0 fixed, 4 justified, 1 open
- **10l (MPhoneNote)**: rows open — 0 fixed, 3 justified, 1 open
- **10m (MPhoneProposal)**: pass — 0 fixed, 5 justified, 0 open
- **10n (MPadNotes)**: rows open — 0 fixed, 6 justified, 2 open
- **10o (MPhoneReady)**: pass — 1 fixed, 6 justified, 0 open
- **10p (MPhoneNoteEdit)**: pass — 1 fixed, 4 justified, 0 open
- **10q (MPadReady)**: pass — 1 fixed, 7 justified, 0 open
- **10r (MPadNotesEdit)**: rows open — 1 fixed, 7 justified, 1 open
- **10s (MPadPortrait)**: pass — 0 fixed, 6 justified, 0 open
- **10t (Autopilot)**: rows open — 0 fixed, 3 justified, 1 open

Counts: 39 boards reviewed (9b excluded), 17 with no open row of their own or shared (Main is reference only), 130 table rows: 13 fixed, 88 justified, 23 open, 6 noted; 16 items on the open list.
