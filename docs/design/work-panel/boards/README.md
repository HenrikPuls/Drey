# The canvas boards — the binding reference for the look

Exported on 2026-11-06 from the owner's design canvas "Drey Tickets — Workflow
redesign" (artifact `a401ec8a-b3e4-459f-b9df-ff8893105b9f`, version
`1793992275-ade0`). **This folder is what "it looks like the design" means.**
A session that builds or changes a screen reads the board's HTML for the exact
measures, colours, spacing and strings, opens the PNG to see it, and compares
its own screenshot against the PNG before it reports done (see
[build-plan.md §4](../build-plan.md) for the fidelity rule). Text briefs,
roadmap entries and the concept describe behaviour; **the board decides the
appearance** where they disagree.

Files: one `<Name>.dc.html` per board (plain HTML, inline styles; the
`<x-dc>` / `<helmet>` wrappers are the canvas runtime's), `support.js` — a
small stand-in for that runtime, so the seven boards that hold a template
(`{{holes}}` from `renderVals()`, `<sc-for>`, `<sc-if>`: DeskClean,
DeskPersona, DeskSettings, PadFlow, PadReview, PadSettings, PadTeam) render
outside the canvas (it runs the board's own embedded sample-data script; the
other 33 boards are static and ignore it), one
`<Name>.png` rendered at the board's own size with headless Edge
(`--window-size=<w>,<h> --screenshot`), `canvas.json` (positions, sizes,
titles, order, notes) and `notes.md` (the sticky notes, decisions 1–31 under
`decisions1104`).

`compare.html` is the comparison viewer: open it in a browser, load a board
PNG and the screenshot taken at the board's size, and switch between side by
side, overlay, swipe and a pixel diff; the step-by-step is
[../fidelity-checklist.md](../fidelity-checklist.md).

Re-export when the canvas changes: read the artifact's `project/*.dc.html` and
`project/canvas.json`, copy them here, re-render the PNGs (the script used:
headless Edge over every `boards` entry of `canvas.json`), update the version
above.

## Index

| Board | File | Size | Device |
|---|---|---|---|
| 1 · The flow | `Main` | 1440×820 | reference |
| 5b · Shape: Mission Control shapes with Paul, plan in the middle | `PadShape` | 1194×834 | iPad |
| 5c · Plan to accept: one persona per part | `PadPlan` | 1194×834 | iPad |
| 5d · Crew: personas, what they run, stuck workers, Paul 1:1 | `PadTeam` | 1194×834 | iPad |
| 5f · Settings: theme, text size, and what else you need away from the desk | `PadSettings` | 1194×834 | iPad |
| 5h · Review a file, comment like a pull request | `PadReview` | 1194×834 | iPad |
| 5i · Shape the flow: standard by default, edit by hand or let Paul do it | `PadFlow` | 1194×834 | iPad |
| 7a · Work layout: ticket in the editor, Mission Control in the Assistant | `DeskWork` | 1440×900 | desktop |
| 7b · Shape: the plan is the ticket, Paul works in it through the Assistant | `DeskShape` | 1440×900 | desktop |
| 7c · Plan to accept: the Parts block inside the ticket | `DeskPlan` | 1440×900 | desktop |
| 7d · Review tab: proof, files, line comments like a pull request | `DeskReview` | 1440×900 | desktop |
| 7e · Board tab with the Capacity band in the bottom dock | `DeskBoard` | 1440×900 | desktop |
| 7f · Crew tab: personas, stuck worker, setup and cost | `DeskTeam` | 1440×900 | desktop |
| 7g · Settings like VS Code: search, collapsible sections, scope tabs | `DeskSettings` | 1440×900 | desktop |
| 7h · Views: Notes · Work · Crew, Layout menu with save, reset, rename, delete | `DeskViews` | 1440×900 | desktop |
| 7i · Tabs belong to views: hidden elsewhere, added with Show here | `DeskTabs` | 1440×900 | desktop |
| 7j · Ticket ready to try: proof, checks, screenshots, cost table, accept | `DeskReady` | 1440×900 | desktop |
| 7k · Persona setup: profile, picture, work, permissions, prompt blocks | `DeskPersona` | 1440×900 | desktop |
| 9a · Drey today, cleaned up — ticket T-0017 in Work, Assistant without the rail | `DeskClean` | 1440×900 | desktop |
| 9b · Drey today — Calendar, Source control, Outline, Search and Tasks redesigned — **not a target design** (owner, 2026-11-06; a sketch, nothing is measured against it) | `DeskPanels` | 1440×900 | desktop |
| 10a · Mission Control, answer card with big touch targets | `MPhoneChat` | 390×844 | phone |
| 10b · menu: the root screen with Notes, Work, Crew, Settings and chats | `MPhoneMenu` | 390×844 | phone |
| 10c · Work: the desktop ticket list, sized for touch | `MPhoneWork` | 390×844 | phone |
| 10d · ticket: same card as the desktop, question inline | `MPhoneTicket` | 390×844 | phone |
| 10e · Work, three panes: tickets, ticket, Mission Control | `MPadWork` | 1194×834 | iPad |
| 10f · Mission Control: chats next to the chat | `MPadChat` | 1194×834 | iPad |
| 10g · Settings: search and groups, same rows as the menu | `MPhoneSettings` | 390×844 | phone |
| 10h · Appearance: theme, text size, switches | `MPhoneAppearance` | 390×844 | phone |
| 10i · Crew: personas with picture, stuck worker, setup cards | `MPhoneTeam` | 390×844 | phone |
| 10j · Plan to accept: question card, Parts, Accept | `MPhonePlan` | 390×844 | phone |
| 10k · Notes: search, recent, folders of the vault | `MPhoneNotes` | 390×844 | phone |
| 10l · a note in View mode, pencil icon to edit, linked ticket, ask about it | `MPhoneNote` | 390×844 | phone |
| 10m · Mission Control proposes changes: Confirm or Dismiss each | `MPhoneProposal` | 390×844 | phone |
| 10n · Notes, three panes: files, note in View mode, Assistant | `MPadNotes` | 1194×834 | iPad |
| 10o · Ready to try: checks, cost by phase, one decision card | `MPhoneReady` | 390×844 | phone |
| 10p · editing a note: pencil, Live Preview, Cancel and Save as icons | `MPhoneNoteEdit` | 390×844 | phone |
| 10q · Ready to try, three panes: tickets, ticket with cost by phase, Mission Control | `MPadReady` | 1194×834 | iPad |
| 10r · editing a note: files, Markdown editor, Assistant | `MPadNotesEdit` | 1194×834 | iPad |
| 10s · iPad portrait — list and ticket, right sidebar closed | `MPadPortrait` | 834×1194 | iPad |
| 10t · Autopilot switch: on, paused, off — desktop status bar, iPad header, phone app bar | `Autopilot` | 1440×900 | all |

The older boards one folder up (`Home`, `Ticket`, `Workers`, `Ready`,
`Shaping`, `Orchestrator`, `Phone*` of 2026-10-31) are superseded by the
rows above and stay only as history.
