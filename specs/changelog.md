# Drey — Changelog

The record of everything **implemented**, newest first. Open work lives in
[`roadmap.md`](roadmap.md) → "Not yet implemented"; when an item ships it
moves here. The finer-grained history is not duplicated: the
milestone-by-milestone build log is archived in
[`docs/milestones-done.md`](../docs/milestones-done.md), lasting decisions
live in the ADRs
([`docs/09_architecture_decisions/`](../docs/09_architecture_decisions/)),
and the current architecture in
[`docs/05_building_block_view.md`](../docs/05_building_block_view.md).

**Standing rule (since milestone 32):** the PDF export is a second
renderer of the note. When the editor gains a new rendered element, it
must carry into the export in the same change — or its absence there is
recorded as an explicit decision. The parity checklist lives in
[`docs/06_runtime_view.md`](../docs/06_runtime_view.md) §6.39.

---

## Recent milestones

### Milestone 51 — task due dates + priorities (req-37)

- **Task lines carry inline metadata, Obsidian-Tasks compatible.** A due
  date (`📅 2026-10-09`, ISO) and a priority (`🔺` highest, `⏫` high,
  `🔽` low; none = normal) may sit anywhere on a checkbox or `#task` line.
  The tokens are human-legible annotations, not machine ids (ADR-0033's
  `#task/id:` rejection stands), and they are parsed + stripped by the
  shared scanner (`plugins/tasks/shared/tasks.ts`): `TaskRecord` gains
  `due: string | null` and `priority`, and `text` stays clean — so a
  metadata edit never disturbs `resolveTaskLine`'s text+kind matching, and
  a vault stays readable/writable by Obsidian's Tasks plugin. New pure
  setters `setDueOnLine` / `setPriorityOnLine` (append-or-replace, guarded
  to task lines, indentation-safe) round-trip through the scan.
- **The Tasks panel shows both and can sort by them.** Rows carry a due
  badge (overdue red, today accented, future neutral) and the priority
  glyph; a new sort cycle in the filter row — file order → due date
  (ascending, undated last) → priority (highest > high > normal > low,
  ties by path + line) — persists in `localStorage['drey.tasks']`. The
  file sort keeps the grouped-by-file view; due/priority sorts show a
  flat list (grouping would fight the ordering), in every scope.
- **Editor completion with a date picker.** On a task line (never in
  frontmatter or a fence), typing `due` / `fällig` offers Today /
  Tomorrow / In a week / **Pick a date…** — the last opens a
  caret-anchored popover with a native `<input type="date">` defaulting
  to today that writes the token over the trigger word — plus "Remove
  due date" when one exists; `prio` / `priority` offers the three glyph
  levels and "Normal (remove priority)". The source rides the host's
  markdown language data (the same seam as tag / wikilink / word
  completion, so popups merge) as a plugin editor extension
  (`plugins/tasks/renderer/task-meta.ts`). Completion options ship with
  `filter: false` — CM's label fuzzy-matcher would otherwise drop the
  emoji-prefixed labels ("📅 Today" vs "due"); the whole-word trigger is
  the filter.
- **Click-to-change (req-37 add-on).** The tokens are decorated as chips
  in the editor (`cm-task-due` / `cm-task-prio`, overdue/today colored
  like the panel badges) and a **plain click** on a chip re-opens its
  picker in place — the date picker with the current date prefilled
  (Apply replaces the token, a cleared field removes it) or the glyph
  menu (🔺/⏫/🔽/Normal). The Tasks panel's due/priority badges are
  buttons with the same pickers; both surfaces share one picker
  implementation (anchor + `onCommit`), and panel commits go through the
  shared `applyToTaskLine` routing (open buffer → `setBuffer` + save,
  closed file → read/patch/write + index refresh) — the same path the
  done toggle uses. The row meta moved beside (not inside) the body
  button: a button in a button is invalid HTML and would bubble into the
  open-file action. Click hit-testing is by the token's screen width
  (`coordsAtPos` bounds), not the caret position: a click on the token
  (its right half included) opens the picker, a click beside it — even
  the trailing whitespace behind a line-ending token — places the caret
  normally; the date popover opens the native calendar once on mount
  (one-shot retry on first field interaction), never re-opening by
  itself after a date was chosen.
- Docs: `specs/frontmatter-schema.md` records the line format,
  [ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md)
  gained a "later change" note.

### Milestone 50 — the caret survives a tab switch

- **Switching back to an open tab restores the cursor — the exact
  viewport, and focus.** Every fresh editor state built for a tab switch
  (or a recreated pane) now replays the remembered caret AND the
  remembered scroll offset instead of landing at the top, and entering a
  tab puts the caret INTO the document: typing works immediately,
  without a click into the editor first (a pane's first load — app
  start, session restore — keeps the old no-focus behavior). The exact
  flow the milestone-49 Sources links exposed: follow a link, switch
  away, come back, and the document sits where you left it, ready to
  type.
- **The memory outlives the tab.** Caret and scroll offset are stored
  per doc key for the whole app session — deliberately decoupled from
  the doc records, because a *clean* tab is REPLACED when another file
  opens (milestone 32): reopening such a tab (file tree, Files panel,
  another link) restores its viewport too. Strictly in-memory (nothing
  rides into the session snapshot, a restart starts without carets),
  bounded FIFO past 200 doc keys.
- **The restore applies whenever a memory exists — never gated on the
  caret's offset.** A caret that never left offset 0 (open a document,
  only scroll) used to skip the restore entirely: the `anchor > 0` gate
  confused "no memory" with "memory with head 0", and `loadDocument`'s
  show-the-top reset made it worse. The gate is now "memory exists",
  and the top-reset is skipped (`keepScroll`) whenever a viewport is
  about to be restored — which also fixes the replace/reopen cycle
  (a fresh-opened, never-clicked clean tab replaced by another file
  reopens on its remembered scroll position).
- **Saving keeps the viewport too.** Every save of a frontmattered note
  rewrites the fence (the `updated:` bump) — the renderer adopts the new
  text and reloads the SAME tab in place, and that full replace discards
  CodeMirror's height map: holding the numeric scroll offset alone let
  the browser clamp the scroller (block widgets collapse the height
  estimates) and the view landed at the top. The in-place reload now
  captures the viewport before the swap and replays it through the same
  restore chain a tab switch uses — unless the view is pinned to the
  bottom, where stick-to-bottom stays the destination (the streamed
  search summary keeps following the tail; the same goes for
  non-pinned live-edit pushes, which now hold the position cleanly
  instead of drifting).
- **The scroll restore re-asserts the stored offset.** Two production
  findings shaped it (both invisible in jsdom, both pinned by the new
  Playwright spec `caret-scroll-restore` against the real Electron
  app): focusing the freshly swapped editor makes the BROWSER scroll
  the caret into view — possibly after the restore's first frame — and
  a fresh editor state starts with every block height ESTIMATED
  (CodeMirror's `HeightMap` begins empty), so a raw pixel offset alone
  lands a few lines off in content space. The chain therefore applies
  the raw offset, then RE-ASSERTS it one frame later (the stored value
  is the last word, never a scroll-to-caret), with a strictly gated
  caret-anchored correction on top (capture records the caret's
  viewport-relative position when rendered; the correction only runs
  when the caret is inside `visibleRanges` and the delta is
  sub-viewport — every failure degrades to the raw offset).
- **Explicit jumps still win.** An `openFileAt` reveal (a wikilink's
  heading line, a search hit, a tasks row) runs after the restore,
  CANCELS the scroll restore and moves the caret to its target; a stale
  caret past a shrunken buffer is clamped to the document length. Undo
  history still resets per tab switch (ADR-0003 unchanged);
  multi-cursor selections collapse to the main caret
  (ADR-0037 later-change note).

### Milestone 49 — search summary: Sources links (wikilinks from the digest)

- **The digest ends in a `## Sources` list.** After the model's reply
  settles (or the user stops it), the Search panel appends one line per
  section the prompt actually covered — same order, same whole-section
  budget cut as the material — each carrying a `[[wikilink]]` to that
  section plus the exact `path:line` as plain text (wikilinks have no
  line anchor). Deterministic by design: the model never mints links —
  anchors must match a real heading, and heading-less sections cannot be
  anchored at all. When the hits span several vaults, the label carries
  the vault's name as a prefix.
- **Wikilinks work from vault-less scratch tabs.** A `[[link]]` in the
  `search-summary.md` scratch tab (no vault of its own) previously
  resolved against an empty index — Ctrl-click fell through to "create
  note in the active vault". Vault-less documents now resolve through a
  merged index over every registered vault (the active vault wins path
  collisions and basename ambiguities), open the target in its OWNING
  vault, and never create notes — an unresolved link is reported, like
  the entry drawer's no-mint rule (ADR-0046 addendum). Known limit: the
  link syntax cannot name a vault, so the same relative path in two
  vaults lands in the active one; the label's vault name is the only
  disambiguator.

### Fix — editor: a table-only document can be left again

- **ArrowDown opens the line below a document-ending table.** When the
  table was the note's last block, every caret position sat inside its
  revealed raw source and Enter only ever added rows — the view could not
  be left to type a following paragraph without switching to source mode
  (the extent's end IS the document end, so no position "behind" the table
  existed). ArrowDown on the last real row now appends one blank line and
  parks the caret there; the widget snaps shut. ArrowUp mirrors it when
  the table starts the document at line 1. Everywhere else the arrows keep
  their normal motion, and Enter keeps growing the table.

### Milestone 48 — Full screen (F11)

- **F11 toggles OS fullscreen.** The new `window.toggleFullScreen` command
  carries the keybinding; View → "Full screen" runs the same id and shows a
  check mark that tracks the real window state via the
  `window:fullscreen-changed` push — correct even when fullscreen is left
  by another route (Esc, the OS).
- **The key stays renderer-owned.** The auto-hidden native menu's
  `togglefullscreen` role is gone: its default F11 accelerator swallowed
  the key in main before the renderer's command could see it (the same
  reason the Ctrl +/-/0 zoom items were never menu accelerators).
  Fullscreen rides the `window:toggle-fullscreen` IPC next to
  minimize/maximize/close.

### Milestone 47 — foldable side docks (titlebar toggles)

