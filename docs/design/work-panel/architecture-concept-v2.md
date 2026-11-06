# Drey Tickets — Architecture Concept

**Status:** v2, English edition, reconciled with what was decided and built up to 2026-11-04 (milestone 132). Source: the owner's German concept v2 "Drey Tickets – Architekturkonzept v2 (Namen D7)", written 2026-11-03 (v1: 2026-11-01), itself reconciled with the design canvas "Drey Tickets — Workflow redesign" and the state of the Mission Control app.
**Related:** ADR-0075 (fleet), ADR-0076 (ticket repository), ADR-0077 (chain), ADR-0086 (remote), ADR-0087 (Work panel), [ADR-0088](../../09_architecture_decisions/0088-tickets-engine-package-cut.md) (engine package cut and its migration), [ADR-0089](../../09_architecture_decisions/0089-views-saved-layouts-with-their-own-tabs.md) (views) · Reference: letsship.ai (SHIP) · Companion documents: [README.md](README.md) (the canvas and how to build from it), [desktop-integration.md](desktop-integration.md) (Mission Control inside Drey).
**Purpose:** the target picture for the rebuild of the tickets system, fixed before code moves, so the rebuild does not become the next dead end. The design canvas is authoritative for UI detail; `specs/ticket-schema.md` is authoritative for the file format; `specs/roadmap.md` for what is still open.

## How to read this edition

This is a faithful English translation of the German v2, **updated** to the decisions and the code of 2026-11-04. Section numbers are those of the German v2. Every section carries a status line:

- **built** — code and specs exist on `desktop-integration`; milestone numbers in brackets. "Built" is never "owner-verified": every E0–E13 milestone from 97 onward still awaits the owner's round unless its changelog entry says otherwise.
- **planned** — a roadmap item exists (id in brackets); nothing or only part of it is built.
- **dropped / superseded** — decided against; the reason is in the section.

Where this edition deviates from the German text because a later decision or the code says otherwise, the text carries an *Update (2026-11-04)* note. The German source stays outside the repository; the repository's language rule (English documents) is why this edition exists.

### Decisions since v2 was written (D5–D11 and later)

| Id | Decision | Where it lands |
|---|---|---|
| D4 | Shape runs through Mission Control (Paul is handed on); verify in use | §5.8, §6 |
| D5 | **No overlap guard**, no touches or file routing between parallel tickets (req-75 W7 and W8 dropped, their tickets closed) | §5.9 |
| D6 | Line comments are structured Handover feedback (file, line, text) | §5.3 |
| D7 | **Pia is Mission Control itself**, the one contact. **Paul plans.** Default crew Paul, Ben, Ralf, Tessa. No design persona. | whole document |
| D8 | The persona detail's Chat and 1:1 tabs merge into one conversation | §4.3, §4.5 |
| D9 | Estimates need at least 3 similar runs; size classes (by file count) come later | §5.4 |
| D10 | Appearance is stored per device; everything else per vault | §7 |
| D11 | Product name **Drey Crew**, fallback **Kobel** (name check before any rollout; the code is not renamed) | §9 |
| — | Videos: **at most 25 MB per file, no retention by age or folder size** (owner, 2026-11-04) | §5.2, R6 |
| — | **Views** are mandatory and first on the desktop; tabs belong to views (owner, 2026-11-04) | §3.4a |
| — | **The Refine button goes away** in E13-9 (owner, 2026-11-04), not before | §5.8 |
| — | The Markdown surface comes out of `src/app/editor` into `libs/mission-ui` (E12-6); **View is the default wherever results are presented** | §3.7 |
| — | **Mermaid gate diagram dropped; Zod dropped; "Add part" stays excluded; Anthrazit design-system values win; no separate plan-step list; voice = dictation into the Assistant composer** (owner, 2026-11-04) | §3.3, §5.4, §5.9, §7 |
| — | E10-6: **you as a crew member** — a human persona and manual gates | §4.1, §5.7 |
| — | **Canvas of 2026-11-06 (version 47):** no top or bottom tab bar on phone and iPad — one menu (Search, Notes, Work, Crew, Settings, chats with Mission Control) behind a menu button; mobile gets **Notes**; the area is called **Crew** everywhere, never Team; the decision verb is **Accept** (plans and results), never Approve or Sign off; text size is a five-step slider S / M / L / XL / XXL = 15 / 16 / 17 / 19 / 21 px with L as default | §3.4a, §5.9, §7 |
| — | Stay with the LLM integration Drey already has: the `LlmRouter` and the providers in Settings; no new registry (owner, 2026-11-04) | §4.7, §6 |

> **Names (state of 2026-11-04, decision D7).** "Pia" is, in this edition, Mission Control itself, the place the owner talks to. The planner persona that earlier drafts called "Pia" is now **Paul**; the text says "Paul" wherever the planner is meant. Default crew: Paul, Ben, Ralf, Tessa. The design persona is dropped; examples of extra gates use a security review by Ralf. (The German D7 row says "Paul is Mission Control itself"; that is a slip for "Pia", corrected here and in the roadmap.)

## Changes against v1 (carried over from v2)

This version takes over the decisions of the design round of 2026-11-03. New or changed:

