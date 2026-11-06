# Drey — Decisions: excluded and decided against

Ideas that were considered and **not** built, kept so they are not
re-litigated by accident. Open work lives in [`roadmap.md`](roadmap.md);
what shipped lives in [`changelog.md`](changelog.md). An item moves here
when the owner decides against it, with the date and the reason; reopening
one means moving it back to the roadmap with a new justification.

## Excluded ideas

- **Renaming stored identifiers to "Crew" / "Accept"** (owner, 2026-11-06; milestone
  173). The design canvas "Drey Tickets — Workflow redesign" settled two words:
  the area is **Crew**, never "Team", and the decision verb is **Accept**, never
  "Approve" or "Sign off". The change is wording only — what a user or reader
  sees. Everything persisted or part of a contract keeps its name: ticket, chain
  and frontmatter values, phase and gate kinds (the `approve` checkpoint action,
  the `sign-off` stage id), file and folder names (`team/`, `approve.ts`), routes
  (`/api/tickets/<id>/accept` already existed), setting keys, IPC channels, CSS
  classes, MCP tool names, the Mission Control tab id `team`, and git/branch names.
  Where such an identifier reaches a screen it carries a display label ("Accept").
  Also unchanged: the **tool-call approval** of external tools and MCP writes
  (`approval: ask | allow`, the approval dialog, a worker waiting for a tool
  permission) — a permission to run a tool, not the owner's decision on a plan or
  result — and the dated entries of `specs/changelog.md`, which record what was
  written then. Renaming the stored values was weighed and is listed as a
  roadmap follow-up with its migration, not done. Decided the same day (canvas decisions 12 to 14, later reshaped by 15 and 21): the product name stays "Drey Crew" while the tab and area is "Crew". (The iPad sidebar wording of that day was superseded the same day: the iPad works like the desktop, canvas decision 12.)

- **Autopilot states map onto the ADR-0077 master (owner, 2026-11-06).** On = master on; Paused = the gentle halt with a stored resume time; Off = master off, manual starts allowed; Stop-now is the existing red stop and leaves the state Off. ADR-0077's ruling that the master never survives a restart stays: after a boot the state is Off. The state lives in the engine (`chain.json`), read-only paired devices only read it. Concept §6.1; no new ADR, ADR-0077 gets a later-change note when it is built.

- **UI text is English by convention — widened to a catalog (owner, 2026-11-06).** CLAUDE.md says everything the UI displays is English; that stays the first-locale rule, but the way strings live changes for the new surfaces: every user-visible string is a catalog key (no hard-coded UI strings, no sentences assembled from parts, ICU plurals, `Intl` for numbers, dates and currency, layouts tolerant of 40 % longer labels). English remains the only shipped locale until another is asked for. CLAUDE.md's language section is **not** edited by this docs round; it is changed when the catalog mechanism lands, with its ADR (roadmap item "i18n for the new surfaces").

- **The pipeline's last column is not named "Sign Off" any more (owner, 2026-11-06, canvas decision 15; reverses the entry above of the same day).** One state list `Inbox → Shaping → Prioritized → Building → Review → Ready to try → Done`; no Sign Off, no Commit, no Ideas, no numbered folders in the UI. The engine follows (roadmap item). The product stays "Drey Crew", the tab and area "Crew". Accept lives only on the Mission Control decision card, never a second time in the ticket body.

- **Waiting for, or building, `dk import` / `dk add --id` (dricket R-10 / R-28)
  for the ticket migration** (owner, 2026-11-05; E14-3b). Drey has one user; the
  one-time migration writes the ticket files itself in the protocol's on-disk
  format and commits them to the store's `tickets` branch with git, then
  `dk validate` judges the result. This is a deliberate, one-shot exception to the
  entry below (a migration, not a write path: it runs once into a fresh store and
  is never used by the app). The number-gap placeholder tickets are gone with it.

- **A TypeScript re-implementation of dricket's writes, claims and
  transitions** (owner, 2026-11-05; ADR-0090 later change, E14-4). Drey reads
  tickets from the files of the store's checkout with a **read-only** parser
  (the one deliberate deviation from "no re-implementation": it parses the
  format, it decides nothing) and writes only through
  `dk put --claim --if-version`, claim, release and extend. Not re-proposed: a
  second writer would need dricket's fencing, validation and CAS rules in two
  places. Reads through `dk` (one process per ticket, 29 s for 91 tickets) were
  the alternative; they are only the fallback when no checkout is configured.

