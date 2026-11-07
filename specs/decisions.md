# Drey — Decisions: excluded and decided against

Ideas that were considered and **not** built, kept so they are not
re-litigated by accident. Open work lives in [`roadmap.md`](roadmap.md);
what shipped lives in [`changelog.md`](changelog.md). An item moves here
when the owner decides against it, with the date and the reason; reopening
one means moving it back to the roadmap with a new justification.

## Excluded ideas

- **Search and Tasks as two bands of one panel, or tasks as a saved search** (owner, 2026-11-07; req-161, board
  `FindDirections`). Direction B (one field, a "Notes" band and a "Tasks" band that fold) mixed both lists in one
  height and left open whether Match case / Regular expression apply to tasks; direction C (tasks as a saved search
  inside Search) hid the task list behind a saved query and needed saved searches as a new feature. The owner chose
  A: one panel Find with the mode Search | Tasks over one shared field.
- **Find with always-visible segments, filter chips and inline toggles** (owner, 2026-11-08; req-161, the first
  `DeskFind`). A row with a Search | Tasks segment and a scope segment, Aa · ab · .* in the field, task filter chips
  under it and four header icons: "extrem überladen". Replaced by the mode as the title, one ⋯ menu for scope,
  match options, filters, order, Export and Summarize, and a Replace switch in the field.

- **The attach button in the phone's chat composer** (2026-11-07; integrator, recommendation of milestone 194's measure
  sheet). Board 10a's composer has none and its bar no free control, so the button left the phone. Attaching from the
  phone waits for a place (req-114); it is not a deviation to re-open on the board.
- **Decision cards inside the phone's Work list** (2026-11-07; milestone 194). Board 10c draws rows only: a question is
  answered on the ticket (10d), Accept and Send back on its pinned card (10o), a plan on the plan to accept (10j). The
  wide layouts' list is 4.6's.
- **The boards' "D" tile as the app's logo** (owner, 2026-11-07; milestone 192, req-104). Every board draws a
  "D" tile in the title bar. The Drey logo stays and is used in its place; it is no deviation to re-open on any board.
- **A new icon for every glyph a board draws** (owner, 2026-11-07; milestone 192, req-104). An icon may differ
  from a board when the icon set (`src/app/icons/icon.ts`) does not hold that glyph; the nearest one in the set stands
  in. A glyph the set does hold must match. On 9a: Tickets (`layers` for a ticket) and Source control (`git-branch`).
- **Chasing the boards' text rendering** (owner, 2026-11-07; milestone 192, req-104; "ok for now"). Electron on
  Windows draws the same font and size with heavier strokes than the canvas export, a 600-weight line up to
  1 px wider. A UI session does not work around this; the owner may reopen it.

- **Board 9a's 4 px offset between the dock strips and the tab bar** (owner, 2026-11-07; milestone 192, req-104).
  `DeskClean` ends the strips at y 81 and the tab bar at y 77. The owner: the board is wrong here, the two read as
  one continuous line. Both are 37 px; the tab bar, meta bar and editor stay on the board's position, the dock
  contents sit 4 px higher than drawn.

- **2026-11-07: req-96's 'the chat is never the centre on the iPad' gets one exception, the Thread state of board 10f** (integrator's ruling Q2, wave row 4.6). `Thread` opens the ticket's conversation in the centre with the chats on the left; everywhere else the chat stays the right pane.

- **The Autopilot board's radii 12 and 6 in the build** (owner, 2026-11-07; milestone 189, D-36).
  `Autopilot.png` draws the popover at 12 and the segments and Stop at 6. The design-scale guard
  (`shared/design-scale.spec.ts`, 4 / 8 / 16) stays: the tickets plugin uses dialog 16 and control 8, and
  the guard is not widened for this board. Mission Control's Autopilot (D-38) follows the same scale.

