# Mission Control on the desktop: part of Drey, not an app next to it

Status: design, confirmed by the owner on 2026-11-04 as "A+" (native
tabs with the Assistant at the centre). **Built so far (state of milestone
132):** views (E13-1, 123, ADR-0089), view presets and home views (E13-2, 127),
the status bar slot (E13-3, 124), the link fallback (E13-4, 125), the ticket as
a document (E13-6, 129), the Board and Crew tabs and the Capacity band (E13-8,
130), the Review tab (E13-7, 139). **Also built since:** Assistant conversation targets (E13-5, milestone 138). **Built since:** Shape in Drey (E13-9, milestone 144). **Not built:** the Parts block (E13-10), the Flow tab (E13-11),
Settings → Tickets (E13-12), the Work view preset (E13-13); the roadmap holds
the order. The boards are in the design canvas "Drey Tickets — Workflow
redesign", row "Desktop in Drey", boards 7a to 7j. The whole concept is in
[architecture-concept-v2.md](architecture-concept-v2.md) (§3.4a).

## Why

The phone and iPad client (`apps/mission-control`) is a companion. On the
desktop it feels like an umbilical cord: it can steer the runners, but it has
no Drey editor, no dock panels, no split panes, and no link to the other tools
(Search, Tags, Backlinks, Git, Assistant). The desktop client is therefore not a
bigger copy of the iPad layout. It uses what Drey already has.

Names follow the owner decision D7: **Pia is Mission Control**, the one contact;
**Paul** is the planner persona; the default crew is Paul, Ben, Ralf, Tessa.

## The sorting rule

| What it is for | Where it lives |
|---|---|
| Overview and navigation | Dock panel (Tickets, Capacity) |
| Read, write, decide | Editor tab (ticket, Board, Review, Crew, Flow) |
| Ask and steer | Assistant panel, with a conversation target |
| State on the side | Status bar item, panel header status |

## Where each Mission Control concept goes

| Concept | Desktop place |
|---|---|
| Needs you, Shaping, Running, Ideas | Dock panel **Tickets** (exists; slimmed to the glance) |
| Pipeline overview, parts under their ticket, cost per column | Editor tab **Board** (new tab kind) |
| A ticket | Its Markdown file in the normal editor. The header strip shows persona, phase, cost, estimate, chain and the gate |
| Shape | The ticket in the editor plus Mission Control (Pia) in the Assistant, the ticket attached as a note. Paul, the planner persona, edits through live edit (ADR-0049); the owner types in the same document |
| Plan to accept | A **Parts block** inside the ticket (editor widget) written as `### Parts` |
| Review, proof | Editor tab **Review**: proof strip (video, chapters, screenshots), file list with viewed, Changes or Whole file, line comments, Send back / Accept. A file opens in the real editor |
| Chat | Assistant panel. Target **Model** is plain chat, no agent, no tools. Target **Mission Control** is the crew. A 1:1 per persona is a third target |
| Crew, capacity, cost | Editor tab **Crew** plus the **Capacity** panel in the bottom dock; fleet summary in the status bar |
| Flow editor | Editor tab **Flow**; the default flow is also in Settings |
| Settings | Settings, **Tickets**: crew, default flow, budget, runners, devices and pairing. Appearance is Drey's own |

## Parity with the mobile client (owner, 2026-11-04)

The desktop shows at least what the phone and iPad show; the interaction
differs, the content does not. In particular:

- **Lists** (Tickets panel, Board cards): id, kind, persona, title, status line,
  age and the **cost** of the ticket on every entry, including Running, Shaping
  and Prioritized (with the wait reason).
- **Ticket header**: status chip, persona, phase, chain with who does what,
  cost in total and the estimate from history, and the gate when it waits on you.
- **Ticket document**: the engine's `## Proof` (summary line, checks with their
  notes, screenshots with captions, the walkthrough video) and a **Cost** table
  (phase, model, tokens, time, cost, total) are shown in the editor as widgets,
  the table at the end. In the Review tab the same proof sits above the diff.
- **Actions**: Send back, Accept and move to Commit, Thread, Open Review sit in
  a bar under the ticket; "Edit the ticket" needs no button because the ticket
  is already the editable document (source mode is in the `⋯` menu).
- Boards 7a (in progress), 7j (ready to try), 7d (review) and the list in every
  board carry these; the iPad boards 5a to 5i stay the reference.

## Views (owner, 2026-11-04: mandatory and first, not a second stage)

Without a way to switch, the agent system and the note app compete for the same
docks and tabs. Drey gets **views**: a view is a saved layout with its own docks,
open panels, split panes and open tabs, switched from a segmented control in the
title bar (Ctrl+1, Ctrl+2, a Views menu; board 7h).

- **Notes** is today's Drey: Files, Calendar, Outline, Backlinks; the Assistant
  talks to the model.
- **Work** is the arrangement of boards 7a to 7f: Tickets panel, ticket, Board,
  Review, Crew; the Assistant talks to Mission Control.
