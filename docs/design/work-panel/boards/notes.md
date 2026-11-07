# Canvas notes (exported 2026-11-06 from the design canvas, version 1793992275-ade0)

The sticky notes of the canvas, verbatim. Decisions bind (see `decisions1104`).

## alignMC

Aligned with the architecture concept

One conversation partner: Shape is Mission Control working with Paul (the planner) on a ticket. Paul is relayed, never a second chat.

The plan is the shared document; your edits ride along with the next message.

Plan to accept is a Mission Control proposal. Personas replace the routing rules file; a ticket may pin a model.

The router is a policy inside a persona pool, not a persona.

Names: Pia is Mission Control itself. Paul plans, Ben builds, Ralf reviews, Tessa tests.

## changeDesk

What changes in Drey itself

1. Views: saved layouts (docks, panels, panes, tabs) with a switcher in the title bar. Notes and Work.
2. Status bar items for plugins (fleet summary).
3. Assistant conversation targets: Model or Mission Control, 1:1 per persona.
4. New editor tab kinds: Board, Review, Crew (and Flow).
5. A Parts block inside the ticket (editor widget).
6. Links between notes and tickets across vaults.

In the roadmap as E13-1 to E13-13.

## cleanNote

9a: cleaned up inside the existing frame

The frame stays as it is: docks with the plugin icon row on top, editor tabs with the path line, status bar. Only things inside a plugin, the panel headers and the view switch change.

Docks: the icon row toggles which panels are shown (several at once). Shown panels stack. Each gets a slim 28 px header: collapse arrow, title, count. Its actions (+, collapse all, month arrows) appear on hover or focus. The whole header is the drag handle, right-click opens move / detach / close; no grip, no extra title row. Every panel keeps this header, also when it is alone in its dock, so the title is always written out and the drag works the same everywhere (right dock: Search collapsed above the Assistant). Active icons use grey, not the highlight color.

View switch (title bar): Notes · Work · Crew as one segmented control. The loose dot / save / reload icons become a dot on the view whose layout changed plus one Layout ▾ menu (save, reset, save as new view, rename, delete). Row 7 uses the same frame now.

Ticket widget (tickets plugin, inside the Markdown editor): one card above the document. ID, status once, the next step as the one primary button (Start build), Thread opens the ticket's conversation in the Assistant. Priority, worker, flow, repo in one quiet grid. Gone: the Ticket / Thread / Review switch, the second status pill, the floating Thread / Open Review buttons. Review shows up as a button only when there are changes, and opens the Review tab.

Assistant plugin: the target icons (Model, Mission Control, Crew 1:1) become one segmented group that names the active target. No rail on the left of messages: your message is a bubble on the right, the answer plain text with one meta line. Composer and the row below unchanged.

Type: UI 14 px, ticket body 16 px, answers 15 px.

## decisions1104

Decisions 2026-11-04