- **Board 9b "Drey today — Calendar, Source control, Outline, Search and Tasks redesigned" as a
  target** (owner, 2026-11-06 evening; was req-105). The owner: "9b ist kein Zieldesign" — the board
  stays in the canvas and in `docs/design/work-panel/boards/` as a sketch of how the panels could
  look, but no session builds it and the fidelity rule does not measure the panels against it. The
  frame of 9a (req-104) remains the target for the dock headers and the panel chrome; the panels'
  content stays as it is.

- **An agent moving a ticket into Done on a store, and a pipeline key for Accept's run** (req-99a,
  2026-11-06). `dk` refuses an agent's release into a terminal stage (seen in E14-5, checked again
  on v0.6.2 with the six stages), so the commit run hands back to `ready` and the engine makes the
  owner's move into `done`; no second identity and no dk policy change. Accept finds its run by the
  stage id `ready` and the `commit-default` prompt, not by a new `pipeline.md` key: older boards then
  cannot start it by accident, and the contract does not grow for one value.

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

- **Open-before-implementation answers (owner, 2026-11-06).** O-1: Accept lives only on the Mission Control decision card; the desktop Review tab keeps the diff, line comments and "Send back with n comments" plus the link "Decision waiting · go to the card". O-3: all tickets migrate once into the dricket store format (the E14 cut-over); the one state list rides on that migration, there is no rename inside the old numbered folders and no "display titles only" step. O-4: one ICU runtime (`intl-messageformat`) with JSON catalogs in `shared/` for main, renderer, plugins and Mission Control, English first, the ADR comes with req-102. O-5: Autopilot restores as Off after every start (ADR-0077 ruling kept). O-2: Review and Ready to try are **one state**; Accept on it is the sign-off that merges, pushes and lands the ticket in Done; the canonical list has six states, `Inbox → Shaping → Prioritized → Building → Ready to try → Done`, and "Review" stays only as an agent phase name in the flow editor; migration mapping Inbox → Inbox, Plan → Shaping, Build → Building, Review + Sign Off → Ready to try, Done → Done, Prioritized new and manual (confirmed by the owner, 2026-11-06).

- **Build-plan decisions (owner and technical calls, 2026-11-06, afternoon; `docs/design/work-panel/build-plan.md`).** *Owner:* (Q1) the six-state vocabulary and the migration mapping land in the engine before the dricket cut-over import, so the import writes the six stages once (req-99a → E14-7); (Q2) on the desktop Accept lives on both Mission Control surfaces — the Needs-you row / Ready card in the Work panel and the decision card in the Assistant conversation — and the ticket document, Review tab and ticket strip lose theirs, with no engine change; (Q6) Shaping and Prioritized are manual columns, Building is the only agent claim stage (Plan, Build, Ralf's review and Tessa's test are phases of its chain), Ready to try is manual, Accept = sign-off; (Q8) the merge and push of Accept concern the **developed program's repository** (the target repository the agents changed in the phases), not the dricket store, whose tickets are bookkeeping: Accept starts the existing commit step (`commit-default`, an owner-started run under the stop ladder), and when it is green the dricket ticket moves to Done. *Technical calls* (revisit only if the build finds a reason): (Q3) the Autopilot state is an `autopilot` record (`on | paused | off`, `resumeAt`) beside `ChainMaster` in `chain.json`, the orchestrator derives the master, the engine resumes, boot writes Off; (Q4) iPad pane state per device in `localStorage` by orientation; (Q5) Notes reuse `libs/markdown-surface` and `mc-markdown`, the pinned formatting strip follows; (Q9) the fifth text-size step ships with the Appearance work of wave 3. Roadmap ids for the three canvas items that had none: req-103, req-104, req-105.

- **`claim` stays `["building"]` (2026-11-06).** `claim = ["building", "ready"]` would keep a ticket on Ready to try during its commit step, but `dk next` offers every unclaimed ticket in a claim stage, so agents could pull tickets waiting on the owner. A ticket therefore shows in Building while its commit step holds the claim.