- **"Refine with agent" and the `refine-interactive-default` prompt**
  (owner, 2026-11-04; removed in E13-9, milestone 144). The checkpoint
  companion dialog — a worker that walks plan review, review or commit with
  the owner — is superseded: shaping an idea is the ticket file plus Mission
  Control in the Assistant (Paul edits the `## Plan` chapter), and the review
  of a finished branch is the Review tab. The button is gone from the ticket
  header, the Work panel (row menu, decision bar) and the shipped prompts; the
  interactive run keeps its `'plan'` mode ("Plan with agent" on the first
  automatic column, `plan-interactive-default`). Not re-proposed. Mission
  Control (`apps/mission-control`) never had the button; the phone's
  "Refine…" menu edits ticket fields and is unrelated.

- **req-74 alternatives — app-internal toast chrome; OS-scheduled
  reminders while Drey is closed** (2026-10-31). The due-date digest
  notifies through `ui.notify` (SDK 1.34) — the app's one established
  "needs the owner while they may look elsewhere" mechanism (req-64),
  with click-to-focus and tag-replacement already built. New in-app
  toast chrome would be a base UI surface no other feature shares, and
  invisible when the window is behind others or minimized. Scheduling
  OS toasts for the closed app would need a Windows startup task,
  protocol activation and app-identity plumbing — rejected for scope;
  the next start reports the backlog in one digest instead.