1. Capture shortcut is Ctrl+Alt+T (Mod+Alt+T), not Ctrl+Alt+N.
2. No "Add part" button: the plan is edited as Markdown or with Paul.
3. No Mermaid gate diagram; the flow editor stays.
4. Anthrazit tokens win: peach / pink / mint attention colors, radii 4 / 8 / 16, type 13 px minimum (12 px only for dense desktop list metadata), token greys.
5. Plan steps live in the Parts block (status icon + text, persona, cost); the open question is an answer card above the Assistant composer plus a plain "Open questions" list in the ticket.
6. Board 7e has no explanatory subtitle.
7. Voice is a microphone button (Dictate) in the Assistant composer, not a capture flow.
8. Text size is a slider with five steps, S / M / L / XL / XXL = 15 / 16 / 17 / 19 / 21 px body; L (17 px) is the default.
9. This note lists the decisions for the code session.
10. The tab is called Crew everywhere (2026-11-06), never Team.
11. The decision verb is Accept (plans and results), not Approve and not Sign off.
12. iPad works like the desktop: header with the left-sidebar toggle, the view switch Notes · Work · Crew and the right-sidebar toggle; left sidebar = list of the area, centre = document, right = Mission Control. Landscape opens with all three, portrait with the left sidebar and the centre; the state is saved per orientation and restored at the next start.
13. Desktop web (the browser app on a wide screen) keeps its top tab bar with the docked chat.
14. The product is called Drey Crew; the tab and area inside it are called Crew.
15. One state list, six states: Inbox → Shaping → Prioritized → Building → Ready to try → Done; Review is a phase, not a state; every surface and every board column uses these names, no Commit, no Ideas, no numbered folders in the UI. The engine follows with the dricket migration.
16. One decision, one place: the decision card of Mission Control; no second Accept button in the ticket body, a link "Decision waiting · go to the card" instead.
17. Phone navigation: the menu is the root without a back button, every other screen has one labelled back button to its parent, no hamburger on the phone.
18. Notes on phone and iPad can be edited with the Markdown editor (View · Live · Source); the pencil icon starts editing in Live Preview, Cancel (X) and Save (check) are icons.
19. The cost-by-phase table is shown on desktop, iPad and phone.
20. Estimates read "$3.00–5.20 · from 3 runs" or "no estimate yet (first run)"; cost text is grey, orange only means needs you.
21. Autopilot: one switch with three states (On, Paused, Off) on every device: desktop status bar item and Mod+Alt+P, iPad header chip, phone app bar icon with a sheet (board 10t). "Stop all running steps now" is a separate confirmed action.
22. Accept lives only on the Mission Control decision card; the desktop Review tab keeps diff, line comments and "Send back", plus the link to the card (O-1).
23. The state list rides on the dricket migration: all tickets are migrated once into the new store; no rename inside the old numbered folders (O-3).
24. i18n: one ICU runtime (intl-messageformat) with JSON catalogs in shared/ for main, renderer, plugins and Mission Control; English first (O-4).
25. Autopilot restores as Off after every start; a timed Paused ends as Off (O-5, ADR-0077 ruling kept).
26. Confirmed (O-2, 2026-11-06): Review and Ready to try are one state; Accept there is the sign-off that merges, pushes and lands in Done.
27. Order: the six-state vocabulary and the migration mapping land in the engine before the dricket cut-over import, so the import writes the six stages once (Q1).
28. Desktop: Accept lives on both Mission Control surfaces, the Needs-you row / Ready card in the Work panel and the decision card in the Assistant; ticket document, Review tab and ticket strip lose it (Q2).
29. Shaping and Prioritized are manual columns; Building is the only agent column, with Plan, Build, Review and Test as phases of its chain; Ready to try is manual (Q6).
30. Accept merges and pushes the developed program's repository (the target repo the agents changed), as the owner-started commit step; the dricket ticket moving to Done is the bookkeeping result (Q8).
31. Technical calls: Autopilot state is an autopilot record beside the chain master in chain.json, the engine resumes; iPad pane state per device in localStorage by orientation; Notes reuse the existing Markdown surface (formatting strip later); the fifth text-size step ships with the Appearance item.

## findNote

9c: Find — Search and Tasks as one panel (req-161; owner: direction A on 2026-11-07, simplified and accepted on 2026-11-08)

One panel "Find" in the left dock, strip icon search, Ctrl+Shift+F. Replaces the Search and Tasks panels and their strip icons.
Header 28 px: the mode is the title, Search | Tasks (13 px, active 600 --text-primary, other --text-4, buttons h24 padding 0 6), then the status: "6 in 3 files" / "6 open"; a scope other than This vault is named in it ("2 in this note", "14 open in all vaults"). One control: ⋯ More (24 px), shown on hover, keyboard focus or while the panel is active (req-163).
Field 32 px (--bg-search, --field-border, radius 8; focus --accent): search icon, tag chips + free text, #tag completion from the vocabulary, Clear (only with content), Replace switch (Search mode only). Replace on shows a second field with Replace all. No placeholder.
⋯ Search: Look in (This note · This vault · All vaults) | Match case · Whole word · Regular expression · Include chats | Export results to a note · Summarize.
⋯ Tasks: Look in | Show done · Checkbox tasks · #task lines | Order: File order · Due date · Priority.
Lists: group head 28 px per file (name 13/600, folder 13 --text-4, count right); rows 52 px. Hit: heading 14/20 + :line, snippet 13/18, the match on --accent-surface. Task: checkbox 16, title 14/20, meta 13/18 (due, priority, heading). Ordered by due date, the groups are Overdue · Today · Later · No date.
Type 13/14 only. Colours are tokens of src/styles.css; no new hex. Icons from the set only (search, x, replace, check, calendar, arrow-up, arrow-down, chevron-down, chevron-right, more-horizontal); Highest and High share arrow-up, the word tells them apart.