- **Fold a whole side dock away.** Two icon toggles in the titlebar — the
  left one beside the app mark, the right one before the window controls,
  each above the dock it controls — hide and show the left / right dock as
  a whole (`Ctrl+B` / `Ctrl+Alt+B`, also View → "Left dock" / "Right
  dock"). The editor takes the freed width.
- **Nothing is lost underneath.** A folded dock stays mounted, so its
  panels keep their state (a streaming chat, scroll positions, a docked
  editor); panel order, sizes and collapse state are untouched. The folded
  state persists with the layout (`foldedSides` in
  `localStorage['drey.dock']`); View → Reset layout unfolds both.
- **It opens when it is needed.** Revealing a panel (Search via
  `Ctrl+Shift+F`, a View-menu re-select) unfolds its dock; during a panel
  drag a folded dock shows like an empty one, and a drop into it keeps it
  open.
- Not foldable this way: the bottom dock (it already shrinks to its panel
  headers). An empty dock's toggle is disabled.

### Milestone 46 — Editor snippets: trigger words for Markdown blocks (templates plugin)

Ships the milestone-40 announced follow-up: typing a trigger word —
`tbl`, `code`, `task` or any user-defined one — offers a multi-line
Markdown block; Tab walks its `${n:placeholder}` fields. **Not yet
manually verified by the owner.**

- **Plugin-owned by design**: `plugins/templates/renderer/snippets.ts`
  over the `registerExtension('document', …)` seam and the host's CM
  module instances (`api.editor.cm.autocomplete.snippetCompletion`) —
  `markdownBundle()` stays untouched, and the Tab-precedence question
  that blocked a base-owned source dissolved on inspection: the snippet
  keymap is `Prec.highest` while a snippet is active, so
  `editorIndentation` keeps Tab otherwise (bug-9 untouched). Composers
  are excluded (`document` slot only) — no Enter-submits conflict. The
  built-ins exist as a **parity-tested twin** in the plugin: a plugin
  renderer cannot value-import base `shared/` (the import would resolve
  outside its `plugin://<id>/` root and quarantine the plugin — caught
  by the slash-menu e2e during verification).
- **Fully user-owned library**: `templates.snippets` in app config
  (ADR-0010 — machine-level, not vault data). Seeded with the three
  built-ins on a missing key; Settings → Templates edits, removes and
  adds entries — defaults included — plus a "Restore built-ins" button;
  an explicitly emptied list stays empty. The whole `templates` slice
  travels on every write (`appConfig.patch` merges one level deep).
- **Caret gate**: the slash menu's gate (inline code, links, raw HTML,
  frontmatter) plus every block-level structure — tables, headings,
  list items, blockquotes — since a multi-line block inside one is
  nonsense. Fires on a typed word at a word boundary; `boost: 5` ranks
  it above word completion.
- The renderer keeps one `SnippetStore` snapshot the source reads
  synchronously per keystroke (`appConfig` has no change push) and the
  settings page writes through.

### Milestone 45 — Autotag re-homed into the editor's `⋯` menu (req-36)

The `suggestTags` backend orphaned by the drawer's removal (ADR-0057) has
a new trigger. **Not yet manually verified by the owner.**

- **`⋯` → "Suggest tags"** — sends the **section under the caret** (the
  same heading-delimited unit the tag search reports on; fences hide `#`
  runs) plus the vault vocabulary to the unchanged `tags:suggest`
  backend (`TagSuggester`, the editable `autotag` template). New pure
  helper `shared/note-sections.ts` — a base-side twin of the tags
  plugin's section splitter, since base cannot import plugin modules
  (ADR-0044).
- **Direct apply** — the suggested tags are appended to the section's
  last prose line (fence/table/quote/HTML-safe; a new line when the
  section has no prose), deduplicated against the tags it already
  carries, as one undo step, saved immediately. No chips, no dialog.
- **Failure surface** — LLM off, tags plugin disabled, model failure and
  the every-suggestion-already-present case all show in the editor's
  error row; a small "Suggesting tags…" meta-bar hint shows while the
  model answers (no timeout — cancel stays the escape hatch).
- Caret inside frontmatter asks to be moved into the body first.
  `ctx.llm.suggestTags` for plugins is untouched.

### Milestone 44 — Task Center: implemented, then reverted before release (req-35)

The roadmap's priority-1 "Task Center" item ([ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md),
"considered and rejected") shipped as stable `#task/id:<id>` write-back
addressing and was pulled again the same session, before any release:
minting put a permanent `#task/id:k3f9a2b1` token into every panel-ticked
task line (visible in source mode, exports and every other Markdown
tool), editor-checkbox and external ticks never minted at all, and the
mis-tick scenario it guarded — duplicate task texts *plus* a shift
*plus* a tick inside that unsaved window — is vanishingly rare in a
single-user vault. What survives from the investigation: the write-back's
`resolveTaskLine` now **refuses to guess** — with duplicate task texts
and a shifted recorded line it skips the toggle (safe no-op) instead of
ticking the nearest twin, and follows a *unique* task across any shift.
Single-user vaults lose nothing; nobody's task lines carry machine
tokens.

### Milestone 43 — UI refinement: calmer chrome, Anthrazit, capture through the `/` menu ([ADR-0057](../docs/09_architecture_decisions/0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md))

Implements the "Drey UI Refinement" design mockup. **Not yet manually
verified by the owner.**

- **Chrome typography and controls (all themes).** Panel titles, tabs,
  file names, menus and the status bar are sentence-case sans; mono stays
  for code, the meta-bar path and line numbers. One global icon button
  (`.icon-btn`) and one segmented switch (`.seg`) replace the per-panel
  button styles. Bars: titlebar/tab bar 36px, meta bar 40px, status bar
  28px, rows 28px.
- **Anthrazit theme** — a second bespoke theme next to Drey (Settings →
  Appearance): warm charcoal surfaces, solid lines, a blue accent, no
  shadows. Default for a fresh install only; existing configs keep their
  theme. _(This retracts milestone 42's "no Anthrazit tokens" note.)_
- **Icon-only controls on the right-hand panels.** Search and Tasks scope
  switches (document / vault / all vaults), Search's Replace / Export /
  Summarize / Clear, the Tasks view toggles, Outline's fold-all, and the
  assistant composer's Attach / Live edit / Vault context / Prompts are
  icons with tooltips and accessible names. Placeholder texts are gone.
- **One field for text and tags** in Search and Tasks: typing `#name`
  turns into a coloured tag chip (with completion), the rest is the text
  query. The separate tag rows are removed. The summary line reads
  "N sections in M files".
- **Slash menu** — sectioned **Templates** / **Formatting**. New built-in
  **Entry** item (the configured entry format: a heading with the current
  time, caret ready for the topic) and every template from the templates
  folder, each with a **preview card** beside the list. The Templates
  panel shows the same preview on hover.
- **"Add entry" removed** — panel, drawer, draft service and the Autotag
  button's surface (the `suggestTags` backend stays, currently without a
  button). Settings → "Add entry" is now **"Entry format"**. The bottom
  dock has no default panel any more.
- **Formatting buttons in the meta bar** — the toolbar is no longer a
  separate strip; shown by default, still hidden via `⋯` → "Formatting
  toolbar". An "Unsaved" label sits beside Save.
- **Files panel** — create and rename happen **in place** in the tree (a
  new row under the target folder; the name turns into an input), file
  names stay on one line and fade out at the right edge, the open file
  carries an accent edge.
- **Calendar** — the **month/year dropdown is the panel header** (no
  "Calendar" title while expanded; collapsed it shows the title and the
  month as before), with a **Today** button beside the month arrows that
  opens today's daily note and jumps back to the current month.
- **Plugin SDK 1.10** (additive): `api.ui.icon(name, size)`, the
  `freeText` mode of `api.ui.createTagField` (+ `setText`);
  `api.ui.registerComposerContribution` is a deprecated no-op.

### Milestone 42 — the editor round: View mode, formatting toolbar, engine polish (ported from the Lariscus editor)

The Lariscus app took Drey's editor in 2026-09 and evolved it; this
milestone back-ports that evolution (only the new features — Drey's own
extras stay, no Anthrazit tokens, no attachment/link services).

- **View mode** — a third `⋯` mode next to Live Preview and Source:
  read-only rendering through the same Live Preview engine
  (`livePreview(config, { revealSelection: false })` — the selection is
  ignored, so no construct ever flips back to raw Markdown), links and
  *resolved* wikilinks open on a plain click (a read-only state has no
  caret to place; wikilink create stays the explicit Ctrl/Cmd gesture),
  the embed editing chrome (`</>`, zoom lens, resize grip) is hidden and
  task checkboxes are inert. `EditorViewMode` is
  `'live' | 'view' | 'source'`; per-doc like the other modes, the last
  choice persists as the default.
- **Formatting toolbar** (`src/app/editor/markdown-toolbar.ts` +
  the pure `toolbar-commands.ts`, both ported): heading menu (Body/H1–H3),
  list menu (bullet/numbered/task), dedicated **Task list** and
  **Blockquote** buttons, bold/italic/strikethrough, link
  (selects the `https://` placeholder), an image button (native picker →
  the same per-note `attachments/` vault chain a pasted image takes) and
  a Word-style 5×5 table grid picker. All commands are toggles where it
  makes sense and act on every line the selection touches. Rendered by
  the `MarkdownSurface` above the editor via its `toolbar` input; the
  full-page editor toggles it from the `⋯` menu ("Formatting toolbar",
  persisted in `localStorage['drey.editor']`, default off). The **entry
  drawer** shows the same toolbar in its body field, toggled by a `T`
  symbol at the tags row's right edge (own persisted value
  `entryToolbar`, also default off; the band renders as the input box's
  flush top strip). Compact one-line composers stay bare.
- **Slash dialog** (`src/app/editor/slash-commands.ts`): typing `/` at a
  line start or after whitespace opens the completion popup with the
  toolbar's block commands plus **Code block** (` ``` ` fence pair) and
  **Divider** (`---`, blank-line separated so it never parses as a
  Setext heading); picking one removes the slash and runs the same pure
  reducer the toolbar uses — one code path. Silent after a non-space
  character (URLs, paths, `and/or`, dates) and in code/frontmatter/links
  (the shared markdown-context gate); not on the Enter-submits
  composers — the entry drawer's body (multi-line, `submitOnEnter`
  off) has it.
- **Engine polish** (back-ported): a bigger, hover-revealed fold chevron
  and a dark-themed fold placeholder; the **link-target fix** —
  `[url](url)` links (what paste-link inserts) used to render empty
  because the whole Link was hidden, now only the target behind `](`
  conceals; task-checkbox clicks and the image resize grip no longer
  dispatch in a read-only state. `livePreviewConceal` /
  `livePreviewBlocks` became opts-taking factories
  (`revealSelection`), threaded through `block-render` and `conceal`.
- **Fix — req-23:** file dragstarts announced
  `effectAllowed: 'copyLink'` while the Files panel's tree rows negotiate
  `dropEffect: 'move'` — an empty intersection, so Chromium showed
  no-drop and **file drags could never move within/across vaults**
  (folder drags always worked; the spec pins the negotiation now).

### Milestone 41 — semantic vault retrieval: the assistant's Vault chip (ADR-0055)

- **The Vault chip** (assistant composer, next to Live edit): cycles
  `off → Vault (active vault) → Vault: all → off`, remembered in
  `localStorage['drey.assistant.vaultScope']`. Each ask with the chip on
  retrieves the **top-k note sections most similar to the question** from
  the scoped vault(s) and injects them into the system prompt
  (`VAULT CONTEXT` block, section text capped at 1200 chars each, cite
  paths requested). No tool calls, a small fixed context — built for
  small local models, independent of `mcp.enabled`.
- **Embeddings in-app** (`plugins/assistant/main/semantic/`):
  transformers.js **WASM-only in a worker thread** (the main process
  never blocks). The native `onnxruntime-node` and `sharp` requirements
  are satisfied by inert stub packages (`tools/stubs/*`, `file:`
  dependencies with satisfying version numbers) while the WASM backend is
  injected via `globalThis[Symbol.for('onnxruntime')]` before load —
  ADR-0023 keeps "no native modules". The ORT WASM glue + the embed
  worker are `asarUnpack`ed (dynamic `import()` cannot target asar).
  Default model `Xenova/multilingual-e5-small` (q8, 384 dims,
  multilingual — the vault content is German), configurable; e5
  `query:`/`passage:` prefixes applied automatically. One-time model
  download from the HF hub on first build, cached under `<userData>/models`.