- Opening a ticket (a chip in a note, a notification, the capture hotkey)
  switches to Work. Opening a note from Work switches to Notes. The status bar
  and the Assistant history are global; a signal from the other view shows as
  "3 need you in Work".
- **Tabs belong to views (owner, 2026-11-04).** Each view has its own tab set.
  Tabs of other views are fully hidden: not in the tab bar, not in the quick
  switcher. A tab can still be brought into a view on purpose, and it may belong
  to several views: the tab's context menu ticks the views it appears in
  ("Show this tab in: Notes, Work"), and the Open windows panel lists "In other
  views" with a **Show here** button (board 7i). A tab is not duplicated: it is
  one document in several views. Closing it in one view removes it from that
  view only; it closes for good when no view holds it.
- Later: user-defined views ("Save current layout as a view…").
- Base work: `DockService` state and the `PaneService` tree move from one global
  slot to one slot per view; the session snapshot (ADR-0043) stores the active
  view and each view's tabs; "Reset layout" resets the current view. This is the
  extension of ADR-0019 and ADR-0037/0038 that needs its own ADR.

## Changes in Drey itself (the owner allows SDK and base changes)

0. **Views** (above).
1. **A status bar slot for plugins** (SDK, content-agnostic): text, icon, tooltip,
   click action and priority, nothing else. No fleet, ticket or cost
   semantics in the SDK; the tickets plugin only fills the slot. Today a
   plugin only gets `statusText` for the active tab.
2. **Assistant conversation targets.** Model (any LLM provider, no tools, no
   agent), Mission Control, 1:1 per persona. This is what makes the Assistant
   part of the work instead of a separate chat.
3. **New editor tab kinds**: Board, Review, Crew, Flow, built on the existing
   `registerDocKind`; Review uses the existing `DiffView`.
4. **Parts block** as an editor widget under the ticket header.
5. **Links fall back to other vaults** (owner, 2026-11-04). Wikilinks are
   vault-scoped (ADR-0051/0059) and the tickets repository is its own vault, so
   `[[T-0121]]` from a note does not resolve today. The fix is generic, the base
   must not know a "tickets vault" (that would break the plugin separation,
   ADR-0044): a link is resolved in its own vault first, and **only when it
   cannot be resolved there** are the other registered vaults searched. No SDK
   change is needed. Rules:
   - Order of the fallback vaults: the active vault (when it is not the link's
     own), then the registry order. Within a vault the existing rules hold
     (unique name, sibling, shortest path).
   - The first vault in that order with a match wins. A name found in several
     fallback vaults is ambiguous: the first match opens, and the link check and
     the hover name the vault and mark the ambiguity.
   - A name that exists elsewhere no longer creates a new note on click; a
     per-vault setting ("Also look for link targets in other vaults", Settings,
     Vault, default off) keeps the old behaviour for whoever wants it.
   - Backlinks count a link from vault A that resolved into vault B as a
     backlink of the target in B. Ticket ids are stable names and survive the
     move between phase folders.
   - Link-integrity rewrites on rename (ADR-0059) stay per vault; tickets are not
     renamed. A later-change note goes into ADR-0051 and ADR-0059.

## Plain chat without an agent: what the code says

The Assistant router (`electron/llm/providers/`) has an OpenAI-compatible
provider (local and hosted presets), the Anthropic Messages API, and the Claude
Code and Copilot command lines. The API providers are plain chat unless tools
are attached. The Claude Code command line runs its own agent loop (`claude -p`);
as plain chat it needs its tools switched off. opencode and claude-code in the
fleet (`plugins/tickets/main/fleet/assignment.ts`) are runner workers, a
separate registry from the Assistant providers.

**Decision (owner, 2026-11-04): stay with the LLM integration Drey already has.**
The Assistant's Model target and Mission Control's own chat use the existing
`LlmRouter` and the providers registered in Settings. Another model such as Kimi
is registered there (an OpenAI-compatible endpoint with a base URL, model id and
optional key), not in a new registry and not as a new provider. The fleet's
runner workers keep their own pools for runs. Whether a persona's model pool
should one day list the Settings models too is a separate question and not part
of this step.

## Open decisions

1. (Closed: generic fallback to the other vaults, opt-in per vault, see Changes
   in Drey itself, item 5.)
2. (Closed, owner 2026-11-04: the Parts block is inline in the ticket, board 7c.)
3. (Closed: models are registered in the existing LLM settings, see above.)
4. Companion rule: the iPad and phone client stays; the desktop does not embed
   it. Shared code is the engine contract, not the UI.

## Suggested order

Views first and mandatory (they decide where everything else sits), then view presets, then the ticket header with
the gate, the Assistant targets (Shape needs them), the
Parts block, the Review tab, the Board tab, the Crew tab and Capacity, Flow, and
the status bar item. Each step is its own milestone and gets its own roadmap
entry before work starts; this file does not claim a milestone number.