- **Req-3/req-15** — `copilot-web` provider (Playwright + system Edge
  driving M365 Copilot's website). Prototyped, never merged — fragile
  PoC (ADR-0040). The code now lives in the private
  `drey-private-plugins` repository (moved there 2026-10-17 when this
  repo went public; the branch is no longer on the public remote). Not
  part of the Req-29 remainder any more.
- **Req-17** — Jira integration: inline live ticket status, create
  tickets from the editor.
- **req-64 alternative — an MCP `ask_owner` tool for fleet workers**
  (2026-10-20). The runner would serve a tool that blocks inside the
  worker's turn until the owner answers — the cleanest shape for the
  model. Decided against for the `QUESTION:` text marker: it needs an MCP
  server in the runner and per-worker config injection for each CLI, and
  whether OpenCode keeps a tool call blocked for minutes to hours was
  unverified; the marker works for both workers with what they have.
  (Later finding: OpenCode's own `question` tool does block for hours —
  through a form — and the adapter now answers it; the marker stays for
  Claude Code and for a question at a turn's end.)
- **req-9** — OCR remainder (iPad): on-device handwriting recognition.
  Desktop half shipped (`ocr` plugin, vision-capable LLM, ADR-0050).
- **req-21** — dataview.js support.
- **req-10** — iPad/iPhone access via Tailscale: Drey itself running on
  the device (the editor, the vault, the assistant). Remote *control* of
  the tickets board from a phone, with Drey running on the desk, is a
  different thing and is on the roadmap as req-66 (owner, 2026-10-30).
- **req-11** — audio recording in interview mode (local Whisper; Win+H
  as likely first step). Owner, 2026-10-31: ticket capture uses Win+H
  first (req-75 W5); local Whisper may be reopened later.
- **The kanban board as the tickets UI** (2026-10-31, owner). Eight
  phase columns side by side need ~2000 px, repeat worker state in four
  places and do not show whose turn it is; the owner does not use it in
  that form. Replaced by the Work panel (req-75, ADR-0087); the phase
  folders stay the storage format. With it go the exact hand order
  (`_meta/order.md` pins): Ideas are ordered by `priority:`, newest
  first within one (owner, 2026-10-31 — a rating is enough).
- **Job Queue (generic, multi-consumer)** — background processes with
  status/progress, crash persistence, auto-pause on interactive use,
  meant to cover both re-indexing and export. No second consumer exists
  yet; a scoped version shipped inside the embedding retrieval of
  milestone 41, which milestone 80 removed. Revisit as a standalone subsystem once export (or similar)
  needs it too.
- **Embedding retrieval ("semantic search")** — built as milestone 41
  (ADR-0055: transformers.js WASM worker, `multilingual-e5-small`, one
  JSON vector index per vault) and extended in milestones 68 and 71;
  **removed in milestone 80 (2026-10-14)**. The owner's finding: the
  hits did not fit — a note containing the very word searched for
  ("einstein") was not found, while unrelated sections ranked high —
  and the price was a model download, a slow index build, the ONNX
  runtime in the package and its packaging special cases. Since
  milestone 77 a tool-capable model searches the vault itself. What
  replaced it: the Vault chip's context block from text search over the
  section index (ADR-0072). Not to be re-proposed with the same small
  model; a larger one would make the index build slower still.
- **Dedicated keyword search / FTS index** — free-text tag search already
  covers the common case; no evidence it's a bottleneck.
- **Daily tasks day view** — read-only multi-day aggregate; Tasks panel
  already covers collection + tick-back. Only useful if tasks end up
  scattered across many notes instead of daily notes.
- **Daily wrap-up** — automation convenience on existing data, no
  structural gap.
- **Interview mode** — templated adaptive interviews; real prompt-design
  effort, no confirmed usage pattern yet.
- **Colouring the file name by save state** (green new, orange changed) —
  raised in the feature-request list with the owner's own reservation;
  works against the distraction-free goal (2026-10-12, proposal pending
  the owner's confirmation).
- **Bookmark management and sync** (browser tab, ADR-0042) — dropped
  with the owner (2026-10-30, ticket T-0020): scope creep for a Markdown
  hub; the web clipper covers the real need.
- **Routing to to-dos** ("seamless transitions between content and
  tasks") — dropped with the owner (2026-10-30, ticket T-0021): too
  vague to build; the assistant is already the task and navigation
  surface (milestone 57), Jira is excluded (req-17).

- **Mission Control on the desktop (2026-11-04).** *The phone/iPad web app
  embedded in a Drey tab* (the "umbilical cord"): no editor, no docks, no links
  to Search, Backlinks or Git; rejected for a native integration (tickets as
  documents, editor tabs, the Assistant). *A hard-wired "Work" view or a
  "tickets vault" known to the base*: the base stays plugin-neutral
  (ADR-0044) — Work is a plugin view preset and links fall back generically to
  the other vaults. *Shared tabs across views*: the tab bar is where the
  confusion shows; tabs belong to views. *A new LLM provider list for
  Mission Control or the Assistant targets*: the existing LLM integration and
  Settings stay; another model (for example Kimi) is registered there as an
  OpenAI-compatible endpoint.

- **Walkthrough video retention (2026-11-04).** *A total-size limit with
  oldest-first deletion (`videos.limitMb` 2000)* and *any time-based
  retention* are decided against: the only limit is the size of a single
  video (25 MB, `videos.maxMb`); videos otherwise stay until the owner deletes
  them, bounded by the disk. The folder is not in git by default, so the disk is the only cost.

## Won't do (decided against, kept for the record)

- **Auto-pairing the ticket file and its thread across panes** (owner,
  2026-11-01, req-84). The pair's landing matrix (req-75), its pane reuse
  (req-82) and the follow-the-active-tab rule (req-83) all lean on the
  base's focus-based landing: a normal note opened later lands beside or
  inside the thread, and the layout drifts again. The entry points are
  explicit instead — a Work row opens the thread alone, the Files panel
  opens the plain file, the ticket menu's *Open ticket* opens both. Not to
  be re-proposed as an automatic pair.

- **The kanban board as the tickets UI** — columns, worker lanes and
  per-column brakes, drag and drop between and within columns, the
  `order.md` order pins (with Move to top / bottom), folded columns, the
  hide-blocked filter and the per-column dwell metrics (owner,
  2026-10-31, req-75 W1, [ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md)).
  Built through milestones 83–88 and replaced by the Work panel: the
  owner did not use the board in its kanban form, eight columns need
  ~2000 px, and worker state showed in four places. Ideas sort by
  priority, newest first — no hand-kept order. Not to be re-proposed as
  a desk view; the remote client's iPad strip stays until W8.

- **Daily template follows `templates.dir`** — the daily note stays
  seeded from the literal `templates/daily.md` (owner decision
  2026-10-30, ticket T-0019): that is the documented behavior
  (`frontmatter-schema.md`, manual); following the setting would need a
  migration for vaults whose edited `templates/daily.md` would otherwise
  be ignored.

- **Per-column worker slots** (`workers:` in `pipeline.md`, M85) — and
  keeping the key as a per-column cap or a reserved minimum. Decided with
  the owner for req-63 (2026-10-30): slots bound to columns blocked work
  while the provider had capacity; the parallelism is the provider pool,
  the order is priority class, then the rightmost column.

- **One composer switch per external source** (search, fetch, each MCP
  server) — decided with the owner for milestone 79 (2026-10-13): one
  Web chip covers everything that leaves the machine; which sources
  exist and whether they ask stays in Settings → Assistant tools. A
  tools menu in an already full tool row was ADR-0063's reason to defer
  the switch at all.
- **Web search only through an MCP server the user adds** — ADR-0063's
  first answer ("no bundled search provider: a vendor choice and a key
  the app would have to own"). Reversed in milestone 79 (2026-10-13):
  setting up a search server was the hurdle that kept the assistant
  offline. The app still owns no key — the user picks the provider and
  enters their own, or uses DuckDuckGo without one.

- **Pause / resume of large semantic rebuilds on interactive use** —
  considered for milestone 68 and dropped: an interactive ask never
  waits for a rebuild (the query embed queues behind at most one
  16-passage batch — tens of ms — then searches the current index),
  and the actual gap (a mid-rebuild index is incomplete) is not fixable
  by pausing. Recorded in ADR-0055's later-change section. Moot since
  milestone 80: there is no rebuild any more.
- **Task Center / stable task ids** (req-35) — implemented as milestone
  44 (`#task/id:<id>` mint-on-tick write-back) and reverted before
  release: the token is permanent noise in plain Markdown, adoption is
  inherently partial (editor checkboxes and external editors never
  mint), and the guarded mis-tick scenario (duplicate texts + shift +
  tick inside the unsaved window) is negligible for a single user. The
  Tasks panel's write-back resolves against fresh content at tick time
  and skips ambiguous duplicates instead of guessing — that is the
  whole fix ([ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md),
  "considered and rejected").
- **req-24** — Editor: image lines should show only the image, no text.
  → Dropped (2026-09-12): Live Preview already renders image-only outside
  the caret; caret-in reveals the raw `![alt](path)` line by design
  (Req-1).
- **req-25** — Remove "unsaved"/"saved" status; always persist changes.
  → Decided against (2026-09-12): staying with manual save (Ctrl+S/Save
  button). Autosave design drafted and shelved. (The status itself stays;
  only its presentation is open, see the roadmap's "Editor chrome".)
- **req-26** — Frontmatter must update on save.
  → Dropped (2026-09-12): already implemented — `note:save` bumps
  `updated:` where the key exists; fence-less files stay byte-for-byte
  (`specs/frontmatter-schema.md`). Narrowed by milestone 65: a save never
  adds frontmatter.
- **req-41 alternatives** — two other homes for the formatting commands.
  → Decided against (2026-10-13). A *selection bubble* over marked text
  pops up on every selection, hides the line above, and block commands
  (table, callout, math block) have no selection to hang on. A *toolbar
  row of its own* under the meta bar costs a line of height for good and
  leaves the meta bar nearly empty. Built instead: the strip as the head
  of the right-click menu, pinnable into the meta bar.
- **Assistant tool rework — alternatives** (ADR-0071).
  → Decided against (2026-10-13). *New tools for the assistant only,
  the MCP server unchanged*: no break for connected programs, but two
  families of read and write logic for good. *Unified diffs as the edit
  format*: line offsets and hunk headers are what models get wrong; the
  exact search-and-replace that must match once stays. *A JSON-Schema
  library for tool arguments*: the slips are shallow, and the messages
  have to be written for the model. *A higher round cap instead of a
  closing round*: it only moves the point where the turn is lost.
  *A copy of the open buffers in main* (milestone 78): two owners of
  the same text; main asks the renderer at the moment of the call
  instead. *Keeping the `doc_*` live-edit tools*: a second edit tool for
  the same operation.

- **Mission Control redesign, concept v2 (2026-11-03).** *An overlap guard, `touches:` paths and rules-file routing between parallel tickets* (req-75 W7, with W8's phone-client rebuild): dropped — the chain delta (E9) and Mission Control (E5b) cover what they were for; their tickets are closed. *A separate design persona*: dropped, it was only an example. *Proof video on failure only* (E4) and *a video always* (concept v2): replaced by the per-ticket proof mode `ui|tests` — a UI change always gets a video and screenshots, a non-UI change gets neither. *Videos in git by default*: off — the engine ignores `tickets/videos/` unless `videos.inGit` is on. *A bottom tab bar on the phone* (E5b): superseded by a menu (E12-2). *A separate persona Chat beside the 1:1*: merged into one conversation (D8).

- **Convergence audit (2026-11-04).** *Zod schemas as the single contract source* (concept v2 §3.3): dropped, the hand-written `parseXxx` validators stay; no new dependency, reversible. *An autogenerated Mermaid gate diagram with cost per edge in each ticket* (concept v2 §5.4): dropped; instead ticket documents may contain Mermaid blocks and must be processed correctly (roadmap E10-7). *An "Add part" button on the desk plan to approve* (board 7c): removed, the cut changes in the plan or by asking Mission Control. *A separate plan-step list in the ticket*: dropped, status per part lives in the Parts block.