## mapDesk

Where things live in Drey

Overview and navigation: dock panel (Tickets, Capacity).
Read, write, decide: editor tab (ticket, Board, Review, Crew).
Ask and steer: Assistant panel with a target: Model (plain chat, no agent) or Mission Control (the team).
State on the side: the status bar item and panel headers.

A ticket is its Markdown file in the normal editor. Shape is that file plus Paul (planner) through Mission Control (Pia) in the Assistant. Review opens files in the real editor.

## mobileNote

Row 10: one mobile system for phone and iPad

Navigation: on the phone the menu is the root screen; on the iPad the header carries the sidebar toggles and the Notes · Work · Crew switch, like the desktop.

Same pieces everywhere, built once: ticket rows (title 17 px, one grey meta line, cost grey, orange from 70 % of the allowance, red when used up), the ticket card from 9a (ID, status pill, Thread, then Flow / Worker / Cost), the answer card, the composer with Dictate.

Touch: every control 44 px or more, answer options 52 px, primary button 48 px. That is the only real difference to the desktop, which uses the compact answer list.

iPad = the desktop layout with touch sizes: list, document and Mission Control side by side. Active rows and places are grey, never the highlight colour.

Rows 5 and 6 are folded into this system (2026-11-06): iPad Shape, Plan, Review, Flow, Crew and Settings now use the sidebar and follow the desktop boards; the old phone boards 5e, 5g, 6a-6d are replaced by 10g to 10j or by 10a and 10b, which already covered chat and menu. iPad Work 5a is dropped (2026-11-06): 10e covers the list and the ticket, 5h the review, 10f the chat. What 5a had alone, the proposal card with Confirm / Dismiss, is now 10m.

Notes (10k, 10l, 10n): the vault is reachable from the phone and the iPad. Search, recent notes and folders; a note opens in View mode, the pencil icon edits it with the Markdown editor, tags and a link to its ticket, and "Ask about this note" opens Mission Control.

## navWidth

Navigation

Phone: no bottom tab bar, no hamburger. The menu screen is the root (Notes, Work, Crew, Settings, chats); every other screen has one labelled back button to its parent.

iPad: like the desktop. Header with the left-sidebar toggle, the Notes · Work · Crew switch and the right-sidebar toggle. Left sidebar = list of the area, centre = the document, right = Mission Control. Landscape opens all three, portrait opens the left sidebar and the centre; the open state is saved and restored.

Desktop web keeps its top tab bar with the docked chat.

The docked chat is always Mission Control, or Capacity. This changes concept section 7, which put a tab bar at the bottom on every size.

## panelsNote

9b: the panels of the current branch, same rules as 9a

Every panel: 28 px header (collapse arrow, title, count), its actions only on hover or focus, line icons, no grip.

Calendar: the month is the title (dropdown); today, previous and next on hover. Today grey, days with a daily note get a small dot.
Source control: repository · branch · ↑15 on one line, commit field with the commit icon inside, Changes as a sub-header (stage all on hover), file name in its status colour, folder grey, status letter right. History folded.
Outline: indented headings, the current one grey.
Search: one field with Aa / ab / .* inside, scope as three small icons beside it, the hit count in the header; replace, export, summarize and clear on hover. Files fold, hits show heading, line and two lines of snippet with the match lightly marked.
Tasks: filter field plus hide-done / by tag / by note; note path as a small grey group label; custom checkbox, task text, one grey meta line; an overdue date is red, done tasks grey and struck.
Ticket: the 9a card with Inbox status and Prioritize as the next step.

## rowClean

Drey as it is today — cleaned up

## rowDesk3

Desktop in Drey — Mission Control as part of the editor, not an app next to it

## rowFlow

The flow — idea to running code

## rowMC

Consolidated — Mission Control with Shape and Plan to accept

## rowMobile

Mobile, aligned — the iPad is the phone app with more room
