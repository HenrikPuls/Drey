# Mission Control on the desktop: part of Drey, not an app next to it

Status: design proposal, confirmed by the owner on 2026-11-04 as "A+" (native
tabs with the Assistant at the centre). Nothing here is built. The boards are in
the design canvas "Drey Tickets — Workflow redesign", row "Desktop in Drey",
boards 7a to 7g.

## Why

The phone and iPad client (`apps/mission-control`) is a companion. On the
desktop it feels like an umbilical cord: it can steer the runners, but it has
no Drey editor, no dock panels, no split panes, and no link to the other tools
(Search, Tags, Backlinks, Git, Assistant). The desktop client is therefore not a
bigger copy of the iPad layout. It uses what Drey already has.

## The sorting rule

| What it is for | Where it lives |
|---|---|
| Overview and navigation | Dock panel (Tickets, Capacity) |
| Read, write, decide | Editor tab (ticket, Board, Review, Team, Flow) |
| Ask and steer | Assistant panel, with a conversation target |
| State on the side | Status bar item, panel header status |

## Where each Mission Control concept goes

| Concept | Desktop place |
|---|---|
| Needs you, Shaping, Running, Ideas | Dock panel **Tickets** (exists; slimmed to the glance) |
| Pipeline overview, parts under their ticket, cost per column | Editor tab **Board** (new tab kind) |
| A ticket | Its Markdown file in the normal editor. The header strip shows persona, phase, cost, estimate, chain and the gate |
| Shape | The ticket in the editor plus Pia in the Assistant, the ticket attached as a note. Pia edits through live edit (ADR-0049); the owner types in the same document |
| Plan to approve | A **Parts block** inside the ticket (editor widget) written as `### Parts` |
| Review, proof | Editor tab **Review**: proof strip (video, chapters, screenshots), file list with viewed, Changes or Whole file, line comments, Send back / Accept. A file opens in the real editor |
| Chat | Assistant panel. Target **Model** is plain chat, no agent, no tools. Target **Mission Control** is the team. A 1:1 per persona is a third target |
| Team, capacity, cost | Editor tab **Team** plus the **Capacity** panel in the bottom dock; fleet summary in the status bar |
| Flow editor | Editor tab **Flow**; the default flow is also in Settings |
| Settings | Settings, **Tickets**: team, default flow, budget, runners, devices and pairing. Appearance is Drey's own |

## Changes in Drey itself (the owner allows SDK and base changes)

1. **Status bar items for plugins** (SDK). Today a plugin only gets `statusText`
   for the active tab.
2. **Assistant conversation targets.** Model (any LLM provider, no tools, no
   agent), Mission Control, 1:1 per persona. This is what makes the Assistant
   part of the work instead of a separate chat.
3. **New editor tab kinds**: Board, Review, Team, Flow, built on the existing
   `registerDocKind`; Review uses the existing `DiffView`.
4. **Parts block** as an editor widget under the ticket header.
5. **Links across vaults.** Wikilinks are vault-scoped (ADR-0051/0059) and the
   tickets repository is its own vault, so `[[T-0121]]` from a note does not
   resolve today.
6. **Later: saved layouts** ("Notes", "Work"), so the arrangement in 7a is one
   click away.

## Plain chat without an agent: what the code says

The Assistant router (`electron/llm/providers/`) has an OpenAI-compatible
provider (local and hosted presets), the Anthropic Messages API, and the Claude
Code and Copilot command lines. The API providers are plain chat unless tools
are attached. The Claude Code command line runs its own agent loop (`claude -p`);
as plain chat it needs its tools switched off. opencode and claude-code in the
fleet (`plugins/tickets/main/fleet/assignment.ts`) are runner workers, a
separate registry from the Assistant providers. Unifying the two lists, so a
persona and the Assistant know the same models, belongs with the Assistant
targets.

## Open decisions

1. How a note links to a ticket across the vault boundary: vault-wide
   wikilinks for the tickets vault, a `ticket:` syntax, or the tickets
   repository under the notes vault (ADR-0083).
2. The Parts block inline in the ticket or as a split tab beside it.
3. Whether Kimi is added as an OpenAI-compatible endpoint (probably no code) or
   as a command-line provider.
4. Companion rule: the iPad and phone client stays; the desktop does not embed
   it. Shared code is the engine contract, not the UI.

## Suggested order

Ticket header with the gate, then the Assistant targets (Shape needs them), the
Parts block, the Review tab, the Board tab, the Team tab and Capacity, Flow, and
the status bar item. Each step is its own milestone and gets its own roadmap
entry before work starts; this file does not claim a milestone number.