- **State-name decisions (owner, 2026-11-06, evening).** The Work panel's Ideas group is **Inbox** and the row is **Back to Inbox**; the **New idea** button stays, since it names the action. Accept on Ready to try reads plain **Accept**, not "Accept → Done", because Done only follows a green commit step. Old boards are **not** shown under the new names: titles are stored data and the cut-over rewrites them. Order: req-99b, then repeat guide step B on the six stages, then E14-7 with the owner present. req-99c follows the cut-over; File history and save hooks for device saves and the vault-switch event go with req-101. Capacity on iPad is a Mission Control · Capacity switch in the right pane.

- **UI text is English by convention — widened to a catalog (owner, 2026-11-06).** CLAUDE.md says everything the UI displays is English; that stays the first-locale rule, but the way strings live changes for the new surfaces: every user-visible string is a catalog key (no hard-coded UI strings, no sentences assembled from parts, ICU plurals, `Intl` for numbers, dates and currency, layouts tolerant of 40 % longer labels). English remains the only shipped locale until another is asked for. CLAUDE.md's language section was edited when the mechanism landed (req-102, 2026-11-06, [ADR-0091](../docs/09_architecture_decisions/0091-i18n-catalog-for-the-new-surfaces.md)): one `intl-messageformat` runtime over `shared/i18n/catalog/en.json`, bindings for main, the renderer, plugins (SDK 1.46) and Mission Control, a literal-string guard scoped to the new surfaces. Rejected on the way (ADR-0091, alternatives): Angular's built-in `$localize` / `i18n` attributes (two of four runtimes, locale baked in at build time), one library per runtime (the duplication ADR-0044 forbids), nested catalogs, an ESLint-only guard (no template coverage, cannot know the catalog), and guarding the whole repo at once (thousands of findings this item would not fix — the older UI migrates area by area, req-106).

- **The pipeline's last column is not named "Sign Off" any more (owner, 2026-11-06, canvas decision 15; reverses the entry above of the same day).** One state list `Inbox → Shaping → Prioritized → Building → Ready to try → Done`; no Sign Off, no Commit, no Ideas, no Review column, no numbered folders in the UI. The engine follows (roadmap item). The product stays "Drey Crew", the tab and area "Crew". Accept lives only on the Mission Control decision card, never a second time in the ticket body.

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

- **Notes API, req-100 (2026-11-06).** *`chats/` on phone and iPad:* not served. The concept names search, recent notes and folders, the chats with Mission Control are a separate place in the phone menu, and `chats/` holds the literal text of past assistant conversations (the same reasoning as ADR-0072). *Ticket files as notes:* every folder named `tickets` is not served, at any depth, because a dricket checkout may sit inside a vault and a ticket changes through the board, never as a note; a user's own folder of that name is hidden on the devices too, which is the price of a rule that needs no knowledge of the store. *Saving through Drey's `note:save`:* the roadmap asked for no writer beside the save pipeline, but the engine serves phones with Drey closed (concept §3.5) and may not import Electron code, so it applies the same rules itself (the mtime guard, `touchUpdated` from `shared/`, the atomic replace of `electron/safe-file.ts` as a small copy, since `shared/` must stay free of Node for the renderer). *A force flag on the save:* not offered; after a conflict the client saves with the disk's mtime. *Recreating a note deleted since it was read:* a save answers `not_found`, the client may create it again (`note:save` would write it back silently).

- **The Capacity band leaves the Crew tab (2026-11-07, wave 4.2).** Board 7f shows no band under the Crew tab; board 7e shows it under the Board. The band now shows on the Board tab only. This reverses E12-15's "Board and Crew".

- **Fidelity review, wave 4.7 (2026-11-07).** *Four 1 px offsets without a traced cause* (10l task rows, 10n pencil, 10f bubble, 5d pool name; O14): accepted as unexplained, not chased — none changes the reading, and rasterization cannot be ruled out. *A clipped run title on board 5d* (`to re`; O15): the build keeps the ellipse every other board draws; the board's clip is a canvas artefact. *Folding the right dock on the Crew tab by itself* (O7): rejected — a layout change behind the owner's back; the cards wrap instead.