- **Index without a database** (deliberate deviation from the roadmap's
  sqlite-vec sketch, see ADR-0055): one JSON file per vault under
  `<userData>/plugins/assistant/semantic-index/` (base64 float32 vectors,
  model id stamped, debounced atomic writes + sync flush on quit),
  brute-force cosine in JS. Section unit = the tags index's
  heading-delimited split (copied pure splitter, fence-aware); a model
  change marks an index stale (search skips it) and the next build
  re-embeds.
- **Freshness + retrieval flow**: the index rides the save-hook /
  vault-change registries like the tags index (incremental per file,
  ~30 ms per section on first build; progress via `semantic:progress`).
  Boot/enabling runs a catch-up build of un-indexed files. Retrieval
  happens main-side in the ask flow: embed the question, top-k over the
  scope, then **hydrate each hit's text fresh from the vault** — a stale
  index degrades rankings, never content.
- **Context stays small on follow-ups**: retrieved text rides only the
  current call's system prompt — never the replay. The chat note persists
  a compact ```drey-context fence (paths + headings + lines, rendered as
  a collapsible chip; a click opens the file); older turns replay it as
  one `[Vault context used …]` line. Live-edit turns ignore the scope.
  A retrieval failure degrades to no context + a quiet notice
  (`contextError`), never a failed ask.
- **Settings → "Assistant retrieval"** (plugin category, saves
  immediately): master switch, embedding model id, k (1–8, default 4),
  minimum similarity (default 0.3), per-vault index status (section
  count / stale badge / build progress) with per-vault Rebuild buttons.
- Tests: `semantic.spec.ts` (splitter, prefixes, vectors, cosine, context
  shaping), `ask-context.spec.ts` (`vaultScope` parsing incl. legacy
  payloads, `drey-context` fence roundtrip incl. hand-mangled lines,
  compact replay line), `vector-index.spec.ts` (ranking, k/threshold,
  vault isolation, staleness, JSON roundtrip, corrupt-file tolerance).

### Milestone 40 — word completion + the shared Markdown context detector

- **Word completion** (`src/app/editor/word-completion/`): a third
  completion source in the Markdown bundle next to `#tag` / `[[wikilink]]`
  — repeats the note's own words. Vocabulary = the current document,
  frequency-ranked; opens at ≥ 3 typed word characters, options capped at
  20 with `boost: -30` so tag/wikilink candidates keep precedence,
  `validFor` lets the popup re-filter synchronously while it stays open.
  The harvest runs only when a popup session opens (cache keyed on the
  `Text` object's identity), not per keystroke. As-you-type via the
  existing global `autocompletion()` from `basicSetup`; deliberately **not
  mounted on the Enter-submits composers** (assistant composer), where an
  active popup would swallow the submit-Enter.
- **Shared Markdown context detector** (`src/app/editor/markdown-context.ts`):
  one `markdownContextAt(state, pos)` answering "what is the caret in?" —
  Lezer tree first (`code-block` / `code-span` / `link` / `html` / `table`
  / `heading` — GFM table nodes included), then the constructs without a
  parser node (`frontmatter`, unclosed `[[…` → `wikilink`, trailing
  `#tag`), then a table fallback for row-shaped lines near a delimiter row
  (a table is only a `Table` node once its delimiter row exists), else
  `prose`. `inCompletableText()` is the shared completion gate.
- **Tag/wikilink completion guarded** by the detector: both sources stay
  silent inside fenced code, inline code, frontmatter, links and raw HTML
  — previously a `#` in a code block or a YAML comment opened the tag
  popup, and `[[` in code opened the wikilink popup (their decorations
  were already guarded; the popups were not). Headings, tables and
  blockquotes still complete. The two duplicated `insideCode()` tree walks
  (tag pills, wikilink decorations) moved onto the shared module's
  decoration twin — same semantics, no behavior change.
- Tests: `markdown-context.spec.ts` (detector + gate), 
  `word-completion.spec.ts` (ranking, min length, gates, cap, validFor),
  guard cases in `tag-completion.spec.ts` / `wikilink.spec.ts` (their
  mocked contexts now carry real Markdown states). No settings toggle —
  the behavior follows these fixed rules.

### Milestone 39 — the Outline panel plugin (req-28)

- The **Outline dock panel** (`plugins/outline/`, renderer-only like
  `templates/`): the open note's heading tree — every level with children
  gets a chevron to expand/collapse (per-document session state, keyed by
  stable title-chain keys so the tree keeps its shape across re-scans; a
  `fold` header toggle collapses/expands everything at once), clicking an
  entry opens the section at its heading line, and the row at the caret
  (or, inside a collapsed subtree, its nearest visible ancestor) carries
  a quiet accent highlight. Lands collapsed at the bottom of the left
  dock; movable like every panel.
- Doc scope only, and always fresh: the panel scans the focused pane's
  **live buffer** on every document event (the host's ~150 ms
  `buffer-changed` debounce) — no disk index, no stale-line resolution;
  the click target re-resolves through the row's stable key inside the
  debounce window. Scanner conventions match the tags/tasks section
  scanners (ATX-only, naive fence toggle, closing `#`s stripped) plus
  YAML frontmatter skipping, so a `# comment` in the frontmatter never
  becomes an entry (`plugins/outline/shared/outline.ts`).
- **Reveal through the tracked editor view**: `documents.open` resolves
  paths against the active vault, so for a pinned external tab
  (`external://…`, ADR-0054) or a scratch tab it could only raise an
  error banner. The plugin instead registers a document-slot
  `updateListener` (host CM modules, ADR-0044 rule 1) that tracks the
  last-focused surface's path + view; a click dispatches the caret move
  + scroll straight into that view — works for every doc shape and can
  never open a duplicate tab — and falls back to `documents.open` for
  vault docs when nothing is tracked yet. The same listener feeds the
  caret-line highlight (the document API has no selection event).
- Tests: scanner + tree builder (`plugins/outline/shared/outline.spec.ts`,
  16 cases — nesting, keys stable across line shifts, fences,
  frontmatter). Panel behaviour is manual-verification territory.

### Fix — spellcheck: suggestions for typos inside compounds

A flagged compound got an empty popup: nspell's suggest searches the
dictionary's words, and neither the typo nor its correction is one.
`compoundSuggestions` (`shared/spellcheck.ts`) rebuilds candidates from
the half the dictionary can advise on (`Krankehnhaus` → `kranken` +
`haus`), merged with plain suggestions and ranked by edit distance so
the real fix leads (`Krankenhaus` first, `Arbeitsspeicher` first).
Known limit: boundary-crossing typos without an accepted anchor half
stay suggestionless, and `Testfhal` offers `Testfahl` before `Testfall`
— closing that needs a real Hunspell engine
([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).

### Fix — spellcheck: legitimate German compounds are no longer flagged

nspell never evaluates the Hunspell `COMPOUND*` rules `dictionary-de`
declares, so every closed compound not literally listed came back
flagged (`Testfall`, `Krankenhaus`, `Arbeitsspeicher` — 20 of 22
everyday compounds in a measured sample). A rejected word now falls back
to `compoundAcceptable` (`shared/spellcheck.ts`): it counts as correct
when it decomposes into accepted parts, Fugenelemente (`Arbeit + s +
Speicher`) included. Deliberately errs towards silence — any
concatenation of valid words is accepted too
([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).

### Fix — spellcheck: the bulk check no longer computes suggestions

Measured with the real German dictionary, nspell's `correct()` costs ~5 µs
per word but `suggest()` costs **40–108 ms per misspelled word** — so the
first `spell:check` of a document (open, session restore, after every
`invalidate()`) blocked the main process for seconds. `spell:check` now
returns only the misspelled words; the popup's suggestions are fetched
lazily, one word per click, through the new `spell:suggest` IPC channel
(`suggestSpelling`), with the popup opening on a placeholder row and
filling in place. Renderer-side, `SpellcheckService` caches verdicts as
booleans plus a separate single-flighted suggestion cache
([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).

### Milestone 38 — summary streaming scroll, scratch-tab context, assistant tools across vaults

- **Stick-to-bottom while the summary streams** — the old behaviour
  snapped the `search-summary.md` tab back to the top on every 150 ms
  flush (`setContent`'s `anchor === 0 → scrollTop = 0` branch; the
  scratch tab's caret stays at 0 because nobody clicks into it).
  `setContent` now measures the pin state (≤ 32 px from the bottom)
  before the in-place swap and restores it after: the view follows the
  growing text by default, stays put while the user has scrolled up, and
  resumes following when they return to the bottom. The same rule now
  covers live-edit pushes and re-run summaries; fresh opens still start
  at the top (`loadDocument`).
- **The search summary as assistant context** — the composer's **+**
  picker lists **unsaved scratch tabs** (saved-empty + dirty text docs,
  e.g. `search-summary.md`) above the vault files, labelled "unsaved
  tab". A scratch chip rides as the tab's live buffer; each send
  snapshots the current text to `.drafts/assistant/<vaultId>-<name>.md`
  (hidden scratch area, invisible to tree/index) and that vault path is
  what the turn cites — so follow-up replays re-read it like any
  attachment and the context survives the tab being closed. Attaching
  the focused tab folds into the note chip instead of doubling; files +
  scratch tabs share the 10-chip cap.
- **Assistant vault tools across vaults** (ADR-0051 follow-up) —
  `vault_read`/`vault_write` grew the `vault` argument (id, default
  active; `"all"` is rejected with a clear error), cross-vault writes
  name the vault in the confirmation dialog (`vaultId`/`vaultName` ride
  the existing bridge payload), cross-vault `vault_search` hits are
  labelled `vaultId:path`, and the tools note in the system prompt lists
  the registered vaults (id + name) — until now the model had no way to
  learn vault ids, making even `vault_search`'s `vault`/`"all"` support
  unreachable in practice.
- Tests: scratch-chip send/snapshot/replay flows
  (`plugin-assistant-state.spec.ts`), the vault-argument threading +
  hit labels (`mcp-vault-tools.spec.ts`). Runtime view §6.43 updated;
  ADR-0051's tools bullet resolved.

### Milestone 37 — search summarise: an LLM topic digest from the search results

- **"Summarize" in the Search panel** — next to Export (same visibility:
  visible once a search has hits; it appears only when an LLM is
  configured in Settings → LLM, disabled-state tooltip otherwise). Works
  in every scope (File / Vault / All), including unsaved-buffer hits.
- **How it runs** — the tags plugin's renderer passes its current hit set
  to a new plugin-side `summarise` backend; main loads the **editable**
  `builtin:search-summary` Action template from app config (reworded to a
  comprehensive topic digest: thematic blocks with bold lead-ins, key
  facts, an "Open questions / contradictions" paragraph, path citations,
  in the notes' language — stored-but-never-edited copies refresh to the
  new default), packs the whole matching sections up to a ~60 000
  character budget (`buildSearchSummaryMaterial`, cuts at a whole-section
  boundary and says so), and runs one `ctx.llm.chat` call.
- **Streaming + cancellation** — deltas stream out-of-band (plugin
  `summary:delta` event, ADR-0014/0047 contract: non-streaming providers
  deliver once) into a new unsaved `search-summary.md` scratch tab
  (throttled buffer flushes; the panel header shows "summarizing…"); the
  button becomes **Stop** (`llm:cancel` → the same abort registry as
  chat/OCR). Completed, cancelled and failed runs all leave the partial
  digest in the tab; errors also surface in the panel. Save-as keeps the
  digest as a note.
- Tests: `buildSearchSummaryMaterial` / `formatSearchSummaryHeader` /
  `describeSearchQuery` in `plugins/tags/shared/search.spec.ts`. The
  plugin specs never actually ran (`ng test` ignores the
  `plugins/**/*.spec.ts` entry in angular.json) — they now run via
  `npm run test:plugins` (root `vitest.plugins.config.mts`), and their
  stale never-executed expectations were repaired to the shipped
  behavior (1-based inclusive replace ranges, literal regex replacement —
  no `$1` refs, V8 regex error wording, extensionless `{{title}}`).
- ADR: [0017](../docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md)
  (digest section), runtime view §6.43. No new ADR — the feature follows
  ADR-0044 (feature logic in the plugin), ADR-0047 (base transport) and
  ADR-0014 (cancel, no timeout) as-is.

### Milestone 36 — Drey as an Explorer "Open with" / default program for Markdown and text

- **File associations** — the NSIS installer registers `.md`, `.markdown`,
  `.mdx` and `.txt` (per-user, `fileAssociations` in
  `electron-builder.yml`); Drey shows up under "Open with" and can be made
  the default ("Always use this app"). The portable build registers nothing.
  Caveat: with no explicit user choice a `.txt` starts opening in Drey.
- **A launched file opens in the running app** — the launch argv (cold
  start) or `second-instance` (Drey already open, same window) is filtered
  to existing md/markdown/mdx/txt files. Inside a registered vault → an
  ordinary vault tab. **Outside every vault → a pinned external tab**
  (`external://<path>`, marked "Outside your vaults"): edited normally and
  **Ctrl+S saves back to the original location** (file's own line endings
  kept; no vault pipeline — no frontmatter bump, index or on-save Actions);
  never replaced by the next file, no unpin. "Save as…" still copies it
  into the active vault. External tabs are not restored after a restart.
- **Safety** — main keeps a read/write allowlist of the paths it collected
  from the OS itself (plus extension + 10 MB gate; a write needs the file to
  still exist), so the renderer can neither read nor write arbitrary files. Cold start is a renderer *pull* after session restore
  (a push would race startup); later launches are a push. A launch that
  opened a file skips the startup daily-note fallback.
- Dev: `npm run electron -- C:\path\x.md` forwards arguments.
- ADR: [0054](../docs/09_architecture_decisions/0054-opening-files-from-the-os.md).
  Deferred: PDF/image/code associations, restoring external tabs, live
  reload of a changed external file, drag-in of out-of-vault files.

### Milestone 35 — pinned tabs + a Save / Don't save / Cancel prompt on tab close

- **Pin a tab** — tab context menu → "Pin tab" / "Unpin tab" (text, image
  and pdf tabs; a pin glyph shows on the tab). A pinned tab is never the
  tab that milestone 32's clean-tab replacement closes: the next file
  (Files panel, calendar day, wikilink, search hit) opens in a **new tab
  beside it**. When the pinned tab is the *active* one, the replacement
  goes to the pane's clean **unpinned** tab instead (rightmost one), so
  browsing from a pinned reference note reuses one "preview" tab rather
  than piling up new ones; with no such tab (only pinned or dirty ones
  left) the file opens beside. The pin survives Save-as, renames/moves and a restart
  (`pinned` on the session snapshot's tab). Closing a pinned tab, "Close
  others" and "Close all" are unchanged — a pin only steers replacement.
- **Closing a dirty tab asks Save / Don't save / Cancel** (was a two-button
  "Discard unsaved changes?"). "Save" writes the buffer and closes only if
  nothing is left unsaved — a failed write or a cancelled Save-As dialog
  (a never-saved untitled tab) keeps the tab open; Escape / backdrop count
  as Cancel. New `ConfirmDialogService.decide()` (a third button on the
  shared dialog); `EditorService.saveAs()` now resolves to the key of the
  saved tab so the swapped-in tab can be closed too. The **app-exit**
  prompt (bug-5, Save all / Exit without saving / Cancel) was already
  three-way and is unchanged.

### Milestone 34 — tasks across vaults (M-B complete) + the editor's undo fix

The two leftovers from the tag-system round: the last M-B item (tasks
per-vault + "all vaults") and the editor defect discovered while testing
milestone 33's replace flow.

- **Tasks: per-vault index + all-vaults scope (M-B complete)** — the
  tasks plugin mirrors the tags plugin's milestone-33 shape: one task
  index per registered vault (the mirror-the-active-vault boot guard is
  gone), every record stamped with its `vaultId`, and the panel's scope
  switch grows a third segment — **Doc | Vault | All**. Vault scope
  filters the main-side list to the registry's active vault at pull
  time; the All scope groups per file with a vault-name badge (the
  active vault stays unbadged, like the Search panel). Row toggles and
  row clicks carry the vault: a closed file's toggle writes through
  `readFile`/`writeFile { vaultId }`, an open tab is reached by the
  bare path (active vault first, then a unique open match — the
  `resolveDoc` semantics the Search panel rides). The unsaved-buffer
  fold keys on `(vaultId, path)`, so two vaults holding the same
  relative path no longer clobber each other's rows. With this,
  milestone 28's announced M-B follow-up is fully shipped.
- **Editor: undo can no longer wipe a freshly opened tab** — a first
  load and every tab switch now build a fresh CodeMirror state
  (`MarkdownSurface.loadDocument`, compartment contents carried over via
  `Compartment.get`): the document sits in the state's own doc instead
  of being dispatched in, so the load is not an undo event and every
  tab starts with an empty undo stack. Previously the load was a
  dispatched full-range change sitting at the bottom of the history — a
  second `Ctrl+Z` in a freshly opened tab rolled the LOAD back and
  wiped the document (found while testing milestone 33), and undoing
  across a tab switch could resurrect the *previous* tab's content.
  In-place reloads of the same tab (save pipeline, watcher, live-edit
  buffer pushes per ADR-0049) deliberately stay undoable dispatches;
  the entry drawer's capture box keeps its behavior. The code now
  matches what the Editor's header already documented: "undo history
  does not survive a tab switch" (ADR-0037).

### Milestone 33 — tag system round: prefix colors, central tag completion, search fix + redesign (M-B core)

The tag/search batch: four owner-reported items — configurable tag
prefixes with colors, tag completion as a central component, the broken
text search, and a VS Code-style search redesign — landed as one
coherent evolution of the tag system (ADR-0017 "Later change"; the
multi-vault halves of the announced M-B follow-up ship here).

- **Search fixed at the root** — the index skipped every section
  without an inline `#tag`, so text search *never* found untagged
  notes ("tags work, text doesn't"). The index now covers every
  heading-delimited section; tag-only queries behave exactly as
  before. Errors surface in the panel instead of silently emptying it
  (a missing provider, a broken regex), and `Mod+Shift+F` focuses the
  search field.
- **Per-vault indexes + search scopes (M-B core)** — one tag index per
  registered vault; the SDK's `scope` parameter is honoured at last
  (`{ kind: 'vault' }` / `{ kind: 'all' }`, omitted = the active vault
  resolved at call time — the old boot-race guard is gone). The Search
  panel gets a **File | Vault | All** scope switch, hits carry
  `vaultId` (clicks open the right file in cross-vault results, and
  unsaved-buffer folds key on `(vaultId, path)`), and MCP
  `vault_search` gains an optional `vault` argument (`"all"` or a
  vault id; the regex-only scan follows it). Tasks stay single-vault —
  the remaining M-B item.
- **Search redesign** — the panel (flush layout: inputs pinned, one
  scrolling results list, everything top-left) grows the mockup's
  search row with **Aa** (match case) / **ab** (whole word) / **.\***
  (regex) toggles and a collapsible **replace row**; the tag chips
  remain AND-combinable; results group **per file** (collapsible,
  match counts, vault badge in the all-vaults scope, per-hit replace).
  Scope + toggles persist (`localStorage['drey.search']`). A broken
  regex shows its compile error inline and disables nothing else.
- **Replace with section semantics** — file scope patches the open
  buffer (a normal undoable edit); vault/all scope collects per-file
  patches and shows **one bundled confirmation** (per-file expandable
  diffs) before applying via announced writes. Every file is re-read
  and re-matched right before its write (TOCTOU), CRLF is preserved,
  and only occurrences inside the matching sections change.
- **Tag prefix colors** — Settings → **Tags** (a Tags-plugin page) maps
  `/`-namespaces to colors (`proj` colors `#proj/alpha`; the longest
  prefix wins). Unconfigured tags get a deterministic auto color keyed
  on the first segment from a curated dark-theme palette. The provider
  serves prefix styles; base resolves colors — editor pills, entry
  drawer chips, panel chips and completion options recolor **live**
  (no restart). Stored per-plugin (`plugins/tags/config.json`).
- **Central tag completion (the plugin stays the data owner)** — tag
  pills and `#tag` completion moved from the Tags plugin into base
  (`src/app/editor/tags/`, fed by a base `TagVocabularyService` over a
  new `search:vocabulary` route + `search:changed` push), and a shared
  plain-DOM **tag field** (colored chips + completion dropdown) is
  mounted by the entry drawer and handed to plugins as
  `api.ui.createTagField` — the Tasks filter and the Search panel
  dropped their hand-rolled, completion-less chip rows for it.
  `commands.run(id, payload?)` carries the pill-click handoff
  (`search.open` with `{ tag }`).
- **SDK 1.9 (additive)** — `commands.run` payload,
  `ui.createTagField`, `ctx.search.notifyChanged`,
  `SectionSearchProvider.styles?`, `TagSearchQuery.match?`,
  `TagPrefixStyle`, `TagEntry.color?`. The tag grammar moved to
  `shared/tag-grammar.ts` (plugin-local twins + parity spec — plugin
  renderers cannot load values over `plugin://`); the dead
  `tags:list`/`tags:search` channels are gone. Two pre-existing lint
  errors in `editor-context-menu` (barrel imports from the req-33/34
  commit) fixed in passing.

### Milestone 32 — beta-feedback batch II: daily folder, tab replacement, mermaid export, plugin settings

The second cut from the beta-testing feedback list (five items; the
native-dialog focus fix landed the same week and is recorded as the
bug-6 follow-up below).

- **Configurable daily-note folder** — Settings → Daily notes gains
  "Storage folder" (`daily.dir`, default `daily/`), mirroring
  `templates.dir` exactly: app-level config (ADR-0010), applied to all
  vaults equally; per-vault overlays stay with ADR-0051's announced
  follow-up. Only the root is configurable — year/month nesting and the
  `YYYY-MM-DD.md` name stay fixed (they are the calendar's matching
  grammar). Reads and writes use **only** the configured folder (exact
  `templates.dir` semantics): legacy flat `<dir>/<date>.md` files stay
  readable inside it, an old `daily/` root is never read again once the
  setting changes, and no files are moved. `dailyPathFor`/
  `dailyDateFromPath` take the dir (regex metacharacters escaped, so a
  root like `My.Notes` can't act as a wildcard), and the calendar finds
  note days by walking the whole file tree instead of assuming a
  top-level `daily` folder.
- **Opening a file replaces the focused clean tab** (ADR-0003
  amendment) — clicking a file row or a calendar day reuses the focused
  pane's *clean* tab instead of stacking a new one; a dirty tab stays
  and the new file opens alongside. Plugin doc kinds and the
  already-open reveal path are excluded, and internal flows (session
  restore, `saveAs`, multi-select open) pass `keepFocused`.
- **Mermaid diagrams render in the PDF export** — ADR-0052's scope cut
  is reopened and closed: the hidden export window (already a Chromium
  renderer) inlines the bundled mermaid build and renders ```mermaid
  fences to SVG before `printToPDF` — light theme on purpose (the PDF
  leaves the vault's dark editor), a parse error or the 20 s
  per-diagram cap falls back to the plain code block, a failed bundle
  read exports without diagrams. The runtime is embedded only when the
  note actually contains a mermaid fence, and note markup cannot reach
  the script layer (the HTML strips run first).
- **Editor/PDF parity is a standing rule** — recorded in this file's
  preamble, checklist in docs/06 §6.39: when the editor gains a new
  rendered element it must carry into the export in the same change, or
  its absence there is an explicit decision (current: `[[wikilinks]]`
  stay literal; `![[x.pdf]]` embeds print a visible "not printable" note
  instead of an empty frame — an `<img>` cannot rasterize a PDF; the M31
  gap closed with this milestone's wrap-up).
- **Plugin Settings pages share the core form vocabulary** — a shared
  stylesheet scoped under `.plugin-settings-body`
  (`src/app/plugin-host/plugin-settings.css`, mirroring the Settings
  panes' `settings-forms.css`) replaces the three built-in plugins'
  bespoke settings styling (the assistant's Actions page, templates,
  sample), so a plugin page reads like a built-in category and follows
  the app-wide type size; `plugins/AUTHORING.md` is the practical
  author guide (layout & build, the manifest's `apiVersion` gate, the
  CSS prefix/tokens/rem rules, the vocabulary table, the testing
  convention).

### Milestone 31 — beta-feedback batch I: fixes + small features

The first milestone cut from the beta-testing feedback list (triaged
against the codebase; several items turned out already fixed or
by-design — chat/document binding (M29), `.md`-only tag scanning,
PDF-export image resolution — and the rest split into this batch and an
M32 feature batch).

- **Startup performance** — the tags and tasks indexes no longer block
  activation on a full-vault scan: the window appears first, the boot
  build runs once in the background (the old code scanned the vault
  twice — once awaited, once via the refresh round), and each finished
  sweep pushes `index-updated` over the plugin bridge so the Search panel
  and `#tag` autocomplete populate as soon as the index is ready. This
  also fixes the "tag autocomplete fails on some machines" report: the
  renderer's one-shot vocabulary pull used to swallow errors with no
  retry. Rebuilds coalesce (`requestRebuild`) so watcher bursts and the
  refresh round can never interleave sweeps. Both plugins now walk via
  the new `ctx.vault.listMarkdownFiles` (SDK minor 7) instead of
  filtering the full tree.
- **Ask protocol rework (ADR-0053)** — answers stream as **plain prose**
  (the old "reply ONLY with JSON" envelope accumulated as raw JSON on
  screen), and an edit arrives as the complete document inside a
  four-backtick `document` fence (inner ``` fences survive; longest body
  wins, ties last; a lone ```markdown block heals). No fence → the reply
  IS the answer — a truncated or disobeyed reply can no longer degrade
  into a raw-JSON answer card. Live edit (ADR-0049) and chat replay are
  untouched.
- **LLM "no response"** — providers now throw a clean `bad-reply` (with
  detail) instead of returning empty text when the model never spoke and
  no tool ran, and a non-JSON 200 body surfaces as an error excerpt
  instead of a leaked `SyntaxError`; the chat engine fails a
  tools-ran-but-empty turn with the question kept for a re-send.
- **`![[image]]` / `![[pdf]]` embeds** — Obsidian-style media embeds
  render in both editor modes with the same widgets and reveal mirror as
  `![](path)` (ADR-0046 addendum); note targets still link, never
  transclude. The image candidate chain is single-sourced in
  `shared/asset-refs.ts` — note-relative, vault root, then the
  `attachments/` folders for a bare name — shared by the editor, the PDF
  export, and the export's `rewriteEmbedWikilinks`; the chain also
  decodes percent-encoded destinations, fixing PDF export of file names
  with spaces.
- **Heading hierarchy** — per-level heading typography (all six levels
  distinguishable) lives outside the theme compartment, so every
  published theme keeps it (they style headings identically or not at
  all — the "indistinguishable headings" report); theme colours still
  apply. Even on Drey, h4–h6 are now distinct.
- **Files panel** — folders start **collapsed** each session (a big
  vault no longer opens as a wall of expanded trees); the header button
  toggles Expand all / Collapse all; opening a tab auto-expands the
  active file's ancestors so the row is visible. Row context menus gain
  **Reveal in File Explorer** and **Open in Terminal** (typed IPC
  `vault:reveal-path` / `vault:open-in-terminal`; Windows opens `cmd /K`
  in the folder, macOS Terminal, Linux best effort).
- **Generic file drop** — an OS file that no cascade branch claims is
  staged name-preserving into `attachments/` and inserted as a Markdown
  link (100 MB cap, extension-less files refused) — the drop used to be
  swallowed silently.
- **`created` datetime** — new notes, daily notes and chat notes store
  `created` as date+time (`YYYY-MM-DDTHH:mm:ss`); legacy date-only values
  in existing files remain valid and are never rewritten.
  `specs/frontmatter-schema.md` updated.
- **Assistant catch-up** — switching documents while a generation runs
  now re-follows the new document's chat when the generation finishes
  (the switch used to be lost until the next tab switch).
- Stale "(milestone 26)" notes on the not-yet-wired Copilot presets now
  point at `specs/roadmap.md`.

### Milestone 30 — PDF embeds + a PDF viewer tab (Req-2 PDF slice, ADR-0052)

Dragging a PDF into a note now **reads it where you are** instead of
silently swallowing the drop, and a `.pdf` in the vault opens as a
viewer tab instead of a mojibake text buffer (that buffer's Ctrl+S
writing binary garbage was a real hazard — gone).

- **Drop / paste** — a PDF staged into the note's `attachments/` keeps
  its **original file name** (`Quarterly Report.pdf`, `-2` on a
  collision — a documented deviation from ADR-0024's hash naming: PDFs
  are browsable documents, not paste artifacts) and inserts
  `![Quarterly Report.pdf](attachments/…)`. Blank-MIME Explorer drops
  work by extension, like images; images still win mixed drops;
  clipboard paste works too; a Files-panel drag links in place without
  copying.
- **Inline embed** — the `![](…)` line renders as a Live Preview block
  widget over Chromium's **built-in (PDFium) viewer** (`plugins: true`
  on the main window; no bundled PDF library). The familiar Req-1
  affordances: `</>` reveals the raw line in the rounded container with
  a read-only viewer mirror kept below, the lens opens the **full PDF
  tab**, a dead reference shows a compact `PDF not found: …` box whose
  click drops the caret into the source. The `drey-asset` protocol pins
  `application/pdf` for `.pdf` paths so the viewer accepts the frame.
- **`kind: 'pdf'` tab** — the third base doc kind beside `'text'` and
  `'image'`: no buffer, never dirty, session-restored, opened from the
  Files panel, plain links (Ctrl+click), the embed lens and the pane
  drop. Tab strip and status bar treat it as a base kind.
- Precedence of the drop cascade is now image > PDF > text; `|WxH`
  size suffixes on PDF embeds are parsed but ignored (a page viewer's
  width is the column).

### Milestone 29 — UX batch: icon buttons, tooltips, assistant overhaul, capture fix

Seven owner requests in one pass:

- **Editor meta bar**: the Lines and Save controls are icon-only buttons
  (state stays visible via the on/dirty tints and the title/aria-label
  "Saving…"/"Save"/"Saved"); a Lucide `save` glyph joined the icon map.
- **Files panel**: hovering a file or folder row shows its absolute path
  (vault root + relative path, separator matched to the root).
- **Assistant**: the transcript auto-follows the streamed answer
  (stick-to-bottom, scrolling up unpins); "+ New chat" is an icon button;
  the automatic summary is **removed entirely** (ADR-0012 superseded — no
  summary card/switch/IPC/`note-summary` template/Assistant settings
  page; stale `builtin:note-summary` entries in existing configs are
  dropped, old `.chat.json` sidecars stay on disk untouched); in its place
  a **Prompts picker** reads `templates/prompts/*.md` (`# Titel` /
  `> Beschreibung` / body) and inserts the body into the composer.
- **Chats bind to the active document**: a chat note's `note:` frontmatter
  records the doc key it was started under; switching tabs opens that
  document's newest chat (a non-note focus shows a fresh chat), while the
  picker and "+ New chat" keep manual chats possible.
- **Bug fix — files no longer modified on open**: the editor's per-id
  request signals (quick-capture entry, assistant insert, reveal-at-line)
  were deduplicated per component instance, so every freshly mounted
  editor re-applied the last pending request — one quick capture earlier
  in the session gave *every* later-opened file a `## HH:mm` entry.
  Consumption is now claimed once, globally, in `EditorCommandsService`.

### Milestone 28 — multi-vault registry (ADR-0051)

The app knows **several vaults at once**: the Files panel shows one
section per registered vault (the old vault header row, stacked — name,
active marker, fold chevron) with the documents under each, plus
**"Add vault …"** in the panel header, the empty state and the vault
row's context menu (**Set active / Rename… / Add vault… / Open in File
Explorer / Remove…** — registry-only removal, the folder stays on disk,
open tabs close first with the usual dirty prompts). `<userData>/vault-config.json`
became **version 2**: `{ vaults: [{id, name, path}], activeVaultId }` with a
one-time v1 migration; ids are minted (`v` + hex) and stable across folder
moves, display names are editable. **One vault stays active** — daily
notes, quick capture, the Add entry drawer, chats, calendar and
scratch-tab Save-as keep targeting it.

Files from **any** vault open and edit side by side: a document's tab
identity is now `vaultId::relativePath` (`OpenDoc.vaultId` + `key`), so
the same-named note in two vaults is two independent tabs; pane tabs,
tab drag, the session snapshot (v2, per-tab `vaultId`; a tab whose vault
was removed since is dropped; v1 snapshots still restore) and the
Files panel's selection/drag state all key on it. **Drag & drop now also
moves entries across vaults** (copy + delete in main, EXDEV-safe, the
assistant sidecar travels along; tabs re-target; both indexes rebuild).
`drey-asset://` URLs carry the vault (`drey-asset://<vaultId>/asset/<path>`),
wikilinks resolve and create within the linking note's vault, and Save-as
roots at the tab's own vault.

Every `vault:*` IPC method gained an optional trailing `vaultId`
(default: active); new registry channels `vault:list/add/remove/
rename-vault/set-active/reveal-folder` replace `vault:select`. Registry
mutations run the full all-vaults refresh round — which also fixes the
old gap where a vault switch never pushed `vault:changed` to the
renderer. The watcher (opt-in) now watches **every registered vault**
(one chokidar per vault, reconciled on registry changes; per-vault
announce batches), the own-write ledger keys are vault-scoped, and the
`ctx.vault` plugin facade gained `{vaultId}` options + `listVaults()`
(`PLUGIN_API_VERSION` minor → 6). Tags/tasks indexes stay single-vault
(the active one, guarded against foreign saves) — search scopes
(document / this vault / all vaults), MCP `vault` arguments and per-vault
indexes are the announced follow-up.

### Milestone 27 — OCR via the vision LLM (req-9 desktop half, ADR-0050)

Right-click an image → **"Recognize text"**: the new `ocr` runtime plugin
transcribes it through the **connected vision-capable LLM**
([ADR-0050](../docs/09_architecture_decisions/0050-ocr-via-vision-llm.md) —
a deliberate deviation from req-9's Apple-Vision/Tesseract sketch; VLMs
read handwriting far better and the ADR-0047 transport already existed).
Two surfaces: an **embedded image in a note** (Live Preview widget or the
raw `![…](…)` line — the widget's `drey-asset://` src reverse-maps, the
line regex covers source mode) gets its transcription spliced **below the
image line** through the shared confirmation diff (ADR-0011; confirm
applies and saves); an **image tab** (`kind: 'image'`, right-click there
previously produced no menu at all) gets an unsaved scratch tab
`<image-basename>.md`. While the model streams, a small modal shows the
partial transcription, an elapsed clock and **Cancel** (ADR-0014; the
main-side call rides the renderer-minted `taskId`), and errors render in
the same modal. The row shows on every resolvable image — **enabled** when
the active provider declares `imageAttachments`, **grayed out**
otherwise (never gated on provider ids; a not-loaded plugin contributes
no row). Base grew three feature-agnostic surfaces: the context-menu seam's
provider callback now receives the click target
(`EditorContextMenuTarget`: pane doc path + line, or image-tab path —
the entry drawer's and plugin composers' surfaces carry no doc path), the
renderer menu also opens on image tabs (clipboard rows suppressed), and
every app-config write re-pushes the active provider's capabilities
(`llm:capabilities-changed` via a new `AppConfigStore.onChange`), so the
row flips enabled/disabled on a Settings save without a restart. Two
menu-hygiene rules rode along: `ContextMenuItem.disabled` (grayed,
unclickable) and **a menu with zero rows never opens** (an image tab
without plugin items stays menu-less; a throwing plugin provider is
skipped instead of blanking the menu). The SDK gained
`MainChatOptions.maxOutputTokens` and `api.llm.onCapabilitiesChanged`;
`PLUGIN_API_VERSION` minor → 5. The verbatim-transcription prompt lives
in the plugin (`specs/classifier-spec.md` → "Prompt 3").

Found during manual verification, fixed with it: **embedded images that
reference a vault-relative path never rendered** — assistant chat notes
embed their attachment lines with the `vault:saveAsset` result verbatim
(vault-relative), but image references resolve note-relative, so every
chat-note image showed the `image not found` placeholder (which, for an
empty alt, read as the misleading "no alt text"). Image embeds now walk
**two candidates** on load errors — note-relative first (unchanged
semantics), then the same target read from the vault root — which heals
chat notes and any note moved between folders without touching note
data; the reveal mirror walks them too, and the placeholder now names
the **reference as written** instead of the alt text. The OCR plugin's
line-regex target resolution mirrors the same candidates (picked against
the live vault file list).

### Milestone 26 — live edit mode (Req-32, ADR-0049)

The composer gained a **"Live edit" toggle chip**: for one opted-in ask
turn the model edits the open note **directly and immediately** — no
confirmation dialog, a deliberate per-turn exception to ADR-0011. It
edits through the new `doc_*` tools over the provider tool loop:
**`doc_apply_diff`** carries one or more atomic `{find, replace}` hunks
(each `find` must match exactly once, else nothing applies and the error
names the failing hunk), **`doc_write`** replaces whole documents,
**`doc_read`** verifies with numbered line windows — so large notes are
never rewritten wholesale. A main-side working copy seeds from the live
buffer; every mutating call pushes the whole copy through a new
`chat:liveEdit` plugin event and lands via `documents.setBuffer` as ONE
undo step (Ctrl+Z walks the turn back push by push, Ctrl+S saves —
req-25 unchanged). While the model works, the document is **locked for
user input** ("Assistant is editing…" in the meta bar) — an
`EditorView.editable` compartment, deliberately not `EditorState.readOnly`,
so the model's own pushes keep flowing; the lock releases on success,
error and cancel alike. The applied document persists into the chat
note's `edit` fence entry, so ADR-0048 replay works unchanged. Base
seams: `MainChatOptions.tools`/`onToolCall`/`maxToolRounds` (the
plugin-host facade merges plugin tools with the vault set; the vault
tools stay confirm-gated) and `api.documents.setEditLock`;
`PLUGIN_API_VERSION` minor → 4. Providers without tool support (the CLI
providers) fail with a visible error before anything is persisted.

### Milestone 25 — chats as vault notes (Req-30, resolves bug-10(b))

Conversations with the assistant became **standalone Markdown notes**
under `chats/<yyyy>/<mm>/<yyyy-mm-dd>-<slug>.md`
([ADR-0048](../docs/09_architecture_decisions/0048-chats-as-vault-notes.md),
superseding ADR-0012's per-note sidecars for conversations — the sidecar
stays for the automatic summary). The note is the conversation's source
of truth: one `## User`/`## Assistant` heading per turn with a `drey-tool`
fence persisting every tool call/result and every applied edit **in
full**, so a follow-up **replays the whole persisted history** (or
resumes a Claude Code session via `--resume`) — the ~12-message cap and
the lost-context defect are gone. Chat notes are **auto-saved and
prompt-free**: an open tab follows the disk (an engine append reloads it
even when the tab has unsaved typing), hand edits persist after a short
idle, and dirty temp files (scratch tabs, `.drafts/`) are committed
silently at exit — the save-before-exit prompt stays reserved for the
user's own notes. `kind: chat` is the first new
app-understood frontmatter field; `chats/` is indexed like `daily/`, and
plugin chat-note writes run the same announce round as MCP writes
(new `ctx.vault.writeAnnounced`) so the tree, index and open tabs stay
live. The assistant panel went **chat-first** (picker + new chat, turn
cards with collapsible tool chips, streamed partial answers through the
plugin's own `chat:delta` event, zero-context standalone chats,
restart-from-here over note turns, one-shot non-destructive sidecar
import), the composer grew **image chips** (vault picker or paste/drop
staged via the new `api.vault.saveAsset`, sent as vision parts when the
provider has the capability), and the SDK gained additive surfaces
(`MainChatOptions.attachments`, `ctx.llm.capabilities()`,
`api.llm.capabilities()`, `LlmChatResult.toolTrace`;
`PLUGIN_API_VERSION` minor → 2).

### Milestone 24 — assistant composer rework

The Claude-Code-style composer in the assistant panel: a **model row** that
edits the one global `llm.model` through the new `api.llm.listModels()`
facade (provider label + listing capability + best-effort list; hand-entry
always available, `PLUGIN_API_VERSION` minor → 1), **context chips** (the
open note attached by default and deselectable; extra vault files via
`@`-completion or the "+" picker, read at send time as live buffer/vault
content, capped per file), and an **auto-growing composer** (content height
up to a cap, then it scrolls inside; the drag divider and its persisted
height pref are gone). The ask payload became
`{ question, note | null, extraFiles, history }`
(`plugins/assistant/shared/ask.ts` — `note: null` turns the turn
answer-only via a second system prompt). Plus a global
`::-webkit-scrollbar-corner` fix (styling any scrollbar part switches
Chromium to custom painting, and the unstyled corner rendered solid white)
and a templates-picker modal selector fix in passing.

### Milestone 23 — Claude Code CLI provider + visible ask-history validation

The **Claude Code CLI provider** joined the req-29 abstraction
(`electron/llm/providers/claude-code-cli.ts` on `cli-base.ts`):
`claude -p` headless with stream-json output and provider-side session
continuation via `--resume` (`sessionRef`), opt-in and off by default
(ADR-0047). **bug-10(a)** fixed in the same pass: the ask handler validates
the `history` IPC payload and fails visibly instead of silently degrading
to no context, and the renderer always sends an array.

### Milestone 22 — LLM provider abstraction (Req-29 core, ADR-0047)

One provider-neutral `LlmClient` interface with a per-call `LlmRouter`
over `electron/llm/providers/`: the **local OpenAI-compatible** provider
(LM Studio / Ollama / vLLM / llama.cpp / Unsloth, optional bearer key)
plus hosted presets (**OpenRouter**, **Anthropic API**, **Z.ai GLM** —
opt-in, off by default) on one OpenAI-compat client, and an
**Anthropic-Messages** client. Streaming (`onDelta`), provider-side
session continuation (`sessionRef`), a capability descriptor
(tools / streaming / sessions / model listing / image attachments) and a
canonical `ToolSpec` so MCP tools are provider-neutral. No hardcoded model
id — the model stays hand-enterable; `copilot-cli` / `copilot-web` remain
unrouted until their milestones land (see roadmap).

---

## Requirements & fixes

Moved here from the roadmap's former "Completed" chapter.

req-33 — Settings categories in a predictable order. The core
categories read alphabetically ("Add entry", "Appearance", "Daily
notes", "LLM", "MCP", "Panels & plugins", "Spelling", "Vault"), plugin
pages follow sorted by their label, and "About" stays last. This also
fixes real drift: a plugin page actually rendered *after* "About"
(registration order put it behind the last core category) while the
docs claimed "before". The order is pinned by
`settings-registry.service.spec.ts`.

req-34 — context menus reviewed: typical order, separators, keyboard
hints. The editor's right-click menu now reads as three groups —
clipboard (Cut / Copy / Paste / Select all, with their `Ctrl` hints),
base rows, plugin rows — and the base's "Export as PDF…" row can no
longer land below the templates rows (registration order used to
decide, and plugins activate before App's bootstrap, so it did).
`EditorContextMenuRegistry` gained a `{ head: true }` ordering hint
instead of a privileged path (ADR-0030 "Later change"): same registry,
same item shape — base group first, the templates rows last, as
required. The `⋯` menu shows the Save-as chord, the tab menu shows the
split chords, and the Files panel's file menu groups copy/paste before
duplicate/export and reveal/terminal/rename, with delete last as
before.

Plugin-modal click fix — `ui.showModal`'s backdrop dismissed on **every**
mousedown, and the modal box is the backdrop's child, so pressing any
dead spot inside a picker (the "Attach" label, tab-row padding, the gap
between rows) tore the overlay down mid-press; because that happens
before the browser synthesizes `click`, row presses were swallowed too
and the press landed in the app behind — reading as "the modal is
click-transparent". The backdrop now dismisses only when the press lands
on the backdrop itself (affects the assistant's three pickers and the
templates picker alike).

External files as chat context — the assistant's `+` picker gained
"Add a file from this computer …" (native multi-select) and the
composer's paste/drop now routes by extension instead of images-only:
images stage hash-named via `saveAsset` (ADR-0024), text files copy
name-preserving and uniqued (`report-2.md`) into `attachments/` beside
the reference note (active chat, else the open note, else `chats/`),
everything else is skipped with a notice. Staged copies are ordinary
vault files — the chat note's attachment links resolve and replays
re-read them like any other attachment (ADR-0048 paths-not-bodies).
`ctx.vault.saveAsset` joined the plugin SDK (`PLUGIN_API_VERSION` minor
→ 3).

req-20 — `[[wikilinks]]`
([ADR-0046](../docs/09_architecture_decisions/0046-wikilinks.md)):
`[[target]]`, `[[target#heading]]`, `[[target|alias]]`,
`[[target#heading|alias]]` and same-file `[[#heading]]` render as internal
links in Live Preview *and* source mode (accent; unresolved targets muted
with a dotted underline); Live Preview conceals the brackets — with an
alias, everything but the alias. `Ctrl`/`Cmd`-click resolves by
vault-relative path (`.md` appended, case-insensitive) or note basename
(ambiguous → the linking note's folder first, then the shortest path) and
opens the note at the `#heading` anchor's line (open buffer first).
Ctrl-clicking an unresolved link **creates** the note (parents
auto-created) and opens it. Typing after `[[` autocompletes note names
(basename when unique, else the extension-less path). The "Add entry"
drawer renders, completes and follows wikilinks but never creates files.
Built as a base module `src/app/editor/wikilinks/` — regex mark
decorations + completion over the file-tree-derived index, no Lezer node
(the tag-pill route); the conceal layer and `link-open` skip spans the
regex claimed.

req-23 — drag & drop of files **and folders** within the Files panel
(HTML5 DnD,
[ADR-0039](../docs/09_architecture_decisions/0039-drag-and-drop-chrome.md)
"Later change"): drop on a folder row moves into it, on a file row into
that file's folder, on a vault header row to that vault's root (other
vault → cross-vault move, milestone 28). Same-dir
drops and a folder into its own subtree are no-ops (no-drop cursor;
`VaultManager.renameEntry` now guards the subtree case main-side too).
Valid drops run the rename sequence — `renameEntry` (sidecar moves along)
→ `retargetTabs` (open tabs re-point, unsaved buffers survive) →
clipboard remap → the destination expands — and a name collision alerts
without touching anything. Files keep dragging into the editor
(ADR-0028); a folder carries no vault-path data type, so it can only move
inside the panel. *Fix:* file dragstarts announced
`effectAllowed: 'copyLink'` while the tree rows negotiate `move` — an
empty intersection, so Chromium showed no-drop and file drags could
never move (folder drags always worked). Now `copyMove`, with the
editor's `copy` still covered; the spec pins the negotiation.

req-14 — an **optional** chokidar file watcher (Settings → Vault →
"Watch the vault for external changes", off by default — ADR-0045,
amends ADR-0018's "purely additive" clause). One external-change round
in main, shared by all change sources: `VaultWatcher` (chokidar v3 CJS,
`ignoreInitial` + ready gate, dot-entry ignore, `awaitWriteFinish`,
~300 ms debounce for OneDrive bursts) → `OwnWriteLedger` (every
`VaultManager` mutation records itself: content writes as post-write
mtime, structural ops as path+TTL; a match drops the app's own echo —
a missed match costs one redundant refresh, never corruption) →
`VaultChangeAnnouncer` (per-file `write`/`delete` plugin events for
`.md`, then one `vault:changed` renderer push with the changed paths,
capped at 200). The push is the renamed, payload-carrying
`mcp:vault-changed`; `EditorService` auto-reloads **clean** open tabs
among the changed paths (`modifiedMs` finally earning its keep) and
flips tabs of externally deleted files to draft semantics; dirty tabs
stay last-writer-wins, no conflict dialog. The manual refresh button
now runs the same full round in main (`vault:refresh`) — fixing the old
gap where it re-pulled the tree but left the tag/task indexes stale.
New modules `electron/own-write-ledger.ts`, `electron/vault-watcher.ts`,
`electron/vault-change-announcer.ts`; the tags plugin re-indexes a
single file on scoped `write` events (mirroring tasks).

Req-5 — `Ctrl`/`Cmd`-click a link opens it in the OS browser. Already wired
for the document editor (`link-open.ts` `linkActivation` → `Editor.activateLink`
→ `shell.openExternal`, allow-listed to `http(s):` / `mailto:`); extended to
the "Add entry" capture surface (`EntryDrawer.activateLink`, web/mail only —
the drawer has no note path to resolve a relative link against).

Paste-a-URL → Markdown link. Pasting a bare URL onto an **empty** caret now
inserts `[url](url)` with the label pre-selected (`paste-link.ts`
`pasteUrlAsMarkdownLink`, Markdown-only). `@codemirror/lang-markdown`'s own
`pasteURLAsLink` still handles the wrap-a-selection case (`[selection](url)`);
the new handler only fills the empty-caret gap and stays clear of code /
existing links / frontmatter and image pastes.

bug-1 — a bare timestamp (`2026-09-09T00:03:48`) had its `:03:` slice
coloured. Cause: `markdownLanguage` bundles `@lezer/markdown`'s `Emoji`
inline parser, whose `:name:` rule (`/^[a-zA-Z_0-9]+:/`) accepts digits, so
`:03:` parsed as an `Emoji` node. We never render `:shortcode:` emoji — the
parser is now dropped (`markdown({ extensions: [{ remove: ['Emoji'] }] })`).

bug-2 — the Appearance **Theme** (and Editor font) `<select>` always showed
the first option. `<select [value]>` is set before `@for` renders the
`<option>`s, so the browser can't match it. Fixed with `[selected]` on each
option.

bug-3 — the editor typeface stopped applying under a published `@uiw` theme.
Those themes emit `&.cm-editor .cm-scroller { font-family: <mono> }` — the
exact selector `editorStructure` used for `var(--font-sans)` — and the theme
compartment wins at equal specificity regardless of declaration order. The
app rule is now one class heavier (`&.cm-editor.cm-editor .cm-scroller`) so
it outranks any theme outright.

Req-1 — Live Preview embed affordances. The corner **View source** button is
now `</>` (was a pencil) and shares a `.lp-tools` flex cluster with the zoom
lens, so they no longer stack on top of each other (they did on a mermaid
diagram, making the button unclickable). Images gained the `</>` button too;
revealing an image's source now shows the raw `![alt](path)` line inside a
rounded, bordered container **with the rendered image kept directly below
it**. Every text embed's revealed source (table / mermaid / HTML / image)
gets that same container so the active-line highlight reads as in-scope.
See [ADR-0009](../docs/09_architecture_decisions/0009-live-preview-decorations.md)
"Later change".

req-7 — a dock panel's own control row moved into the shared 32px
`PanelFrame` header instead of a band below it. New leaf module
`src/app/dock/panel-header-actions.ts`: `PanelHeaderActionsStore`
(`Map<widgetId, TemplateRef>` signal) + an `[appPanelHeaderActions]="<id>"`
directive on an `<ng-template>` in the panel body; `PanelFrame` renders the
matching template in a `.head-actions` slot — right-aligned, immediately
left of the drag grip — that swallows `mousedown` / `keydown` so a control
click never collapses/drags the panel. Applied to **Tasks** (scope · hide-done · kind
toggles) and **Files** / **Templates** (refresh; Files also collapse-all).
The `files` / `templates` panels' header status values (vault name /
templates dir) were dropped in the same pass so the header reads as
controls, not chrome. Assistant / Search / Calendar left as-is.
See [ADR-0019](../docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)
"Later change — controls in the panel header".

req-8 — the Tasks panel gained a free-text + multi-tag filter with tag
autocomplete. `TaskRecord` now carries `tags` = the inline `#tags` of the
task's heading-section (`scanTasks` reuses `splitSections` +
`extractInlineTags` from `shared/tags`), so `tasks:list` and the live
document scan both provide it. `TaskService` holds `queryTags` / `queryText`
(persisted in `localStorage['drey.tasks']`); `visible` keeps a task when
every query tag matches its section tags (nested tags included, via the
shared `tagSetMatches`) and every whitespace term is a substring of its
text/heading. `TasksPanel` renders a tag-chip input (`<datalist>`
autocomplete over `TagService.tags()`, mirroring the Search panel) + a
free-text field as the first body row.

req-22 (drag-and-drop half) — Calendar drop: drag an Outlook `.ics` / `.msg`
(from the calendar or the file system) onto the editor to insert a
formatted **meeting section** at the drop point: title, date/time,
participants, invitation body and attachment names, auto-tagged
`#mtg/<kebab-case-title>` so it lands in the tag section index. Also
**File → Import meeting …** (native picker) as the fallback for Outlook
drags that deliver no real file (new Outlook / OWA drags do not — save as
`.ics` first, or use Import meeting). The section is rendered from an
editable `templates/meeting.md` (scaffolded from an English default on
first use) via a tiny `{{#if}}` / `{{#each}}` evaluator; `.ics` / `.msg`
are decoded in the main process (`electron/meeting/`, `ical.js` +
`@kenjiuno/msgreader`, the invite's `VTIMEZONE` resolved to local time).
Decode-only — the invite file itself is not copied into the vault. New
`shared/meeting` / `electron/meeting` / `src/app/meeting` feature modules;
the drop branch lives in `image-paste.ts`. The remaining `req-22` scope
(a context-menu "add meeting log" with a per-day appointment picker) is a
follow-up on top of this.
See [ADR-0041](../docs/09_architecture_decisions/0041-calendar-file-drop-meeting-section.md).

In-editor web browser tab (ADR-0042). `File -> New browser tab` /
`Ctrl+Shift+B` opens a fileless `browser://<n>` tab
(`OpenDoc.kind: 'browser'`) whose page is a main-process `WebContentsView`
(`electron/browser/BrowserViewManager`), floated over the Angular layout by
streaming the chrome placeholder's client rect as bounds. `src/app/browser/`
holds `BrowserTab` (toolbar only) and `BrowserViewService` (state, event
reducer, lifecycle -- destroys a view when its `browser://` key leaves
`editor.openDocs()`). `normalizeAddress` sends non-URL input to DuckDuckGo;
the session is an isolated `persist:webtab` partition; each view's
`webContents` gets its own `will-navigate` / `setWindowOpenHandler` (http(s)
popups reopen as tabs) / `context-menu` (nav, clipboard, open-link/image in
a tab, search selection, inspect) and denies every permission request.
`WebContentsView` paints above all DOM, so `OverlayGuardService` + the
`[appOverlayGuard]` directive (+ a `LayoutGestureService` for splitter /
dock drags) hide every view while an overlay or layout drag is active.
Find-in-page via `webContents.findInPage` (`Ctrl+F`). New IPC channels in
`shared/browser` + `electron/ipc/browser-handlers.ts`. Follow-up: restore
open tabs + layout on restart (session history).

Session history (ADR-0043). `SessionService` (`src/app/session/`) persists
the pane layout + open-tab list to `localStorage['drey.session']` and
restores it once at startup (before the daily-note fallback; skipped if the
vault changed). `PaneService` gained `snapshot()` / `restore(keepPath)` —
reversing ADR-0037's 'not persisted' note — which prunes tabs that no
longer resolve and empty panes. Unsaved buffer text is kept in a
main-process backup store (`electron/session/SessionBackupStore`, one
`<uuid>.txt` per tab under `<userData>/session-backups/`, IPC `session:*`):
a never-saved scratch buffer, or unsaved edits re-applied over the fresh
disk read. Persist runs off one debounced effect + `beforeunload` /
`visibilitychange` flushes; backups are reference-counted and orphans
pruned on launch. Browser tabs restore under their exact `browser://<n>`
key. New feature modules `electron/session/` + `src/app/session/`.

bug-9 — Tab inside the editor moved keyboard focus to the next control
instead of inserting anything: `basicSetup` ships no Tab binding at all
(`indentWithTab` is not part of it), so the unbound key fell through to the
browser's focus navigation. `Tab` is now bound on the shared
`MarkdownSurface` (`src/app/editor/editor-indent.ts`, `Prec.highest` so
plugin-contributed keymaps can't shadow it): an empty caret inserts a
literal tab character, a selection indents the selected lines
(`indentMore`), Shift+Tab outdents (`indentLess`); the indent unit is a
literal tab. The binding is gated on `view.editable`, so the read-only
assistant composer stays inert. Deliberate a11y tradeoff (project owner's
call): Tab no longer leaves the editor — `F6` / `Shift+F6` (pane focus)
remain the way out. Covers the full-page editor and the "Add entry" drawer
body (same surface).

bug-7 — the Files panel's arrow keys moved the highlight, but **Enter did
not open** the highlighted file. The rows are focusable `<button>`s and the
selection was only a visual signal — `select()` never moved DOM focus, so
focus stayed on the originally-clicked row and Enter natively re-activated
*that* one. The selected row now takes DOM focus on every keyboard move
(roving `tabindex`, focus-follow in `select()`), so Enter/Space activate the
highlighted row; as a side effect the tree collapses to a single Tab stop
instead of one per row.

bug-6 — intermittent stuck input in the packaged build (no field accepts
text, the Appearance dropdowns stop changing, mouse still works, only a
restart clears it; the Appearance `<select>` blur that closed an open
dropdown under the user was one visible symptom). **Root cause remains
unconfirmed** — the renderer's DOM was exonerated (the keybinding service is
stateless exact-chord matching and never swallows unmatched keys; no focus
trap exists; `user-select: none` does not block typing) — so this pass is
hardening + diagnosability at every plausible layer:
(1) two pointer gestures that set `body { user-select: none }` without the
`data-drey-gesture` marker and without window-blur cleanup — the pane
splitter and the Live-Preview image resize — now carry the marker and end
themselves on window blur, so an alt-tab mid-drag can no longer leak the
style, and the input-recovery watchdog no longer false-positives mid-gesture
(its `recover()` blurs the active element, which is what could close an open
native dropdown);
(2) native context-menu popups (`electron/menu.ts`) are now tracked per
window, closed on window blur/minimize, and logged — an Electron popup whose
capture loop never unwinds is the leading hypothesis for the full symptom
set (invisible, swallows all keyboard, renderer can neither see nor fix it);
(3) "Recover input focus" (View menu / `Mod+Alt+Shift+R`) now also reaches
main (`window:recover-input`) to force-close such a popup, and every step
logs to `drey.log` so a field occurrence finally leaves a trace;
(4) a dead `.menu-backdrop` selector in `InputRecoveryService` was removed.

bug-6 follow-up (2026-09-18) — a reproducible trigger surfaced: deleting a
file via the Files panel's right-click menu left every input field dead (no
caret, typing ignored, mouse selection and Delete/Entf still worked; an
Alt+Tab round trip cleared it). The flow's synchronous `confirm()` is one of
the native blocking dialogs that break Windows keyboard focus
(electron#41602, electron#19977). All renderer `confirm()`/`alert()` calls
are retired: a new in-renderer confirm/message dialog
(`ConfirmDialogService` + `app-confirm-dialog`, the Exit-prompt pattern)
covers the delete / remove-vault / dirty-tab-close prompts and every
Files-panel error alert. Main-side native dialogs
(`showOpenDialog`/`showSaveDialog`/`showMessageBox`) call
`refocusRenderer()` (`electron/focus.ts`) as they resolve, and the
recover-input handler now refocuses the webContents too. A same-day
follow-up closed the last remainder: the plugin SDK gained
`api.ui.showMessage(message, title?)` (minor 8 — the app's own OK-only
dialog, queuing like the native calls did), and the four `window.alert`
calls in the meeting/templates plugins go through it — no native
`alert()`/`confirm()` call is left in the renderer.

bug-8 — the Files panel gained a **multi-selection** (project request):
Ctrl+click toggles rows into the set, Shift+click / Shift+arrow extend a
range over the visible rows, Ctrl+arrow moves the cursor without changing
the selection, Escape collapses back to the cursor row, and right-clicking
inside a multi-selection makes the context menu act on all of it (outside
one, it collapses to the right-clicked row, so Delete can't surprise).
Enter opens every selected file (folders skipped), Delete removes the whole
selection after one count-aware `confirm` — as a single batched IPC call
(`vault:delete-many`, one vault-change re-index for the whole batch, not
per path). Tab-close and clipboard invalidation run per deleted path; a
selection row that lived under a deleted folder is deselected. Dragging a
row still carries that single row's path (req-23 ships single-entry drag;
a drag of the whole multi-selection is still open).

bug-5 — the app now asks before exiting with unsaved changes. Every close
path (titlebar X, Alt+F4, taskbar close/Quit, macOS role close/quit) funnels
into one `BrowserWindow 'close'` interception (`electron/main.ts`): main
holds the window and asks the renderer — which owns the dirty-document
registry — over the `exit:confirm-request` / `exit:decision` bridge pair
(`ExitBridge`, a `McpWriteBridge` copy **without** the 120 s timeout: a
timeout would auto-decide the user's exit; a hung renderer leaves the
window open, and the session backups have the text regardless). Clean
state answers "proceed" without any dialog. With dirty documents an
in-app dialog offers **Save all / Exit without saving / Cancel**:
*Save all* runs `saveAll({ drafts: true, runOnSaveActions: false })` —
real files save straight through, and untitled scratch tabs commit into a
new hidden `<vault>/.drafts/` folder as `unnamed-N.md` (the Notepad++
model, project owner's call: no Save-As dialogs on exit; an explicit
"Save as…" away from `.drafts/` later **moves** the file and deletes the
draft). On-save Actions are suppressed on the exit path only — no LLM
round trips during shutdown (deviation from `saveAll`'s menu behaviour,
flagged here rather than in an ADR). If anything stays dirty after saving
(a failed write), the answer is "cancel" and the app stays open with the
error visible. "Exit without saving" flushes the session backups
(`SessionService.flushNow()` is now public/awaited) before answering —
ADR-0043 keeps the buffers restorable either way. `before-quit` routes an
app-level quit through the same prompt (`quitIntent` flag; the
`!mainWindow` clause keeps the post-approved quit cascade from
re-intercepting).

---

## Phase 1 — MVP & foundation (milestones 1–21)

Condensed to one line per feature area; the full narrative per milestone
is in [`docs/milestones-done.md`](../docs/milestones-done.md), the
behavioural detail in the linked ADRs and the arc42 docs.

- **Shell & dock system** — frameless window, custom titlebar with an HTML
  menu bar, three docks (left/right/bottom) of draggable/resizable/
  collapsible panels, status bar, persisted layout, content-height
  calendar ([ADR-0019](../docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md),
  [ADR-0034](../docs/09_architecture_decisions/0034-internal-widget-model.md)).
- **Editor** — CodeMirror 6 with in-place Live Preview (decoration-based,
  conceal-around-selection, mermaid, tables/images as widgets,
  clickable task checkboxes, `#tag` pills) plus a source mode
  ([ADR-0008](../docs/09_architecture_decisions/0008-editor-mode-menu-and-rendered-preview.md),
  [ADR-0009](../docs/09_architecture_decisions/0009-live-preview-decorations.md),
  [ADR-0025](../docs/09_architecture_decisions/0025-mermaid-live-preview.md)),
  named themes incl. the published CM6 set
  ([ADR-0035](../docs/09_architecture_decisions/0035-named-ui-themes.md)),
  per-file syntax highlighting for non-Markdown
  ([ADR-0036](../docs/09_architecture_decisions/0036-code-file-editor-mode.md)),
  fold gutter, line-number toggle, Tab handling, spellcheck
  ([ADR-0013](../docs/09_architecture_decisions/0013-inline-spellcheck.md)).
- **Split-view panes** — arbitrary row/column split tree, per-pane tabs,
  focused-pane facade, tab drag & drop, editor panes dockable into the
  three docks
  ([ADR-0037](../docs/09_architecture_decisions/0037-split-view-editor-panes.md),
  [ADR-0038](../docs/09_architecture_decisions/0038-editor-panes-in-docks.md),
  [ADR-0039](../docs/09_architecture_decisions/0039-drag-and-drop-chrome.md)).
- **Quick-capture & daily notes** — global hotkey, `daily/<y>/<m>/` paths,
  timed entries, startup draft, configurable entry templates (Classic /
  Ruled / own).
- **Template library** — category folders, Templates panel, insert
  (click/drag/context menu/`Ctrl+T` picker), placeholder substitution
  ([ADR-0029](../docs/09_architecture_decisions/0029-template-library.md)).
- **Tags & section search** — free inline `#tag`s (nested), vocabulary +
  inverted section index, tags-AND + free-text search with open-at-line
  and Markdown Export, Autotag button
  ([ADR-0017](../docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md)).
- **Tasks panel** — GFM checkbox / `#task` lines, document or vault scope,
  hide-done, kind filter, tag+text filter, tick-back writes to the source
  file ([ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md)).
- **Assistant & Actions** — per-note sidecar threads, automatic summary,
  Ask with running history, insert-into-note, no-timeout generation with
  cancel ([ADR-0012](../docs/09_architecture_decisions/0012-note-assistant-sidecar-thread.md)),
  trigger→template Actions with the shared confirmation flow
  (inline/split diff, "don't ask again")
  ([ADR-0011](../docs/09_architecture_decisions/0011-unified-confirmation-flow.md)).
- **Settings** — master-detail screen, draft-until-save, `app-config.json`
  under the OS user-data dir
  ([ADR-0010](../docs/09_architecture_decisions/0010-app-settings-storage.md)).
- **Images & attachments** — paste/drop into `attachments/` beside the
  note, `drey-asset://` serving, size syntax + resize grip, zoom/pan
  lightbox, image tabs
  ([ADR-0024](../docs/09_architecture_decisions/0024-binary-vault-asset-write.md),
  [ADR-0026](../docs/09_architecture_decisions/0026-image-viewer-and-lightbox.md),
  [ADR-0028](../docs/09_architecture_decisions/0028-drag-drop-into-the-editor.md),
  [ADR-0027](../docs/09_architecture_decisions/0027-window-dnd-navigation-guard.md)).
- **Meeting import** — `.ics` / `.msg` drop / File → Import meeting →
  templated `#mtg/…` meeting section
  ([ADR-0041](../docs/09_architecture_decisions/0041-calendar-file-drop-meeting-section.md)).
- **In-editor browser tab** — `browser://<n>` tabs over a main-process
  `WebContentsView`
  ([ADR-0042](../docs/09_architecture_decisions/0042-in-editor-web-browser-tab.md)).
- **Session history & exit guard** — restore panes/tabs/unsaved buffers
  across restarts, `.drafts/` auto-save of untitled tabs, the
  exit-with-unsaved-changes prompt
  ([ADR-0043](../docs/09_architecture_decisions/0043-session-history.md)).
- **Refresh model** — manual refresh round, no watcher by default, opt-in
  chokidar watcher with own-write suppression
  ([ADR-0018](../docs/09_architecture_decisions/0018-manual-refresh-no-file-watcher.md),
  [ADR-0045](../docs/09_architecture_decisions/0045-optional-vault-file-watcher.md)).
- **Vault MCP server** — `vault_search` / `vault_read` / `vault_write`
  over hand-rolled JSON-RPC, stdio bridge + opt-in HTTP transport,
  confirmation dialog or YOLO mode, assistant vault tool use
  ([ADR-0021](../docs/09_architecture_decisions/0021-mcp-vault-server.md)).
- **Runtime plugin system** — base application + in-process plugins under
  `plugins/<id>/`, the SDK contract, registries, two-channel IPC,
  Settings → "Panels & plugins", packaging from inside `app.asar`
  ([ADR-0044](../docs/09_architecture_decisions/0044-runtime-plugin-system.md)).
- **Packaging** — electron-builder for Windows, plugins verified from
  `app.asar` (`docs/07_deployment_view.md`).