1. **Shape** is new: new tasks are worked out together with Paul; the plan is a shared document in Drey's Markdown editor; only the owner's changes go back to the model (§5.8). *(built, E10-1…E10-3, milestones 120–122)*
2. **Parts instead of phases:** a split plan consists of *parts*; "phase" stays reserved for the pipeline column. How many parts there are is proposed by the model, never fixed at three (§5.8, §5.9). *(built)*
3. **Plan to accept** (§5.9): persona per part, flow per part, reorder, delete, running parts locked, cost estimate. The routing-rules file and the touches display are dropped. *(built, E10-4, milestone 126)*
4. **Flow editor** (§5.7): the chain is shapeable by hand and by Paul, the standard stays the start, only the delta is stored. *(built, E10-5, milestone 128)*
5. **Costs** are a mandatory display on three levels with fixed places, plus an estimate from the own history (§4.3, §5.4). *(built, E11-4, milestone 119)*
6. **Proof** now always contains a short walkthrough video; approval gets a diff review with comments in pull-request style (§5.2, §5.3). This changes R3. *(built, E11-1…E11-3, milestones 116–118; size rule E11-1c planned)*
7. **Navigation:** no bottom or top tab bar on phone and iPad (canvas of 2026-11-06). One menu — Search, Notes, Work, Crew, Settings and the chats with Mission Control — behind a menu button; on the iPad the same list, with the docked chat always Mission Control or Capacity (§6, §7). *(Phone built, E12-2, milestone 113; the iPad's menu, Notes and the 10-row boards are not built, see convergence-gaps G-36 to G-41; only G-40 is still open.)*
8. **Chat history** is a screen inside the chat window itself (§6, §7). *(built, milestone 113)*
9. **Settings** are a core screen (theme, highlight colour, text size, more) so that nothing has to be set on the desktop (§7). *(built in part, E12-3, milestone 114; pages still missing: E12-3b)*
10. **Crew** shows what each persona is running right now, stuck workers and capacity; the worker table is gone (§4.3). *(built, E12-4, milestone 115)*
11. **iOS and iPad rules** are binding: safe-area insets, 44-point targets, type scale, switches, pointer and keyboard (§7). *(audit planned, E12-5)*
12. **Answer options** always sit directly above the input field; histories start at the top (§7). *(built)*
13. Stages E7 to E9 added after the fact, new E10 to E12 (§8); new risks and open decisions (§9); glossary extended (§10.2). **Added after v2:** E13 (the desktop integration) and D-1 (the chat reaches its model), §8.

---

## 1. Starting point and goals

> Status: context, no work item.

### 1.1 What works today (and stays)

- **The data format** (`specs/ticket-schema.md`): one ticket = one Markdown file, phase = directory, transition = one Git commit. Tool-neutral, versioned, human-readable. **Stays unchanged** (the schema grew additively through E3–E10; no migration of old tickets).
- **The fleet runner**: a detached Node process, loopback HTTP with bearer token, worker process table (OpenCode / Claude Code), worktree discipline, gates from acceptance criteria, token telemetry. **Stays largely unchanged**: it was already the best-separated part.
- **The remote PWA** (req-66): its own HTTP server, phone client. Is **upgraded to the primary UI**.
- **The test base**: the `*.spec.ts` modules cover the domain knowledge and moved with the code.

### 1.2 What has been sprawling (the findings)

| Finding | Evidence |
|---|---|
| God object Main | `plugins/tickets/main/index.ts` ≈ 120 KB: one `BoardService` for snapshots, transitions, archive, claims, runs, worktrees, prompts, repos, projects, phases — plus ~50 IPC handlers and remote/MCP wiring in the same file |
| God renderer | `plugins/tickets/renderer/index.ts` ≈ 129 KB, `board.css` ≈ 71 KB |
| Concept overlay | claims, ranks, pins (partly retired), tracks, interactive runs, handover modes solve variants of the same problem ("whose move is it?") |
| Anonymous machine | worker pins over a 5-level assignment ladder (ticket > column > handover > repo > default): no named counterpart, no cost attribution per "role" |
| Two separate UIs | desktop renderer and remote PWA implement the same subject twice |

> Update (2026-11-04): the sizes are the findings of 2026-11-01. The extraction (E0–E2) has since cut them; the numbers are history, not a status.

### 1.3 The three owner decisions that carry this concept

1. **Phone first.** The owner works almost exclusively from the web UI on the phone. The web UI is therefore no longer a side client but *the product*; the Drey desktop integration becomes the thin special client (editor bridge). *Update (2026-11-04): the desktop is not the iPad layout on a big screen; it is Drey itself with views, docks and the editor (§3.4a, [desktop-integration.md](desktop-integration.md)). The phone and iPad client stays as the companion.*
2. **People instead of processes.** Agents are run as named **personas** (e.g. Tessa, the tester), assigned to phases, visible in the UI as a crew, with cost attribution per persona.
3. **Proof before approval.** The last automatic step before the owner's approval produces screenshots and a verification report that is filed in the ticket. The owner accepts on the phone with a tap against visual evidence.

### 1.4 Goals / non-goals

**Goals:** clear separation of concerns (testable, enforceable) · one UI codebase for phone and desktop (companion rule: shared code is the engine contract and `libs/mission-ui`, not the screens, see §3.4a) · personas as a first-class concept · one central chat intervention for all steering actions · reuse of format, runner and tests.

**Non-goals:** no rewrite of the runner · no new programming language (TypeScript throughout) · no hosting / multi-tenant product · no replacement of the ticket file format.

---

## 2. Constraints

> Status: context.

- **Language / runtime:** TypeScript/Node throughout. The runner is I/O orchestration (process spawning, JSONL streams, git); it stays Electron-as-Node or vendored Node. A second language would double the domain model — exactly the disease this rebuild cures.
- **Licence:** Drey is GPL-3.0-only. As long as the code lives in the Drey repository this is settled; a later repository split needs a deliberate licence decision (see §9).
- **Repository strategy:** stay **in the Drey repository** for now, as an npm workspace package. Split only at a second real consumer or a diverging release rhythm (trigger list in §9).
- **Compatibility:** the rebuild is a strangler: IPC channels and the file format stay stable during the migration; the existing fleet keeps working.
- **Platform reality of the web UI:** the remote PWA runs on the LAN / a tunnel; no public hosting, no multi-user. "Phone first" means: one device, one owner, full rights.

---

## 3. Target architecture

### 3.1 Package map

> Status: **built** (E0–E2b, milestones 97–101). The tree below is the v2 target; the real layout of `packages/tickets-engine/src/` is `core/`, `fleet/`, `contracts/`, `services/` and `server/` (HTTP gateway, auth, the standalone `engine-main`); there is no `store/` directory (git plumbing sits in `core/` and `services/`; this edition did not verify the single-writer queue's exact file) (ADR-0088 and docs/05 §5.0 carry the current layout).

```
Drey/                                  (monorepo, npm workspaces)
├── packages/
│   └── tickets-engine/                @drey/tickets-engine — no Drey import
│       ├── core/        domain, pure functions, zero infrastructure
│       │   ├── ticket.ts        (model, parse/patch — from shared/tickets.ts + ticket-files.ts)
│       │   ├── pipeline.ts      (from ticket-board.ts, phase-dirs.ts)
│       │   ├── transition.ts    (THE one transition machine)
│       │   ├── normalize.ts     (drift pass, unchanged)
│       │   ├── validate.ts      (deterministic validator)
│       │   └── persona.ts       (NEW: persona model and resolution)
│       ├── store/       persistence — the only writer
│       │   ├── ticket-store.ts  (single-writer queue, commit discipline)
│       │   └── git.ts           (TicketsGit, stays)
│       ├── fleet/       execution — runner, chain, providers
│       │   └──                  (largely taken over from main/fleet/)
│       ├── services/    use cases, one unit per concern
│       │   ├── board-service.ts     (snapshot assembly only)
│       │   ├── ticket-service.ts    (create, move, archive, refine)
│       │   ├── run-service.ts       (start/stop/steer/answer)
│       │   ├── settings-service.ts  (pipeline, repos, prompts, personas)
│       │   ├── verify-service.ts    (NEW: proof runs, §5)
│       │   └── chat-service.ts      (NEW: central intervention, §6)
│       └── server/      HTTP+SSE API — today's remote gateway, upgraded
│           └──                  (the one entry for ALL UI clients)
├── plugins/
│   └── tickets/                     THIN: vault detection, editor bridge,
│       └──                          tab hosting, MCP registration, nothing else
└── apps/
    └── mission-control/             the web UI (PWA) — phone-first,
                                     desktop = same app, wider;
                                     served by the runner (§3.5)
```

### 3.2 The three iron rules

> Status: **built** (E0, E1; milestones 97, 98). Enforced by ESLint boundaries and TypeScript project configs.

1. **Dependencies point inward only:** `apps/*` and `plugins/tickets` → `server`/`services` → `core` + `store` + `fleet`. `core` imports neither Electron, nor `node:fs`, nor IPC. Enforced by ESLint `no-restricted-paths` and TS project references — the structure cannot erode without the build going red.
2. **Everything that writes is a command.** Every mutation exists exactly once as a typed command object in `services/`. HTTP API, MCP tools and the chat call the same command bus. The chat invents no capabilities — it is a client.
3. **One transition machine.** The move pattern (patch → `git mv` → commit → push → announce) existed in five variations (`moveCard`, `archiveCard`, `unarchive`, `treatDrift`, `acceptTicket`). In `core/transition.ts` there is exactly one function; every path runs through it.

### 3.3 Contracts at the edges

> Status: **built** (E1, E7; milestones 98, 108). The status log and the ledger are built; **Zod was dropped** (owner, 2026-11-04): the contracts are plain TypeScript types in `contracts/` with hand-written parsers.

Payload checking is hand-written `parseXxx` per IPC handler and contract. **Zod was dropped (owner, 2026-11-04): no new dependency; the validators stay, reversible later.** The v2 target was: **Zod schemas** from which the types are derived — one schema = HTTP contract + MCP contract + renderer type. The schemas live in `core/` (they are domain), validation runs at the edge (`server/`, IPC adapter).

Two more contracts come from the Firstmate comparison (§10.3):

- **Status log per ticket** (`<ticket>.status.log`, append-only, machine-written): personas write exactly one verb line per event — `working:`, `blocked:`, `needs-decision: [key=…]`, `paused: <reason> until <time>`, `done:`, `failed:`. It is the only source for "Needs you" and the state chips: **open `needs-decision` / `blocked` keys stay visible until explicitly closed with `resolved`**, however many newer lines overlay them (Firstmate's "open-decisions fold"). The UI reads projections of it, never free text.
- **Fleet ledger** (`_meta/ledger.jsonl`, append-only, JSON Lines): one line per fleet event — `dispatched`, `phase`, `proof_ready`, `merged`, `archived` — with `ts`, `ticket`, `persona`, `model`, `cost`. The Git log stays the history of *contents*; the ledger is the real-time hook for Mission Control and the "Report" intent, without parsing Markdown files.

### 3.4 The role of the Drey integration after the rebuild

> Status: **built** for the plugin cut (E2b, E5c; milestones 101, 106); superseded in its second half by §3.4a.

The `plugins/tickets` plugin shrinks to what only Drey can do:

- Open the ticket file in the Live Preview editor, header editing, `OpenDocsBridge` (the model writes through the open tab, owner-delta diffing per ADR-0087).
- Vault detection (`tickets/_meta/pipeline.md` as marker), quick capture (Ctrl+Alt+N), Windows notification.
- MCP registration of the fleet tools for the Drey Assistant.

Everything else (board data, runs, chat, proof) Drey also gets through the engine API — Drey is then, functionally, "just a client with an editor".

> **Update (2026-11-04): the plugin did not stay this thin on purpose.** The desktop integration (§3.4a) gives the plugin real UI work again — ticket document widgets, Board / Crew / Review / Flow tabs, the Capacity band — but all of it reads the engine through `RemoteService.localClient`; the plugin keeps no second domain.

### 3.4a Mission Control on the desktop, inside Drey (new in this edition)

> Status: **partly built** — views (E13-1, milestone 123, ADR-0089), view presets and home views (E13-2, 127, SDK 1.39), status bar slot (E13-3, 124, SDK 1.38), link fallback (E13-4, 125), the ticket as a document (E13-6, 129), Board and Crew tabs plus the Capacity band (E13-8, 130), Review tab (E13-7, 139). **Planned:** Assistant conversation targets (E13-5), Shape in Drey (E13-9), Parts block in the ticket (E13-10), Flow tab (E13-11), Settings → Tickets (E13-12), the Work view preset (E13-13).

Owner decision 2026-11-04 ("A+": native tabs with the Assistant at the centre). Detail lives in [desktop-integration.md](desktop-integration.md) and ADR-0089; the points that bind this concept:

1. **The sorting rule.** Overview and navigation → dock panel (Tickets, Capacity). Read, write, decide → editor tab (ticket, Board, Review, Crew, Flow). Ask and steer → the Assistant panel with a conversation target. State on the side → status bar item and panel header status.
2. **Views are mandatory and first.** A view is a saved layout with its own docks, panels, split panes and open tabs, switched from the title bar by one segmented control **Notes · Work · Crew** (Ctrl+1, Ctrl+2); a dot on the view whose layout changed and one **Layout ▾** menu (save, reset, save as new view, rename, delete) replace the loose dot, save and reload icons. **Notes** is today's Drey; **Work** is the arrangement of Tickets panel, ticket, Board, Review and Crew, with the Assistant talking to Mission Control. **Tabs belong to views**: tabs of other views are hidden everywhere (tab bar, quick switcher); a tab may belong to several views (context menu "Show this tab in", Open windows panel "In other views" / **Show here**); one document, never duplicated; closing removes it from the current view only.
3. **Parity with the mobile client.** The desktop shows at least what phone and iPad show: id, kind, persona, title, status line, age and **cost** on every list entry; the ticket header with status chip, persona, phase, chain, cost, estimate and gate; the ticket document with `## Proof` and the cost table as widgets; an action bar (Send back, Accept and move to Commit, Thread, Open Review).
4. **Base and SDK stay content-agnostic.** The status bar slot has text, icon, tooltip, click action and priority — no fleet or cost semantics. The link fallback is generic (own vault first, then the other registered vaults, opt-in per vault); the base knows no "tickets vault".
5. **Assistant conversation targets** (E13-5, planned): *Model* (plain chat, no agent, no tools, any provider registered in Settings → Assistant), *Mission Control* (the E5a chat engine through `RemoteService.localClient`), *1:1 per persona* (the merged conversation of D8). **Decision: stay with the existing `LlmRouter` and the registered providers**; another model such as Kimi is registered in Settings, not in a new registry. The fleet's runner workers keep their own pools.
6. **Companion rule.** The iPad and phone client stays; the desktop does not embed it as its main surface. Shared code is the engine contract and `libs/mission-ui`, not the screens. (This supersedes §3.5 point 4, "the same web app in the Drey window", as the *main* desktop surface; the sandboxed BrowserView host of E5c remains available.)
7. **The ticket card and the Review tab (canvas 9a, 7d).** The ticket in the editor opens with one card: ID, status once, the next step as the one primary button, **Thread** (opens the ticket's conversation in the Assistant), then priority, worker, flow and repo in one quiet grid; Review is a button only when there are changes. The Review tab is built like a pull request and its header carries the ticket ID, the title and a one-line description; checks show as green check marks. The Assistant's target icons are one segmented group naming the active target; your message is a bubble on the right, the answer plain text with one meta line. Mission Control's proposals carry **Confirm** and **Dismiss** each.

### 3.5 Delivery and lifecycle of the web interface (owner decision, 2026-11-01)

> Status: **built** (E2b, E5b, E5c; milestones 101, 105, 106), except point 4 which the desktop integration (§3.4a) supersedes as the main desktop surface.

1. **The runner serves the PWA itself.** `tickets-engine/server` serves `apps/mission-control` (static assets + HTTP/SSE API) on a local port. Drey is not needed for it — phone and browser work with Drey closed.
2. **Lifecycle: manual by CLI, Drey starts it if missing.** No system daemon: the runner is started by CLI; the Drey plugin starts it automatically if it is not running (and never shuts it down automatically). Detection through a lock file (`_meta/runner.lock` with PID + port), not through process heuristics.
3. **Context bridge Drey ↔ runner:** for the actions only Drey can do (open a file in the editor, resolve a vault path, system notification, MCP registration at the Assistant), the plugin registers a **bridge** at the runner — a local callback endpoint with a token. The runner calls the bridge only when it is registered; without Drey, bridge actions deliberately run into nothing or are marked "Drey only". The direction stays iron: Drey → runner is the normal API client, runner → Drey is only this optional callback. No Drey import in the engine.
4. **Visualisation: for the start, the same web app in the Drey window** (webview on the runner URL) — one UI, no parallel world. Special native Drey views come at the earliest later, only where the web app in the window really disturbs. *(Update: superseded as the main desktop surface by §3.4a.)*

### 3.6 Pairing the devices — QR + Tailscale, as today in Drey

> Status: **built** (req-66, E2b, E12-3 devices page; milestones 101, 114).

Remote access stays as it proved itself in Drey: **Tailscale** as the transport (no port forwarding, no public listener — the runner binds to the Tailscale address or `tailscale serve`), **QR code** as the pairing ritual. What is new is only *who* triggers the ritual:

1. **Initial pairing by CLI.** The runner is the one component that is guaranteed to run when needed — hence `drey-fleet pair` prints URL + QR straight into the terminal. The QR holds the Tailscale URL and a **one-time pairing token**; the phone scans, the PWA swaps the one-time token for a device token (rotatable, revocable) and is paired. This works without Drey, without a desktop — it fits §3.5 (CLI-first lifecycle).
2. **Further devices through the settings page.** The PWA itself has a "Pair devices" page that shows the same QR locally (from the running runner, a new one-time token per display). The same page is **embedded in Drey's settings dialog** (webview) — one implementation, two embeddings, no second pairing code path. *(Desktop side: E13-12, planned.)*
3. **Unchanged:** paired devices, too, change nothing without confirmation — pairing opens the door, it does not sign commits.

**Implementation stack of the web app:** `apps/mission-control` is built in **Angular + TypeScript** — the same stack as Drey itself, for maximum reuse: Zod schemas from `core/` (§3.3), persona chips, gate bar and card components are shared between plugin and app. The prototype delivered with the design round stays deliberately static HTML/JS — it is a decision aid, not the code base.

### 3.7 Shared UI building blocks (`libs/mission-ui`)

> Status: **partly built** — the library exists with persona chip, gate bar, cards, diff view with line comments, answer block (E5b, E11, E12; milestones 105, 116–119). **Planned:** the Markdown surface (E12-6, in progress in a parallel session).

So that web app, Drey window and plugin do not drift apart, the reusable pieces live in a shared library, not in one of the apps:

- **Markdown surface** (CodeMirror 6, Live Preview) with Drey's **formatting strip**: paragraph style (body text, headings 1–3, blockquote, callouts), bold, italic, more text formats (strikethrough, highlight, superscript and subscript, clear formatting), list style, task list, link, table, insert (image, diagram, emoji, footnote, formulas). It carries the plan in Shape (§5.8) and the ticket in edit mode (§5.5). On the iPad the strip is 44 points high and pinned.
- **Diff view** with line comments (§5.3), **persona chip**, **gate bar**, **cards** (§7), **answer block** (options plus send button, §7).
- **What this means for the build:** the Markdown surface belongs to Drey today (`src/app/editor`). It has to be extracted as a standalone building block so the Angular app can embed it. Until then the web app shows the plan as a render with an edit toggle (§5.5), and the full editor stays in the Drey window.
- **Update (2026-11-04), E12-6:** the extraction has the owner's top priority (the phone renders Markdown wrongly). The surface has three modes — **Live Preview, View and Source** — and **View is the default wherever results are presented**: the plan, the ticket text, the proof summary and the Verification chapter. The owner can switch per surface. Tinted line marks in the rendered plan and the line-level "tap a line to edit" sheet (E10-3b) depend on it.

---

## 4. Personas as a first-class concept

### 4.1 Model

> Status: **built** (E3, milestone 102) — plus the **human persona** (E10-6, milestone 132).

A persona = **name + role + behaviour + model + budget + memory** in one. Stored in the tickets repository as a directory per persona, editable and versioned like `pipeline.md`:

```
tickets/_meta/personas/
  paul/
    persona.md    # frontmatter: title, role, worker, model, color, skills — below it free text (who is Paul, tone, limits)
    prompt.md     # the persona prompt (long form, editable, versioned)
    memory.md     # curated memory (see 4.4)
    avatar.png    # optional; fallback: initial + color
  ben/ …
```

Example frontmatter:

```yaml
---
title: Paul
role: planner            # enum: planner | builder | reviewer | tester | custom
worker: claude-code
models:
  default: opus                       # what runs when nothing else applies
  pool: [opus, sonnet, glm-5.2]       # allowed models, order = fallback
  router: off                         # off | budget | escalate-on-fail
color: '#a78bfa'
skills: [repo-research, formulate-questions]   # files under _meta/skills/
---
```

`skills` references reusable skill files under `_meta/skills/` (a shared pool, no copies per persona). `color` feeds the UI (chips, avatars, thread marks). A directory instead of a central `personas.md`, because prompt, memory and avatar grow with it — a central file would become the next god file.

> **Update (2026-11-04), E10-6 — you as a crew member.** `kind: human` in `persona.md` marks the owner as a persona (`personas/you`, created once on first sight, titled from config `personas.humanName`, default "You"). It is never dispatched, has no capacity, budget, pause or model, and Crew shows its card as "Manual steps". It is what makes manual gates possible (§5.7). The exact keys are in `specs/ticket-schema.md`, "`_meta/personas/`".

### 4.2 Resolution — the ladder collapses

> Status: **built** (E3, milestone 102).

Today five levels (ticket pin > column > handover `@worker` > repo > default). Target:

```
ticket pin (`worker:` / `persona:` in the frontmatter)
  → phase persona (`persona:` key in pipeline.md)
    → default persona (engine config)
```

`pipeline.md` references only the persona per phase:

```yaml
- { id: verify, title: Verify, handover: agent qa-default, persona: tessa }
```

The old per-column keys `worker:` / `model:` / `prompt:` stay readable for a while (migration rewrites them to personas), then become deprecated — one place, not three.

The same pattern holds for the **model** (§4.6): ticket pin (`model:`) > persona default (`models.default`) > router policy (if active) — and the history records the model that actually ran.

### 4.3 What personas change in the UI

> Status: **built** (E3, E12-4; milestones 102, 115). The merge of Chat and 1:1 (D8) is **decided** and built as one conversation in the persona detail.

- **"Whose move?"** can finally be answered: cards and threads show avatar + "Tessa is testing" instead of PID / run state. (Heals the ADR-0087 finding "a card does not say whose turn it is".)
- **Crew view** (instead of the worker process table): one card per persona — state, model, phase assignment, day cost against budget, pause. The current assignment is only a link to the ticket card in "Work" (rule "one ticket = one card", §7). A tap opens the persona detail with chat, memory and setup (§4.5).
- **Cost attribution for free:** the existing `/report` telemetry additionally groups by persona — the SHIP feature "compare how they perform, route the work to the stack that delivers best" falls out of existing data. Costs show on three levels, one number per level: **ticket card = cumulative token cost across all phases**, thread / proof = breakdown per phase × persona, crew = day cost per persona against budget.

**Crew view, state of v2:** it replaces the worker process table completely (the earlier "All workers" view). Per persona it shows
- the state (idle, running, waiting for you) and **what it is running right now**, each assignment as a link to the ticket card;
- a **stuck worker** as a state of the persona (no progress for N minutes, context filling up) with the actions *Nudge*, *Hand to Claude Code* and *Stop*; plus a Needs-you card (§4.9);
- **day cost against budget** as a number and a bar, the day total in the header;
- at the head of the list the **capacity** (e.g. "Local 2/2, Claude Code 2/3") and **Pause all after this step** and **Stop all**.

Steering a single run (Tell, Take over) stays in the ticket thread, not in Crew. The **persona detail** has the tabs Chat, Memory and Setup (§4.5) and a fixed chat input in the 1:1 (calibrate, teach, query). **Decided (D8):** Chat and 1:1 merge into one conversation.

### 4.4 Persona memory

> Status: **built** (E3, milestone 102).

Personas learn across runs — but **curated, not as a log**. Three rules:

1. **Separation of concerns:** ticket content stays in the ticket (thread, `## Result`, `## Handover`). The memory holds only **cross-ticket lessons** — owner decisions, recurring pitfalls, proven approaches. Whoever does not separate this builds a second, worse ticket archive.
2. **Write path:** at the end of a run (part of the handover step) the persona writes at most one short entry to `memory.md` — date, ticket reference, lesson in one sentence. In addition the owner can teach something in the persona chat (§4.5); that becomes a **proposed** entry which the owner accepts with a confirmation card. Every entry is its own commit (`personas: pia memory +1`).
3. **Read path + hygiene:** the context pack (the T-0048 mechanism) gets a memory slice: top-N relevant entries, token-budgeted, pinned first. `memory.md` has an upper limit; a compaction run condenses old / similar entries (like `resume-compact` for sessions) and keeps the file small. The owner can pin or delete entries — memory is a **maintained asset**, not a growing history.

Entry format: `- 2026-10-28 · T-0071 · rank: fields from order.md take precedence over derived order (owner-confirmed) #pinned`

### 4.5 Persona chat and configuration (Crew detail)

> Status: **built** (E3, E6, E12-4; milestones 102, 107, 115).

The Crew view gets a detail per persona with three areas — **Chat / Memory / Setup**:

- **Two chats, two jobs:** the Mission Control chat (§6) steers *tickets*; the persona chat steers *the persona* — calibrate ("why did you decide X yesterday?"), teach ("treat rank fields like this from now on"), query ("what do you know about our import?"). Technically: a run against the persona's worker with its prompt + memory, without ticket context. Persisted as `thread.md` in the persona directory — the coaching log.
- **Teaching = command:** everything that writes from the chat (memory entry, prompt change) runs over the command bus with a confirmation card — the same pattern as moving a ticket, no special path.
- **Setup editable on the phone:** `prompt.md` as a Markdown editor, avatar (upload → `avatar.png`, one commit as with attachments, R8), skill assignment by switch, model / worker as a choice. Every change = one commit (`personas: pia prompt updated`) — the Git history later answers "who switched Tessa when?".
- **Chat-first rule:** everything the setup can do the chat can do, too — in the persona chat ("add your prompt rule …") as in the Mission chat ("give Tessa the skill diff-review, default model sonnet"). The setup view is the **mirror to check**, not the primary path; whoever never opens a form loses nothing. Chat configuration always shows a **diff** in the confirmation card (which line in which file changes); only a tap writes (§6, intent "Configure").

So the persona is no longer just configuration kept in YAML, but a crew member with memory, addressability and equipment — without softening the determinism of the pipeline: runs stay phase-driven, the chat only changes things through commands.

### 4.6 Models: pool per persona, not persona per model

> Status: **built** (E3, milestone 102). A per-gate model pick in the flow editor is planned (E10-5b).

**Decision rule: the persona is role + prompt + memory — the model is configuration, not identity.** Three consequences:

1. **No persona multiplication by model.** "The same job once with Claude, once with Kimi" is *not* a second persona — otherwise memory and coaching effort double and cost attribution per role falls apart. Instead: `models.default` + `models.pool` (allowed models, order = fallback on rate limits / outages) per persona.
2. **The router is a separate, optional mechanism — default: `off`.** Without a router the default model always runs (deterministic, plannable costs). Two sensible policies if it is on: `budget` (the cheapest pool model that fits the context size — good for idea triage) and `escalate-on-fail` (start cheap, escalate within the pool on failure). Important: the router chooses only **inside the persona's pool** — never across roles.
3. **The override stays with the owner:** ticket pin (`model:` in the frontmatter) > persona default > router policy. And whoever chose — the `## Verlauf` entry (§5.4) records the **model that actually ran** per run. So "who / what / how expensive" stays auditable under a router, and model comparisons within a role fall out of the history data (SHIP: "route the work to the stack that delivers best").

**When is it a second persona after all?** When the *job* differs, not the model. Example UX: "Designer" (taste, prototyping, different prompt, different memory) and "UX engineer" (implementation in code) are two roles → two personas, each with its own default model. Rule of thumb: same job description → same persona; different job description → different persona; a model change never creates a persona.

**Prompt–model fit:** prompts are written primarily model-agnostic. Where a model really needs a different tone, a small delta (`prompt.kimi.md` as an override next to `prompt.md`) is enough, not a complete second persona.

### 4.7 Access: CLI harness vs. direct model call

> Status: **built** (E3, E5a, D-1; milestones 102, 104, 131).

Besides *which model* (§4.6) there is *which way* — the `worker:` key controls both:

```yaml
worker: claude-code   # claude-code | opencode  → CLI harness (agentic loop)
                      # api                     → direct model call (like the Drey Assistant)
```

**Rule of thumb:** if the task needs the file system, a shell or several steps → **harness**. One prompt in, a structured answer out → **direct call**. The harness pays for its loop (tool calls, intermediate states) with a multiple of the tokens — for single-shot tasks that is money thrown away and noticeably slower on the phone.

| Task | Way | Why |
|---|---|---|
| Plan / build / review / verify / commit | harness | works in the repo, needs tools, multi-step |
| Mission Control intent routing (§6) | direct | one prompt → command JSON (schema-validated), fast, cheap |
| Tidy / capture: idea → ticket draft | direct | single shot, formatted |
| Shaping a question (question shape) | direct | single shot with context from ticket + memory |
| Memory: reflection and condensation | direct | reads `memory.md`, writes an entry — a service task |
| Persona chat (coaching) | direct | memory in context, no repo access needed |
| Reporting ("what did the week cost?") | direct | aggregates telemetry, no repo work |

**Consequence for the package picture:** `services/` uses the same LLM client as the Drey Assistant does today (no new integration path); only `fleet/` starts harness processes. A harness is also the wrong way for services *for security reasons* — router and co. need no shell rights. And because the way is configuration, a persona for light roles (e.g. triage) can run entirely on `api`: faster, cheaper, same identity.

> **Update (2026-11-04), D-1 (milestone 131).** The Mission Control chat bridge now follows the provider Drey uses: the assistant's LLM settings (`chat.enabled`, `chat.provider`, `chat.baseUrl`, `chat.apiKey`, `chat.model`) are pushed to the engine at activation **and on every change** (SDK 1.40 `ctx.appConfig.onChange`); the bridge speaks both HTTP dialects (OpenAI-compatible and Anthropic Messages); a failed turn is an error card, not a persona reply written into the session. The CLI providers have no endpoint and stay out of the bridge. Settings → Chat holds the model rows and "Test connection".

### 4.8 Self-improvement loop — friction, aggregation, 1:1

> Status: **built** (E6, milestone 107).

Personas get better without the system rewriting itself. Four parts, one iron rule (**nothing happens automatically — every application is a command with confirmation**):

1. **Report friction (write path, almost free):** the persona may file friction lines in the handover — what was missing, what it had to guess, what went wrong repeatedly. Stored as `friction.md` in the persona directory, one line per finding (`2026-10-30 · T-0082 · context pack lacked the order.md history`). No extra run, only one paragraph in the handover prompt.
2. **Aggregation (direct model call per §4.7):** weekly or after 5 runs per persona a service run condenses `friction.md` + `## Verlauf` data (failures, retries, cost outliers) into **proposals** in `improvements.md` — each with evidence (which reports), target (`prompt.md` / `skills` / `models` / context-pack recipe) and a concrete diff proposal. States: `open | accepted | dismissed`.
3. **Threshold + notice:** from 3 open proposals of a persona a card appears in **Needs you** ("Paul: 3 improvement proposals"). Underneath, the loop keeps collecting quietly — no badge alarm for small things.
4. **The 1:1 (persona detail):** proposals as cards with evidence. **Apply** = command + confirmation + commit (`personas: pia prompt updated`), **Dismiss** closes the proposal. Accepted prompt / skill changes take effect from the next run; matching lessons also land in memory (§4.4).

**Deliberate limit:** the loop never writes itself. No auto prompt edit, no auto model switch, no auto skill. It prepares the 1:1 — the decision stays with the owner. That makes it auditable (every change a commit) and keeps it from "unlearning" by drift.

### 4.9 Supervision without tokens — the watcher is a file observer

> Status: **built in part** (E7, milestone 108): the status log and ledger and the derived Needs-you kinds are built; the watcher depth rides on them in place. Return briefing and away posture are out of scope (§6).

Firstmate's strongest infrastructure idea: **supervising the running fleet costs zero tokens.** A simple watcher observes status logs, Git events and the ledger (§3.3) and wakes a model only when something is really pending. Adopted as a principle:

- **State is derived, not asked.** "Needs you", "Running", "waiting since …" arise from status log + Git + ledger — deterministic, free, immediate. No LLM polling, no "have a look" run.
- **A model becomes active only on a real event:** a new `needs-decision` key, proof ready, run failed, wedge suspicion (a run without progress in status log and worktree for N minutes). Only then the chat service reads context and phrases the card.
- **Declared waits instead of permanent alarm:** a persona that writes `paused: waiting for CI until 15:00` counts as healthily parked and is shown again only at the stated time (or after a long interval). "Waiting for you" ages quietly without nagging — and without ever silently rotting: unanswered keys come back up at a bounded cadence.

---

## 5. The verify step — proof before approval

### 5.1 Pipeline placement

> Status: **built** (E4, milestone 103).

```
… → build (Ben) → review (Ralf) → verify (Tessa) → approve (owner, manual) → commit → done
```

`verify` is an agent phase with its own prompt (`qa-default`). `approve` is a manual checkpoint gate — the machine never crosses it (lane rules stay the runner's business).

> Update (2026-11-04): a `manual` chain step (E10-6, §5.7) lets the owner insert further manual gates into one ticket's chain; `approve` stays the pipeline's own checkpoint.

### 5.2 Flow of a verify run

> Status: **built** (E4, E11-1; milestones 103, 116). The video size rule (E11-1c, milestone 147) is built. **Planned:** the proof-video follow-ups (E11-1b).

1. **Start:** start the program in the worktree — through the existing `launch:` key in `repos.md` (or the `dev.ps1` default). Headless: Playwright Chromium against the built artifact, **no Electron window on the desktop** (the owner may be working right now).
2. **Click through:** happy path + the error cases, along the acceptance criteria. Every criterion produces at least one screenshot.
3. **Judge:** a vision-capable model checks the screenshots against the criteria — not just "test green" but "looks as demanded".
4. **File:** screenshots go to `tickets/attachments/` (the reserved folder from req-66 R8 — one commit per file, stable `![](../attachments/<name>)` links that survive phase moves). The report is a new section `## Verification` in the ticket, replaceable like `## Handover`, before `## Log`:

```markdown
## Verification

**Tested:** '2026-11-01T14:30:00Z' · worktree T-0086 · build from `t/T-0086`

- [x] Palette opens once on double Ctrl+P → ![](../attachments/img-20261101-143012-a9f2.png)
- [x] `npm run verify:unit` — 412 passed
- [x] Empty search shows the empty state → ![](../attachments/img-20261101-143033-c41b.png)

**Findings:** none · video (failure case): —
```

5. **Move:** green gate → `verify -> approve`, the proof card lands in **Needs you**.

Schema delta (the only change to `specs/ticket-schema.md` in v1): section `## Verification` as a convention + `persona:` frontmatter key (optional) + `persona:` in `pipeline.md`. No new file format, no migration of old tickets.

**Video and captions (v2):** in addition to the screenshots the verify run **always** records a short walkthrough video (at most 60 seconds, headless, with chapters, e.g. "Launch the build", "Ctrl+P twice, fast", "One palette opens"). Every screenshot carries as caption the criterion it proves. This replaces the v1 rule "video only on failure" and costs storage in the tickets repository (R6).

> **Update (2026-11-04): video size rule, E11-1c (built, milestone 147).** One cap **per video**, `videos.maxMb` (25), and **no automatic deletion at all** — no retention by age or folder size. This replaces the built total-size limit `videos.limitMb` (2000, oldest videos of `done` tickets deleted). Engine config, the `## Verification` "Video removed" note, the Settings row and the validator follow; settled when built: a recording over 25 MB is dropped (Playwright cannot trim) and the ticket says `Video not kept: N MB exceeds the 25 MB limit.` The 60-second cap is not enforced today (E11-1b). A `proof:` mode per ticket decides whether a ticket needs a video at all (see the schema, "Proof mode").

### 5.3 The approval experience on the phone

> Status: **built** (E5c, E11-2, E11-3; milestones 106, 117, 118). Wide layout and desk-wide viewed marks: planned (E11-2b). The desktop **Review tab** is built (E13-7, milestone 139).

The proof card in "Needs you": title, persona chip (Tessa), the 3–6 screenshots as a **swipable gallery**, compact checklist report, then two actions: **Accept** (= `approve -> commit`, the commit agent merges) / **Send back…** (= `sendBack` with a note). Both already exist as commands — only the packaging is new. **Sending back is never silent:** the note, what did not fit, is a mandatory field — without a reason the action cannot be submitted. The note lands as feedback in the ticket (handover to build) so the next iteration knows what to change.

Approval also includes **the diff, not just the proof**: below the screenshots and criteria lies the complete code change — collapsible per file, with syntax highlighting, as a unified diff rendered straight from the worktree branch (`git diff main...t/<tid>`). Phone-suitable: single column, files collapsed with +/- balance, long lines scrollable horizontally rather than wrapped — and every file opens in a **full-screen zoom** (larger type, adjustable in steps), because detail review on 390 px otherwise fails on readability. Whoever wants to checks every line on the phone **without opening an IDE**; whoever wants only the result stays with the gallery and criteria. No new data channel and no separate report — the diff is Git, rendered. And because generated artifacts are tickets, the same view later applies in the ticket screen under `## Changes`.

**Diff review with comments (v2):** a tap on a file in "Where" opens it for review.
- **File list** with comment count and the *Viewed* tick per file, progress "1 of 3 viewed".
- **Changes / Whole file:** the default is the unified diff with four lines of context; "Whole file" shows the entire file with the changed lines in place (removed red, added green). Next to it "Change n of m" with jumps to the previous and next change.
- **Comments in pull-request style:** tapping a line comments it, dragging over several lines comments a range; dictation is possible. Comments stay *pending* until the owner chooses **"Send back with n comments"**; **Accept and merge** ignores them. The mandatory note when sending back stays.
- **Storage (D6, decided):** the comments go as structured feedback (file, line, text) into the ticket's Handover section for the responsible persona.
- **Header and checks (canvas 7d, 7j):** the Review header carries the ticket ID, the title and a one-line description; the checks of the proof show as green check marks.
- The full-screen zoom and the photo markup (F1) stay unchanged.

### 5.4 Ticket chapters and history — data instead of a monitoring UI

> Status: **built** (E4, E11-4, E13-6; milestones 103, 119, 129).

SHIP shows a gate bar per mission, agent run monitoring (sandbox, CPU, tokens) and a timeline. Honestly classified: **monitoring and timeline are operator tools — for the owner on the phone mostly eye candy.** The value lies in three questions: *which gate is up, who was up, what did the section cost.* And these do not belong in a separate view but as data in the ticket — every view renders from it:

1. **Chapter convention (binding):** every phase writes its chapter into the ticket — `## Plan`, `## Changes`, `## Result`, `## Verification`, `## Handover`. The MD file is the report; Drey renders it in the editor, the web UI extracts cards and proof from it.
2. **`## Verlauf` (machine-maintained, one entry per run).** The section name and the keys `dauer` and `ausgang` are **file-format identifiers** (they stay as written; the repository's English rule covers prose, not the format that existing tickets already use — see `specs/ticket-schema.md`):

   ```yaml
   - { phase: plan,  persona: paul, model: opus,    tokens: 48k,  cost: 0.24, dauer: 12m, ausgang: handed-over }
   - { phase: build, persona: ben,  model: glm-5.2, tokens: 121k, cost: 0.61, dauer: 41m, ausgang: handed-over }
   ```

   The gate sequence and timestamps are already derivable from the Git log (one transition = one commit) — only what Git does not know is written: tokens, cost, duration, outcome (`handed-over | failed | stopped`). Data source: the existing `/report` telemetry.
3. **~~Mermaid gate diagram per ticket~~ — dropped (owner, 2026-11-04).** The v2 idea of an autogenerated Mermaid block with cost per edge is no longer part of the target. **New requirement instead:** a ticket document may contain Mermaid blocks (Plan sections already do, §5.8); Mission Control and the agent must process them — the shared Markdown surface renders them (E12-6) and the engine's parsers must not misread fenced Mermaid content as chapters, parts or criteria (roadmap E10-7).
4. **Derived views:** gate bar in ticket screen / thread / proof (phone), wide bar on the desktop, cost sums in Work and Crew — all renderings of the same history. No timeline and no monitoring view as a separate UI feature (the interface stays: whoever wants depth opens the ticket or `git log`).

**Costs visible (v2, mandatory):** the owner must always see what each phase cost and what a ticket costs in total. Fixed places:
1. **Card** (Work list, Needs you, Running, Shaping, phone inbox): the **total cost of the ticket** in amber and monospace at the right end of the status line, on the phone under the age.
2. **Ticket screen:** the sum at the top right; the **cost table at the very end** of the ticket (phase and persona, model, tokens, time, cost, total row). The gate chips of the chain show no costs. The table sits at the bottom because for most jobs it is the least interesting part.
3. **Ready to try:** cost per step in "How it got here", total below.
4. **Crew:** day costs per persona against budget (§4.3).
The source stays `## Verlauf` and the `/report` telemetry.

**Cost estimate (v2):** the plan to accept (§5.9) shows a range per part and the typical sum at the bottom. It is **not guessed by the model** but computed from the own history: the middle costs (range = middle half) of the completed runs with the same gate, the same persona and the same model, with the basis stated ("median of 9 similar runs"). With **fewer than 3 similar runs** no number appears ("not yet · only 2 similar runs so far"), and the sum then says "for 2 of 3 parts". A hard upper bound from the token budget would be a limit, not a prediction, and is not part of this version. **Decided (D9):** threshold 3 similar runs; size classes later. The estimate for the whole flow (not only the build gate) is planned (E10-4b).

### 5.5 The ticket screen — viewing and editing

> Status: **built** (E5c, E13-6; milestones 106, 129). On the desktop the ticket *is* its Markdown file in the editor with a header strip and widgets (E13-6).

The card in "Work" is the entry, not the destination: **a tap on a card opens the ticket itself.** The ticket screen renders the same MD file that Drey shows in the editor — chapter headings, frontmatter, `## Verlauf` — as a readable, scrollable view with the gate bar on top. No own data model, no own rendering logic: the screen is a Markdown render with two additions (gate bar from the history, context-dependent primary action: *answer question* → thread, *view proof* → proof card).

**Read-only first, changes by chat:** the screen is deliberately a reading view. The regular way to change a ticket is the chat — "T-0091: priority high, build only after approval" runs as a command with a confirmation card (§6) and cannot damage the structure, because the command bus validates. On the phone that is the decisive difference: typing and formatting errors in the MD (frontmatter syntax, chapter conventions, YAML history) are a real risk, and the ticket file is a machine interface — one wrong character breaks parser or watcher. Direct editing exists anyway: a toggle switches to raw mode (with a warning), saving is an ordinary write command with a commit — identical to saving in the Drey editor, because both write to the same file. But it is the exception path for the desktop-near case, not the everyday. So without exception: what you edit on the phone you see on the desktop, and vice versa. Ideas are tickets, too (in `10-ideas/`, sparsely filled: title, priority) — the same screen, only with empty chapters.

> Update (2026-11-04), desktop: "Edit the ticket" needs no button, the ticket is already the editable document; source mode is in the `⋯` menu. **Open decision:** the Markdown surface's modes (E12-6): View is the default where results are presented, so on the phone the ticket text reads rendered without switching.

### 5.6 Two ticket forms: ship and scout

> Status: **built** (E8, milestone 109).

Firstmate separates cleanly between tasks that change code and tasks that only explore. Adopted — it sharpens exactly the spot where our pipeline was implicit so far:

- **Ship (default):** the known path plan → build → review → verify → approve → merge.
- **Scout:** the ticket passes only the exploration — a persona reads repo / history / data and writes a `## Report` chapter into the ticket plus a **decision list** ("you must decide these three points, with a recommendation"). No worktree, no diff, nothing to merge. The end point is not a proof but the report as a card in "Needs you". In the file: `form: scout`.
- **Promotion:** from the report the scout can become a ship by chat ("okay, implement option 1") — the ticket then gets a plan chapter and a worktree. Paul's triage of an idea is in effect the first scout run: the idea comes back with a report and a decision list instead of a premature plan.

Rule as everywhere: the scout writes only into its own ticket; the transition scout → ship is a command with confirmation (`promote`).

### 5.7 The chain in the ticket — standard flow, delta, notify rules

> Status: **built** (E9, milestone 110; flow editor E10-5, milestone 128; manual steps E10-6, milestone 132). **Planned:** the "propose a flow for every new plan" switch, per-gate model pick, the default flow under Settings → Tickets and the fleet executing `move` / `assign` (E10-5b); the desktop Flow tab (E13-11).

The gate sequence ("the chain") is where "runs through by default" and "this time I want it different" must meet. Design:

1. **The standard flow is crew configuration, defined once:** `_meta/pipeline.md` holds the default (`plan → build → review → verify → approve → commit`) with a persona default per gate. It applies to every ticket without anything being written into the ticket — a ticket without a delta runs flow X silently and completely.
2. **The ticket stores only the delta:** deviations stand in the frontmatter as declarative entries, e.g. `chain: [insert design(paul, notify) after review]`. The engine merges standard + delta into the concrete chain — gate bar, watcher expectations and routing render from it. No second place of truth, no UI state: the chain is data in the ticket. (Grammar: `insert`, `skip`, `notify`, and since E10-5 `move <phase> after|before <anchor>` and `assign`; see the schema, "The chain delta".)
3. **Changed by chat, made visible on the ticket:** "T-0091: security gate by Ralf before verify, then notify me" → the confirmation card shows the chain **before / after** (new gate highlighted) plus the frontmatter diff, tap = commit. The usability bridge: the **gate bar in the ticket screen is tappable** and opens a sheet with the three most frequent interventions — insert gate, set notify rule, back to the standard flow. Each option ends in the same chat command with a pre-filled sentence. One mutation path (command + confirmation), two entries (word and picture).
4. **Notify rules are gate attributes, not a separate mechanism:** `notify` on a gate means: on completion a card lands in "Needs you". "I want to know when Ralf is through" is thus part of the chain itself — and stands readably in the ticket.
5. **Ship / scout are chain presets** (§5.6): scout is simply the chain `scout → report`. Own presets ("build only, no review") would be the same mechanism — delta instead of a special path.

Limit as everywhere: chain changes write into the ticket and are commits — they never run automatically, not even "just this once".

**Flow editor (v2):** the chain is shapeable **graphically**, not only by chat; both end in the same command (frontmatter delta, one commit).
1. **The start is the standard.** The editor shows the chain as a sequence of gates (e.g. Build · Ben → Review · Ralf → Verify · Tessa → Approve · you), one per part of a split plan. The chip "Standard flow + n change(s)" shows whether and how much deviates.
2. **By hand:** a tap on a gate opens the inspector (who does it, which model, "Tell me when it is done", runs after, shift earlier or later, add a gate after it, remove). A plus between two gates inserts a gate. "Reset to standard flow" restores the standard.
3. **By Paul:** she proposes changes as a **draft**, with the exact delta (`chain: [insert design(paul, notify) after review]`) and a reason. The owner can tell her what should change. A switch lets her propose the flow for **every new plan**; she always starts at the standard.
4. **Nothing applies before "Save flow" is pressed.** Draft and manual change are drawn dashed.
5. A **running gate** stays unchanged; changes affect only what has not begun yet.

> **Update (2026-11-04), E10-6 — manual gates (built, milestone 132).** The chain can contain a **manual step** for the owner: phase `manual` / `manual-<word>`, valid only as an `insert` (`insert manual(you, notify) after review`); an agent persona on it is refused at the flow write guard. A ticket parks in two ways: a `manual` step after a gate (on a green gate the runner stamps `awaiting: you` instead of moving on), or a gate whose resolved persona is human (the dispatch pass stamps it before any run is composed — no run, no worktree). New ticket field `awaiting:`; any transition clears it; the dispatcher skips it. Finishing = the existing Accept / Send back moves; Mission Control's Needs you shows a "Your turn" card with Accept and Send back (note mandatory). In the flow editor the manual step is always offered under "Add a gate" and its Who picker lists only human personas.

### 5.8 Shape — working out new tasks together (v2)

> Status: **built** (E10-1, E10-2, E10-3; milestones 120–122). **Built since:** Shape in Drey (E13-9, milestone 144, with the Refine-button removal). **Planned:** follow-ups (E10-3b: tinted line marks, line-level edit sheet, Paul on his own persona model).

Shape is the second way of the intent "Feed in" (§6): instead of immediately creating a ticket with a confirmation card, the owner works out the idea **together with Paul**. Shape is a *mode of the ideas phase*, not its own column (planning runs just-in-time, the plan columns are no longer part of the standard pipeline).

1. **One conversation partner:** the dialog runs in the Mission chat with the ticket as context. Paul's questions arrive as cards ("Paul, via Mission Control"); a context line shows "Shaping T-0130 with Paul · opus · reads only" and the sources read. Paul reads the repository and writes **only the plan chapter** of her ticket (D4 decided: Shape runs through Mission Control, not a second channel).
2. **The plan is a shared document:** `## Plan` with fixed sections in this order: *Goal*, *Architecture* (Mermaid when components or flows change), *Parts* (numbered list, per line `**Title** — what it delivers`), *Acceptance criteria*, *Open questions*. The owner edits it in the Markdown editor with the formatting strip (§3.7); line marks show what *you* and what the *model* changed last; one line names version and state ("the model saw plan v7, 1 edit of yours since").
3. **Only your delta goes back:** per run there is a *shadow copy* = plan at the end of Paul's last turn. On sending, only the change *shadow → current* goes along, as summary and diff. In the input field a deselectable chip "n new edits of yours go along", in the history a card "You edited the plan". Paul's own changes are never mirrored back to her. The editor saves the file before sending so the model reads the same text.
4. **Questions and answers:** questions with options appear as an answer block directly above the input field (§7); a choice is never the action, sending happens by button.
5. **Splitting:** Paul proposes whether and into how many parts to split. The number follows the plan and is **never fixed**: with one part "Split" is gone and the proposal reads "Keep as one ticket". A reason line explains the proposal; the owner can overrule.
6. **End:** "Keep as one ticket" puts the ticket into the build queue. "Split into N tickets" leads to the plan to accept (§5.9).
7. **Schema delta:** the plan section is called `### Parts` (instead of `### Phases` in the req-75 W6 draft). Each part becomes a ticket with `parent:` and `blocked-by:` (§5.9).

> **Update (2026-11-04): the Refine button goes away (E13-9, built, milestone 144).** Once the Assistant on Mission Control loads the ticket file itself, the Refine button (Work panel and Mission Control) and the `refine-interactive-default` prompt are removed; **not before**. On the desktop Shape is the ticket in the editor plus Mission Control in the Assistant, Paul editing through live edit (ADR-0049), the owner's edits riding along through `OpenDocsBridge`.

### 5.9 Plan to accept — the parts (v2)

> Status: **built** (E10-4, milestone 126); follow-ups E10-4b (parent leaves "needs shaping" after release, per-gate estimate for the whole flow, estimate "not yet" semantics); desktop Parts block: E13-10 (planned).

**Terms:** *part* = a piece of the split plan, becomes its own ticket. *Phase* = pipeline column. *Gate* = a step in a ticket's flow (build, review, verify, approve).

1. **Card per part:** title, **builder persona** (choice among Paul, Ben, Ralf, Tessa; the other gates in the flow editor, §5.7), reason, **flow line** (standard or delta, tappable to the flow editor), start ("Runs now" or "After part n") and **cost estimate** (§5.4).
2. **Actions:** **move** and **delete** parts (delete only at the second press). **Running parts are locked:** they can be neither moved nor deleted, and no part can be moved past them; stopping happens in the ticket. *Adding* parts or changing titles does not exist here: the cut is changed in the plan or through Paul (decided 2026-11-04: an "Add part" button on the desk board was removed again and stays excluded) ("Change the split: edit the plan or ask Paul").
3. **Approval:** "Accept and run" sends all parts off, "Run part 1 only" only the first. The acceptance is a **proposal card** in Mission Control with **Confirm** and **Dismiss**; nothing runs before confirmation (R4).
4. **Dropped (D5, decided):** the routing-rules file of the orchestrator sketch is gone, the persona resolution (§4.2) replaces it. The touches display (file paths per part) and the overlap lines are out of the UI (owner decision). **The overlap guard is not kept in the engine either:** no overlap guard, no touches or file routing (D5); req-75 W7 and W8 are dropped.
5. **Desktop:** the same view on a wide screen; there is no second variant. In Drey the Parts block is an editor widget under the ticket header (E13-10).

---

## 6. The central chat intervention (Mission Control)

> Status: **built** (E5a, E5b, D-1; milestones 104, 105, 131). **Planned:** Assistant targets on the desktop (E13-5). **Out of scope:** the "Report" intent beyond what the chat digests, away posture and return briefing, photo markup.

**Principle "one conversation partner" (from the Firstmate comparison, §10.3):** on business matters you talk only to Mission Control. Personas do not talk to you directly about running work — they report structured status (§3.3: `working` / `needs-decision` / `blocked` / `done`), and Mission Control puts the card into the conversation from it: "Paul asks: …", "Tessa: proof is ready". Your answer goes to Mission Control, which delivers it to the right persona. The ticket thread stays as a **filtered view** of everything concerning that ticket — but it is a lens on the same queue, not a second channel: whoever answers in the thread answers Mission Control with preset ticket context. **The one exception is the persona chat (§4.5):** coaching and configuration *are* the conversation with the persona itself — that cannot be delegated without losing its purpose. The separation stays clear: Mission chat = business (tickets, fleet, configuration by diff), persona chat = coaching (experience, memory, behaviour). *(D8: Chat and 1:1 in the persona detail merged.)*

One chat, reachable from everywhere (on the phone through the menu top left, on iPad and desktop as a dock on the right next to the work, later the Drey Assistant — **on the desktop: the Assistant with the target Mission Control, E13-5**), serving four intent classes:

1. **Steer** — "move T-0086 to review and put Tessa on it" → the chat service (LLM router, direct model call per §4.7) maps it to `TransitionCommand` + `AssignCommand` and puts a **confirmation card** into the thread (diff-like preview: what happens, who, where). Only a tap = execution through the command bus.
2. **Feed in** (directly, or together with Paul through **Shape**, §5.8) — "New ticket: hang the worktree cleanup on the weekly plan" → tidy / capture → `CreateTicketCommand` with confirmation card (title, target column `10-ideas`, priority); only after the tap does the ticket land in "Ideas". **The intent applies on every chat surface:** Mission chat, ticket thread and persona chat recognise it alike — ticket thread and persona chat only pass it on, it is always executed as the same command with the same confirmation. The regular place is the Mission chat (which is why it is one tap away on every device); the other surfaces are convenience, not parallel logic. Manual creation (button, editor) stays possible but is the exception path — "I don't do it by hand anyway".
3. **Report** — "What is the crew doing?" / "What did the week cost?" → aggregated answer from fleet status + telemetry.
4. **Configure** — "Give Tessa the skill diff-review and set her default model to sonnet" → `UpdatePersonaCommand` (prompt / skills / models / worker), confirmation card with a **diff preview** of the affected file. So the whole persona maintenance is chat-steerable; the setup view stays as mirror. New skills arise here too: "create a skill X" → the affected persona (or the router) drafts `_meta/skills/x.md`, you confirm, one commit.

**Rule:** the chat may do nothing the API cannot. Every chat action is a command with confirmation if it writes. So the audit trail (the Git log of the tickets repository) stays complete — whether the owner types, clicks or speaks.

**Sessions and context:** the Mission chat is session-based. "New chat" begins a fresh context — token hygiene is deliberately in your hands, not an automatism. Old sessions stay viewable as a list and can be reopened (read-only; writing on goes in the current conversation or a new chat). Context management here means: you decide when a new context begins, and nothing is deleted. Persistence follows the file philosophy: every session is a file in `_meta/chat/` (e.g. `2026-11-01-costs-export.md`); reopening loads the file as context.

**Chat history (v2):** the history lives in the chat window itself, not on its own page. On the **phone** the menu (three bars top left) opens a screen that *replaces* the chat: search, "New chat", the places Work, Crew and Settings, below them the chats by Today, Yesterday and Earlier; a tap opens a conversation. On **iPad and desktop** the same button in the head of the dock opens the list *instead of* the chat. Every session stays a file in `_meta/chat/`; old sessions remain read-only, writing on goes in the current conversation or a new one. This arrangement follows the convention of common chat apps.

**Attachments:** photos and files belong directly in the chat — in Mission chat, ticket thread and persona chat alike. On the iPhone the attach button triggers the native dialog (library or camera at once, `accept="image/*"`), without a detour through a file manager; next to it "Choose file" for text / Markdown / PDF. Attachments are stored as files — at the ticket if the context has one, otherwise in `_meta/attachments/` — and referenced in the chat; for the persona they are ordinary image / text context. Primarily images, text secondary, more formats only on demand.

**Away posture ("I'm away"):** also taken from Firstmate and important for everyday phone-first use: you tell the Mission chat in one sentence what applies during your absence — "away until 6 pm, merge only if proof is green, start nothing new". The sentence is stored **verbatim** as a posture record (no parser that "interprets" it — Mission Control acts on it at the moment of the event) and mechanically bound: everything reversible may keep running, everything destructive / irreversible can never be pre-authorised — whatever the sentence says. On return a **return briefing** is ready in the chat: what landed, what waits, what was escalated. *(Out of scope for now, owner, 2026-11-03/04: away posture and return briefing are not on the roadmap.)*

---

## 7. UI concept (phone first)

> Status: **built** for Mission Control (E5b, E12-1…E12-4; milestones 105, 112–115); device rules audit **planned** (E12-5); desktop UI **built in part** (E13, §3.4a). Canvas boards (version 47): iPad 5b–5d, 5f, 5h, 5i and 10e–10f, 10n; phone 10a–10m; desktop in Drey 7a–7k and 9a–9b. See [convergence-gaps.md](convergence-gaps.md) for the board-by-board comparison.

The boards of the design canvas "Drey Tickets — Workflow redesign" are authoritative. Guard rails:

**One app, one code base, three layouts**
- **Phone** (below 768 pixels): one column, **no bottom tab bar**. The menu top left (three bars) replaces the content by chat history and the places Work, Crew, Settings (§6). The input field has quiet space at the bottom; important actions sit in the lower third.
- **iPad** (canvas rows 5 and 10, 2026-11-06): the phone app with more room — **no top tab bar**; the phone menu behind a menu button in the header, which shows and hides a sidebar: from a certain width (set in code, not drawn) the sidebar is shown by default, below it hidden (the boards draw it hidden; owner decision 2026-11-06). Work list next to the ticket, the chat centred (680 px). Same pieces everywhere, built once: ticket rows, the ticket card of 9a (ID, status pill, Thread, then Flow / Worker / Cost), the answer card, the composer with Dictate. Touch: every control 44 px or more, answer options 52 px, primary button 48 px; active rows and places are grey, never the highlight colour.
- **Desktop web** (from 768 pixels, the engine-served app): today **top tab bar** with Work (counter "Needs you"), Chat (toggle), Crew and Settings at the right (the canvas draws no board for it; it keeps this layout, owner decision 2026-11-06, G-37). Below: list left, detail in the middle and the **dock on the right**. The dock shows Mission Control (chat) or Capacity (who does what, utilisation, what is running); in history mode the chat list. The chat button folds it away, then the work gets the full width. In Shape mode the list collapses, the plan stands in the middle, the dialog in the dock.
- The earlier tab bar with the raised chat button is dropped; it was in the way in trials.
- **Notes on phone and iPad** (10k, 10l, 10n): the vault is reachable away from the desk — search, recent notes and folders; a note opens in View mode with an Edit button, its tags and a link to its ticket, and **Ask about this note** opens Mission Control. The engine contract for it is open (convergence-gaps G-40).
- **Tokens (Anthrazit):** type 13 px minimum, 12 px only for dense desktop list metadata; the one muted text colour is `#b3b7bc` (never `#747980`); status colours come from tokens — orange `#e8a25a`, one red `#ee8f89`, green `#93c47f`; a row turns orange from 70 % of the allowance and red when used up.
- **Drey desktop** is not this layout: it uses views, docks and the editor (§3.4a).

**Behaviour that applies everywhere**
- **Everything begins at the top, answer near the hand:** conversations and lists begin at the top edge and scroll as needed. The open question with options and send button sits **directly above the input field** (short paths). A choice is reversible and never the action; triggering happens by button ("Send "X"").
- **Areas grow first and then scroll:** nothing is cut off; the scroll bar appears only when the content is taller than the space.
- **One ticket = one card:** id, kind chip, **persona as chip top right**, title, status line with dot, age and **total cost** (§5.4). The Crew view renders no tickets, only people and steering.
- **One state, one place**, persona chips throughout, groups instead of columns (Needs you, Running, Shaping, Prioritized, Ideas), Done in the archive.
- **The ticket screen is the destination of every card** (render, gate bar, proof, cost table at the end, actions at the bottom); edit only as an exception (§5.5).
- **Streaming including thinking trace**, folded after completion ("thought N s").
- **Questions are cards:** question shape as options with consequence and recommendation; applies to all option cards.
- **States with action:** a stuck worker offers Nudge, Hand to Claude Code, Stop (§4.3); a running part is locked (§5.9).

**Settings (core screen, v2).** So that nothing has to be set on the desktop:
- *Appearance* (stored only on this device, takes effect immediately — **D10**): **Theme** (Anthrazit, Drey, Cyberpunk), **highlight colour** (theme default or blue, turquoise, violet, pink, orange, yellow; status colours green, amber, red stay fixed), **text size** a slider with five steps S / M / L / XL / XXL = 15 / 16 / 17 / 19 / 21 px body, L (17 px) the default, with live preview, *Compact lists*, *Reduce motion*. Everything else is stored per vault.
- further categories: *Chat* (thinking trace, new chat, attachments), *Away and alerts* (away posture, what notifies), *Devices* (pair, revoke, read only, §3.6), *Repositories* (launch command for verify, default branch), *Engine* (runner status, tickets vault, version). *(Built in part: E12-3b lists what is missing.)*
- On the phone the menu leads to the list "Settings", on the iPad it is the same entry of the menu.

**Device rules (binding)**
- **iPhone:** top 47 points free for status bar and Dynamic Island, bottom 34 points for the home indicator; navigation bar 44 points with back arrow plus label in the accent colour and centred title; **large title** on main lists; type steps 17 (body), 15 (secondary line), 13 (caption); input fields at least 16 pixels so Safari does not zoom; on-off options as **switches**; rows that open carry an arrow; touch target at least 44 points; no painted status or keyboard strip.
- **iPad:** top 24 points, bottom 20 points free; the same type steps; **pointer operation** (lighten on hover) and **visible keyboard focus**; segmented switches with 44-point hit area. Not implemented: Dynamic Type, swipe actions, context menus on long press, shortcut hints, Split View and Stage Manager.
- **Drey desktop without a parallel world:** the same contents Drey-native (ticket as a note in the editor, Work panel as a side bar, persona configuration as a settings page); no second component world.

---

## 8. Migration plan (strangler, every stage shippable)

> Status per stage in the table. Nothing from E0 onward is owner-verified yet (check each changelog entry's marker).

| Stage | Content | Acceptance core | Status |
|---|---|---|---|
| **E0 — Workspace** | create `packages/tickets-engine`, folder moves without behaviour change, project references, ESLint boundaries | all existing specs green, `npm run verify:*` unchanged | **built**, 97 |
| **E1 — core/store** | extract `core/` (ticket, pipeline, transition, normalize, validate) + `store/`; unify the transition machine; status log + fleet ledger (§3.3) and scout track (§5.6) as pure data forms | god file `main/index.ts` < 20 KB leftover wiring; five move variants replaced by one; a scout run writes `## Report` without a worktree | **built**, 98 |
| **E2 — services + server** | break BoardService into five services; IPC handlers become thin adapters; remote gateway consumes the same services | IPC channel names stable; remote PWA runs against `server/` without loss of function | **built**, 99 (E2a), 100+101 (E2b) |
| **E3 — personas** | persona directories (`_meta/personas/<id>/`), `persona:` in pipeline.md, resolution (3 levels), Crew view + persona detail (Chat / Memory / Setup), memory write and read path, cost attribution | one run started through a persona; one memory entry from the handover + one from the persona chat confirmed; `/report` groups by persona | **built**, 102 |
| **E4 — verify/proof** | Playwright harness in the runner (headless), `qa-default` prompt, attachment writer, `## Verification`, proof card in the web UI | a ticket with real screenshots in "Needs you", acceptance by tap merges | **built**, 103 |
| **E5 — chat intervention + UI unification** | chat service with confirm cards; `CreateTicketCommand` as chat intent on all chat surfaces; ticket screen (render + edit) as destination of every card; web UI becomes the main client (Work / Chat / Crew); desktop renderer rebuilt on the same API | "move by chat" and "new ticket by chat" incl. confirmation; ticket edited on the phone = commit, visible in the desktop editor; desktop and phone show the same thread | **built**, 104 (E5a), 105 (E5b), 106 (E5c) |
| **E6 — self-improvement** | `friction.md` in the handover prompt, aggregation run, `improvements.md`, 1:1 area in the persona detail, threshold card in "Needs you" | a proposal with evidence appears; applying produces exactly one commit; dismissing closes without side effect | **built**, 107 |
| **E7 — status log and ledger** | per ticket `<id>.status.log` with verb grammar and keys, `_meta/ledger.jsonl`, new Needs-you kinds (§3.3, §4.9) | built, not accepted | **built**, 108 |
| **E8 — scout** | ticket form `scout` with `## Report`, decision list, promotion by chat (§5.6) | built, not accepted | **built**, 109 |
| **E9 — chain as delta** | `chain:` in the frontmatter, insert, skip, notify, chat command `setChain` (§5.7) | built, not accepted | **built**, 110 (milestone 111 completes the board: configurable `priorities:`, `setBlockedBy`) |
| **E10 — Shape and plan to accept** | Shape mode in the chat, plan delta with shadow copy, line marks, split proposal of the model, plan to accept, persona per part, flow editor, schema `### Parts` (§5.7 to §5.9); **E10-6 you as a crew member** | a plan is edited together, only the owner's delta reaches the model; the split shows n parts from the plan; parts move and delete; running ones locked | **built**: E10-1 (120), E10-2 (121), E10-3 (122), E10-4 (126), E10-5 (128), E10-6 (132). Follow-ups E10-3b, E10-4b, E10-5b open |
| **E11 — review and proof** | diff review with line comments and Whole file, walkthrough video, captions per criterion, cost table at the end of the ticket, estimate from history (§5.2 to §5.4) | comments go as feedback to the persona; a video lies at the ticket; estimate only from 3 similar runs | **built**: E11-1 (116), E11-2 (117), E11-3 (118), E11-4 (119). **Open:** E11-1b follow-ups, **E11-1c video size rule**, E11-2b wide layout |
| **E12 — navigation, history, settings, device rules** | menu with chat history, top tab bar, dock with history mode, settings screen, Crew with states, iOS and iPad rules (§6, §7); Markdown surface as shared building block (§3.7) | history opens instead of the chat; theme, highlight colour and text size settable on the device; no bottom tab bar | **built**: E12-1 (112), E12-2 (113), E12-3 (114), E12-4 (115). **Open:** E12-3b, E12-5 device rules audit, **E12-6 Markdown surface (in progress)** |
| **E13 — Mission Control inside Drey** *(added after v2)* | views, view presets, status bar slot, link fallback, ticket as a document, Board + Crew tabs + Capacity band; then Assistant targets, Review tab, Shape in Drey, Parts block, Flow tab, Settings → Tickets, Work view | see [desktop-integration.md](desktop-integration.md) and `specs/roadmap.md` | **built**: E13-1 (123), E13-2 (127), E13-3 (124), E13-4 (125), E13-6 (129), E13-8 (130). **Open:** E13-5, E13-7, E13-9, E13-10, E13-11, E13-12, E13-13 |
| **D-1 — the chat reaches its model** *(defect)* | sync of the assistant's LLM settings to the engine on change; both HTTP dialects; error card | Pia and Paul answer from the model Drey uses | **built**, 131 |

**Superseded tickets (req-75):** W6a to W6c (Shape dialog, plan delta, split) are absorbed into E10 and re-cut there; W8a and W8b (phone as chat client, Shape and voice on the phone) are dropped, the phone is Mission Control; W7 (routing rules) is dropped, the persona resolution replaces it (and D5: no overlap guard).

Order logic: E0–E2 create the structure, E3–E5 deliver the visible jumps. Personas **before** verify, so that Tessa is real from the start.

---

## 9. Risks and open decisions

| # | Risk / decision | Classification | Status |
|---|---|---|---|
| R1 | **Editor bridge** is the only real Drey dependency that is hard to port | hence Drey stays a thin client instead of a full extraction; the OpenDocsBridge delta mechanics belong in the plugin, not in the engine | open (design stance) |
| R2 | **Repo split timing** | trigger list instead of gut feeling: split only at (a) a second real consumer, (b) a diverging release rhythm or (c) a wish to publish — then incl. a licence decision (GPL-3.0-only) | open |
| R3 | **LLM cost of the verify step** (vision calls per criterion) | persona budget; screenshots capped (≤6). *Superseded in part by v2: video is always recorded (R6)* | open |
| R4 | **Chat misdirection** | every writing chat action needs the confirm card; destructive commands (archive, stop) additionally armed-two-step as today | built |
| R5 | **Two UIs during the migration** | draw the E2/E5 boundary deliberately: the old desktop UI stays functional and untouched until E5; no half-finished third UI in between | closed (E5 shipped; the legacy remote stays the fallback until the owner's round) |
| D1 | **Language of the personas** | UI texts are English (project rule). Open remains only the answer language of the personas (owner's language or English) | open |
| D2 | **Multi-project** (several tickets vaults, req-72) | the engine holds one vault context per request; Crew view per project for now, cross-project aggregate later | open |
| D3 | **Desktop app role long-term** | if E5 holds, Drey is for tickets only the editor bridge — decide this deliberately, not creepingly. *Update: decided differently by the desktop integration (§3.4a): Drey becomes a full surface of Mission Control.* | **decided, 2026-11-04** |
| D4 | **Cut of "the one conversation partner"** (§6) — **decided for Shape (§5.8):** the dialog runs through Mission Control, Paul is handed on; to be checked in use | business only through Mission Control; the persona chat stays as the coaching exception. Whether the ticket thread is still needed as a direct line shows the prototype in use | decided, check in use |
| R6 | **Storage for the walkthrough video** (always recorded, at most 60 s) | **decided 2026-11-04: at most 25 MB per file, no retention by age or folder size** (E11-1c, planned). Videos live in the tickets repository unless `videos.inGit` is off | decided; E11-1c open |
| R7 | **Markdown surface as shared building block** is Drey-internal today | extraction in E12-6 (owner priority); until then render plus edit toggle in the web app | in progress |
| R8 | **Quality of the cost estimate** (little history, changing models) | show only from 3 similar runs, name the basis, never as a promise | built |
| D5 | **Overlap guard of the engine** without touches display | **decided: none** (req-75 W7, W8 dropped) | **decided** |
| D6 | **Storage place of the line comments** (§5.3) | structured feedback in the Handover | **decided** |
| D7 | Names and default crew | decided (owner, 2026-11-04): **Pia is Mission Control itself**, the one contact; **Paul plans**; default crew Paul, Ben, Ralf, Tessa; no design persona (further roles such as a security review are examples and are added in the flow editor) | **decided** |
| D8 | **Tabs Chat and 1:1** in the persona detail | merged into one conversation | **decided** |
| D9 | **Threshold and size classes of the estimate** | 3 similar runs; size classes by file count later | **decided** |
| D10 | **Scope of the settings** | appearance per device; the rest per vault | **decided** |
| D11 | **Product name** (working title "Drey Storm"; alternatives Drey Crew, Drey Forage, Drey Scurry, Kobel) | **Drey Crew**, fallback **Kobel**; name check before any rollout; the code is not renamed | **decided**, name check open |

---

## 10. Appendix

### 10.1 ADR draft (placement in the existing chain)

> **ADR-00XX — Tickets engine: package cut, personas, proof gate, chat bus**
> Status: proposed · Amends: ADR-0076 (schema deltas §5.2), ADR-0077 (persona resolution replaces column pins), ADR-0086 (remote becomes the main client), ADR-0087 (group language stays; phases internal) · Relates: ADR-0075 (runner stays the engine).
> Context: §1.2 of this document. Decision: §3–§6. Consequences: §8, §9.

> Update (2026-11-04): this draft became [ADR-0088](../../09_architecture_decisions/0088-tickets-engine-package-cut.md) (with "Later changes" recording D5–D11 and E10–E12). Views are [ADR-0089](../../09_architecture_decisions/0089-views-saved-layouts-with-their-own-tabs.md).

### 10.2 Glossary

**Persona** — named agent (name, role, prompt, model, budget) · **Human persona** — the owner as a persona (`kind: human`), the target of manual gates (§4.1, §5.7) · **Proof** — screenshot-backed verification report (`## Verification`) before the owner gate · **Command bus** — the one set of typed mutation commands in `services/` · **Mission Control (Pia)** — the central chat intervention · **Engine** — `packages/tickets-engine` (core + store + fleet + services + server) · **Status log** — append-only verb log per ticket (§3.3) · **Fleet ledger** — append-only JSONL of the fleet events (§3.3) · **Scout** — ticket form without code change, ends with `## Report` + decision list (§5.6) · **Away posture** — verbatim absence mandate with return briefing (§6; out of scope) · **Part** — piece of a split plan, becomes its own ticket with `parent:` (§5.9) · **Phase** — pipeline column (not to be confused with part) · **Gate** — a step in the flow of a ticket · **Shape** — working out a new task together with Paul (§5.8) · **Plan delta** — the owner's changes to the plan since Paul's last turn (§5.8) · **Flow editor** — graphical shaping of the chain (§5.7) · **Dock** — right column with chat, capacity or history (§7) · **Chain** — gate sequence per ticket: standard from `_meta/pipeline.md` + delta in the ticket frontmatter; notify rules are gate attributes (§5.7) · **View** — a saved Drey layout with its own docks, panes and tabs (Notes, Work; §3.4a, ADR-0089) · **Manual step** — a chain gate for the owner that parks the ticket with `awaiting: you` (§5.7).

### 10.3 Firstmate comparison (kunchenguid/firstmate, state 2026-11)

Firstmate ("talk to one agent, ship with a crew") orchestrates agent fleets through a single contact. Checked which of it our idea models better — result:

| Firstmate concept | Decision | With us |
|---|---|---|
| **One conversation partner** (the crew never talks to the captain directly; the first mate relays) | **Adopted, with an exception** | §6: business only through Mission Control; the persona chat stays as the coaching channel, because coaching *is* the conversation with the persona itself |
| **Zero-token watcher** (supervision by file / Git events, a model only on a real event) | **Adopted** | §4.9 — state is derived from status log / Git / ledger, not asked |
| **Ship vs. scout** (exploration ends with a report + decision list, promotable) | **Adopted** | §5.6 — Paul's triage is the first scout run |
| **Keyed decisions** (`needs-decision [key]`, explicit resolve, open-decisions fold) | **Adopted** | §3.3 — open keys stay in "Needs you" until explicitly closed |
| **Declared waits** (`paused: … until …`, bounded re-check cadence) | **Adopted** | §4.9 — "waiting" is data, not permanent alarm |
| **Away posture** (verbatim mandate, mechanically bound, return briefing) | **Adopted in the concept, out of scope in the roadmap** | §6 — phone-first also means the phone may be off |
| **Fleet ledger** (append-only JSONL as a stable status hook for third-party tools) | **Adopted, simplified** | §3.3 — `_meta/ledger.jsonl`; we need no gap detection, Git is the insurance |
| **Worktree isolation per task, teardown fail-closed** (nothing uncommitted is discarded) | **Already there, tightened** | we have worktrees; new is the rule: teardown refuses on unlanded work |
| Dispatch profiles with quota routing across accounts | **Not adopted** | our pool + router (§4.6) suffices; quota routing across several accounts is fleet-operator complexity for a single user |
| Secondmates (persistent sub-fleets over SSH) | **Not adopted** | Drey is local-first, one machine, one crew; deferred to "when two machines really come up" |
| Relay (public mentions via X/Discord) | **Not adopted** | no public control surface wanted; remote access is the PWA |
| Delivery modes per project (no-mistakes / direct-PR / local-only) | **Not adopted (for now)** | one pipeline with a verify/proof gate for everything; project modes would be configuration surface without current need |

### 10.4 Future improvements (backlog)

Deliberately deferred ideas — good enough to record, not good enough for the current scope.

**F1 — Photo annotation in review (markup).** In review steps, proof images (screenshots, photos) should not only be viewable but **zoomable** (pinch / tap) and **directly annotatable**: arrows, freehand, text. "The button sits too far right" as an arrow on the image instead of prose in the chat — the most precise UI feedback one can give. The annotation follows the file philosophy: it is stored as a file at the ticket (annotated image next to the original, e.g. `proofs/<run>/shot-01.annotated.png` or SVG overlay + unchanged original) and goes with the rejection / feedback as context to the persona — no separate annotation database. **Placement:** primarily this belongs to the **design step** (design-review gate before building) — there UI feedback is cheapest. In the final gate it is actually too late, but better there than never: the same annotation building block therefore hangs on all review surfaces where images appear (proof view, design review, final gate). **Integration options:** (a) build a slim canvas annotation ourselves (a few hundred lines, full control, local-first compliant) or (b) embed an open design tool (e.g. Penpot via embed / API) — would bring a real design handoff with comments right on the artboard, but would be one more service to run. Decision deferred until the design step is built concretely. **Why not now:** the review flow works without markup; annotation is refinement, not a blocker. *(Out of scope: photo markup, owner 2026-11-03/04.)*

**F2 — Weekly and monthly costs.** The surface shows ticket, phase and day costs; a weekly sum exists nowhere yet. Proposal: one line in the crew header and a report by chat ("What did the week cost?", §6).

**F3 — Gestures and keyboard.** Swipe actions (archive chat, close row), context menus on long press and shortcut hints in the menus (⌘B, ⌘K); Dynamic Type instead of the fixed text sizes.

**F4 — Stage Manager and Split View** on the iPad: behaviour at narrow windows (the dock becomes an overlay) is not designed.
