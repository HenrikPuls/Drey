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

**Status (2026-10-31):** version 0.8.1, milestones 1–89 built — 1–83
owner-verified (milestone 82, auto-update from GitHub Releases ADR-0074,
end-to-end on a real install, the 0.7.0 → 0.7.1 update round included
docs/07 checklist; milestone 83, the tickets foundation ADR-0075/0076,
through the live board rounds T-0001 – T-0006 in the owner's tickets
repo). **Milestones 84 (the fleet runner) and 85 (continuous
orchestration, ticket T-0007, ADR-0077) — like the later owner requests
86–89 — are built and suite-green but await the owner's rounds** — see
their changelog markers. The owner's verification round for 1–81 closed
2026-10-17: every "not yet
manually verified" marker below those entries is cleared, the bug-11
fix included. Milestone
ids are assigned when work starts — check `changelog.md` for the
highest used (latest: milestone 90 = req-75 W2; latest requirement id: req-79
(req-75–78 added 2026-10-31: the Work panel, STRIDE, TARA, the red-gate
back-move; req-79 = the fleet brief's short instructions file; req-74 = due-date reminders, T-0012; req-73 is readable board
issues, renumbered from req-66 — the tickets remote holds req-66)),
the update check's positive answer is inline text — req-43 and req-44
were owner requests outside the list, shipped and owner-verified in
the same step).
Items A1–A5 of the architectural cleanup shipped on 2026-10-13, and
A10–A12 on 2026-10-17 (changelog); A6–A9 remain.

### Known defects

(none known)

### Now (small, daily value)

The assistant tool rework (owner request, outside the list, 2026-10-13)
shipped as milestones 76–79, the removal of the embedding retrieval
(owner request, outside the list, 2026-10-14) as milestone 80,
configurable shortcuts as milestone 75 (ADR-0073) and zen mode (the
former "Next" item 6) as milestone 81 — see the changelog. All of it is
owner-verified (verification round closed 2026-10-17), the bug-11 fix
included.

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
milestone 89, W2 as milestone 90 — changelog; W1b, W2b and W3 shipped
as owner-requested additions, see the changelog).

- **W4 — The worker on the ticket.** Current action, recent actions,
  pause / tell / take over / stop on the ticket page (the takeover tab
  goes); a Workers view with one card per live worker; a stuck worker
  (no edit for N minutes, repeated reads) is flagged with nudge /
  hand over / stop.
- **W5 — Capture by hotkey and voice.** A second global chord "New
  ticket" (ADR-0073) opens a small capture window that starts Windows
  dictation (Win+H) — no own speech recognition (req-11 stays excluded;
  local Whisper may be reopened later). One model call tidies the
  dictated text into title and description (raw text kept in the Log)
  and suggests the track.
- **W6 — Shape track.** The plan-mode dialog with the project context
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
- **W7 — Orchestrator.** Phase tickets with gates between phases;
  routing by a rules file in the tickets repository (first match wins:
  worker, model, review); `touches:` paths per ticket and an overlap
  guard that holds a ticket while a running one touches the same
  paths; rebase on the integration branch and re-test before Ready.
- **W8 — The phone as a chat client.** The req-66 client rebuilt: each
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

- **Chain alerts fix (owner request, 2026-10-31):** the run's usage
  in the thread as a menu, like Claude Code's context indicator — a
  small context gauge in the composer toolbar whose click lists context
  used / window, tokens in (cached) / out, cost, turns, reads and the
  elapsed time. Waits for T-0061 (W4a), which rewrites the thread and
  only carries these numbers as the meta line's tooltip.

- **req-79 (fleet token audit, 2026-10-31):** the other levers the audit
  of 52 runs / ~372M input tokens found, by size. (1) A run has no
  context ceiling: four build runs of 174–264 model calls, their context
  grown to 240–310k, spent 44 % of the total; a budget on
  `lastTurnContext` or turns that ends the run and starts a fresh one
  from the diff (T-0049's handover modes) is the largest lever. (2) The
  commit phase is mechanical (merge, push, verify from a fresh fetch)
  yet spent 7 % at 15–92 calls per run; the runner could do it in code
  and call a worker only on a conflict. (3) `plugins/tickets/main/index.ts`
  and `renderer/index.ts` (~80 KB each) were read 40 and 89 times;
  splitting them makes every tickets ticket cheaper. (4) The board's
  own `_meta/prompts/` copies predate req-55's "keep the context small"
  rule (Settings → Tickets offers "Reset to the shipped version").

- **req-75 W1 (Work panel):** the per-phase brakes (pause / stop / play
  one automatic phase) are no longer drawn — only the master switch is;
  a single phase is held over the runner's `POST /chain/column`. Decide
  in W4 (Workers view) whether they come back there. The thread is one
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
