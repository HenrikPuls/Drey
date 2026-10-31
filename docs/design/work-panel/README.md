# Work panel design (req-75, ADR-0087)

The owner's canvas "Drey Tickets — Workflow redesign" (2026-10-31), one
static HTML artboard per screen. It is the **binding reference for the
look and the visible strings** of every req-75 stage: build as close to
it as the plugin structure allows, and name each deviation in the
ticket's Log.

| Artboard | Shows | Stage |
|---|---|---|
| `Main.dc.html` | The flow, idea to running code | all (overview) |
| `Home.dc.html` | Work panel (Needs you, Shaping, Running, Ideas, Done this week, worker footer) beside a ticket thread with a question | W1, W1b, W2 |
| `Ticket.dc.html` | One ticket with its worker live: now, recent actions, controls | W4 |
| `Workers.dc.html` | All workers, see and step in, a stuck worker | W4 |
| `Ready.dc.html` | Ready to try: changes, Launch this version, Accept and merge, Send back | W3 |
| `Shaping.dc.html` | Shape track: plan-mode dialog with project context chips, the plan beside it | W6 |
| `Orchestrator.dc.html` | Plan to approve: phase tickets, routing, touches, gates | W6, W7 |
| `PhoneInbox.dc.html` … `PhoneCapture.dc.html` | The phone client as a chat | W8 |

How to read them: the markup is plain HTML with inline styles; `{{…}}`
holes are filled from the `renderVals()` sample data at the bottom of
each file — that sample data shows realistic content, not strings to
ship verbatim (ticket titles, model names, counts).

Rules when building from them:

- **Colours are the Anthrazit theme's.** Use the app's theme tokens
  (`src/styles.css`: `--bg-main`, `--bg-sidebar`, `--border`,
  `--text-primary`, `--text-3`, `--accent`, `--accent-surface`, the
  `--status-*` hues …), never the hex values — Drey ships three themes.
- **Strings**: labels, buttons, headings, chips and empty states are
  copied verbatim (they are English). Data (titles, ages, counts) comes
  from the board.
- **Plugin structure**: the panel is a dock widget, the ticket page is
  the editor tab plus the plugin's thread tab, the app's own titlebar
  and status bar belong to the base (a plugin cannot draw into them).
  Those are the permitted deviations.
- Panel header controls stay icon-only with `title` + `aria-label`
  (ADR-0057), as the artboards already draw them.
