# Drey — Concept & Roadmap

## Vision

An AI-powered knowledge hub for note-taking and task automation.

## Core Architectural Principles (fixed, apply to every phase)

- Everything stays plain Markdown with optional YAML frontmatter — no
  proprietary format.
- No server — Electron app, direct file access to any folder (including
  OneDrive).
- Folder structure is **the user's own**. The app imposes only the
  structural `templates/` and `daily/` folders; topics are free inline
  `#tag` labels, never directories, and the app never creates or moves
  folders on a tag's behalf.
- Classification/synthesis via a **local** OpenAI-compatible API, no fixed
  model. Unsloth Desktop is the default; any server speaking that dialect
  works (Unsloth Desktop, llama.cpp, vLLM, Ollama, LM Studio), with an
  optional bearer API key for the ones that require auth. Still no cloud
  calls.
- Interactive requests (capture, chat) always take priority over
  background jobs.

## Tech Stack

Electron + Angular/TypeScript, CodeMirror 6 (editor), transformers.js
(embeddings, Phase 2), sqlite-vec (vector search, Phase 2),
OpenAI-API-compatible backend (LLM backend), Electron Builder (packaging).
No file watcher — the vault is re-read on demand (see "Manual refresh"
below).

---

## Phase 1 — MVP

**Goal: usable day to day, smallest viable feature set**

- **UI shell (v3 dock layout, milestone 14 — `handoff/DESIGN.md`,
  [ADR-0019](../docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)):**
  a frameless window with a custom titlebar (accent square + "Drey" + an
  HTML File/Edit/Selection/View menu bar + window controls), a left and a
  right **dock**, the editor column between them, and a 26px status bar
  (word/char count · context hint · Settings). The former sidebar
  contents — calendar, file tree, tag search, open-windows — plus the note
  assistant are **five panels** the user drags between the two docks,
  resizes with splitters, and collapses to their header; the arrangement
  persists per machine. "Sidebar" in the feature bullets below now means
  the relevant dock panel. Design tokens (exact hex / px / type from the
  handoff) live centrally in `src/styles.css`; the editor keeps
  CodeMirror 6 + Live Preview rather than the prototype's block model.

- **Quick-capture:** a global hotkey brings the main window forward and
  opens today's daily note — `daily/<year>/<month>/YYYY-MM-DD.md` — in the
  editor. On open, a fresh `## HH:mm` entry is appended, ready to type
  into. There's no separate popup window — capture happens in the full
  editor, so inline `#tag` autocomplete (from the tag vocabulary, see the
  tag index below) and the editor mode menu are always available. Older
  flat `daily/YYYY-MM-DD.md` files are still opened if present.

- **Note templates:** a `templates/` folder in the vault holds Markdown
  templates with `{{date}}` / `{{time}}` / `{{datetime}}` / `{{title}}`
  placeholders. `templates/daily.md` seeds new daily notes and is
  scaffolded with a starter layout on first use; editing it changes how
  future daily notes look.

- **Tags & tag index:** topics are free inline `#tag`s in the note body
  (`#` + a letter, then letters/digits/`_`/`-`, lower-cased). No creation
  flow, no "unknown tag" concept, no folders, no routing. `#task` is a
  reserved structural marker and is never a tag; `#important` is an
  ordinary, searchable tag. A main-process **tag index** scans every `.md`
  in the vault (`templates/` excluded, `daily/` **included**) and holds
  - the **tag vocabulary** with per-tag counts — feeds `#tag` autocomplete
    and the search panel's tag picker;
  - an **inverted index of tagged sections** (`##` / `###` granularity):
    for every section containing at least one tag, its file path, heading,
    start line, tag set and text.

  Full rebuild on vault open and on manual refresh; a single file is
  re-indexed on save.

- **Tag search:** a collapsible "Search" section in the sidebar. The query
  is one or more tags (AND) plus optional free text (AND over
  whitespace-split terms, each matched in a section's body **or** its
  heading); free text alone is allowed. Results are section-level hits —
  file path, heading, line, snippet — ordered by path then line; clicking
  one opens that file at that line. An **Export** button writes the full
  hits (`## <path>:<line>` heading + the whole section text per hit) into
  an unsaved `search-results.md` tab. `Ctrl+Shift+F` opens and focuses the
  panel (through the app keybinding registry); `Ctrl`/`Cmd`-clicking a
  `#tag` pill in the editor replaces the query with that tag and runs it.
  An on-demand LLM digest of the results exists in the backend
  (`SEARCH_SUMMARY_PROMPT`) but its panel UI is currently parked.

- **Autotagging:** a button beside the drawer's tag field. Explicit call
  only — no on-save, no `⋯` trigger. It sends the current entry text plus
  the tag vocabulary to the local model; the reply **pre-fills** the tag
  field and the user confirms by saving. The prompt is an English,
  editable built-in Action template.

- **Local LLM — purpose:** the local model answers questions about an open
  document, generates summaries, and carries out edits to the document on
  request. The connection lives in **Settings → LLM**: an enable switch
  (the master off-switch for Actions and the assistant's Ask mode), base
  URL, an optional **API key**, and the model — loaded from a live
  `GET /v1/models` or typed by hand for a server that doesn't expose it.
  The key goes out as `Authorization: Bearer <key>` (the OpenAI
  convention), so besides LM Studio (which ignores it) any compatible
  server works: Unsloth Desktop (`sk-unsloth-…` keys on
  `http://127.0.0.1:8888/v1`), llama.cpp, vLLM, Ollama.

- **Settings & Actions:** a master-detail settings screen (category list +
  detail pane, opened from the sidebar entry). Settings are app config,
  **not vault content** — stored in `app-config.json` under the OS
  user-data dir, independent of the active vault. Edits live in a draft
  and are written only on **Save**; closing with unsaved changes asks
  first (save / discard / keep editing). Categories: **LLM**,
  **Assistant** (auto-summary default), **Spelling** (dictionaries +
  language), **Appearance** (editor typeface), **Actions**.
  - **LLM** — the connection config above, plus a **debug log** of every
    request sent this session (URL, headers, body, status, timing,
    response), each expandable into a runnable `curl` command so a
    failing connection can be reproduced outside the app. The API key is
    masked in the panel; copying the curl substitutes the real one.
    In-memory only, not persisted.
  - **Actions** — trigger → prompt-template mappings. Trigger types: "on
    save" and "manual button"; each mapping has its own "confirmation
    required" toggle (default on). A template library (name, prompt text,
    result kind) with three built-in, editable but not deletable entries:
    **Summarise note** (the assistant panel's automatic summary),
    **Summarise search results** (the parked search digest), and
    **Autotag** (above). A document-modifying action's result is previewed
    and confirmed through the shared confirmation flow: an inline line
    diff for small localized changes, side-by-side before/after for
    whole-document rewrites; a "don't ask again for this action" checkbox
    flips the mapping's confirmation toggle.

- **A single active vault** (no sensitive/general separation yet — that
  comes in Phase 3). The Files panel's vault row offers only "Open other
  vault …", which re-points the one active vault through the directory
  picker; there is no known-vaults registry.

- **Editor:** one CodeMirror 6 view with a true **Live Preview** mode
  (Obsidian-/Typora-style): syntax markers conceal everywhere except
  around the selection, fenced code is highlighted via nested language
  parsing, tables/images render as widgets, task markers are clickable
  checkboxes (a checked `- [x]` line's text is struck through), inline
  `#tag`s render as pills; the cursor sits directly in the rendered
  document. A `⋯` menu on the chrome switches to a raw
  **Source** mode as the escape hatch (no toggle buttons); the last
  choice is the per-machine default for new notes, Live Preview by
  default. Headings use the app's sans typeface by default; a different
  face (serif, mono, …) is selectable in Settings → Appearance. Footnotes
  render as plain text for now (no Lezer footnote extension).

- **"Add entry" drawer** at the bottom of the main area — the capture
  surface. Starts collapsed. Contains an optional **TOPIC** field, a
  single **Tags** chip row, the Markdown text (the same editor component
  as the main editor, compact, with Live Preview and `#tag` autocomplete),
  inline spellcheck, and the Autotag button.
  - The appended block is a **chosen template** (`AppConfig.entry`,
    Settings → Add entry) with `{{time}} {{date}} {{datetime}} {{title}}
    {{tags}} {{content}}` substituted; blank lines collapse and a trailing
    rule is dropped, so an entry with nothing filled in stays
    byte-identical to a bare `## HH:mm`. Two built-ins ship —
    **Classic** (`## HH:mm[ — Topic]` / text / `#tag` line, the old fixed
    shape) and **Ruled** (heading / `---` / `#tags` / body) — plus the
    user's own; one is active. `parseDatedEntries` strips a leading rule
    (and, on the Ruled signature, a leading tag line) so entries still
    round-trip. Appending saves immediately.
  - **Inline spellcheck**, active from the first word typed — in both this
    text field and the document editor: misspelled words get a red wavy
    underline, clicking one offers corrections or an "Add to dictionary"
    action. German and English ship with the app; further Hunspell
    dictionaries are addable, and the active language is picked in
    Settings → Spelling. Accepted words are kept in two lists —
    **personal** (every dictionary) and **per-dictionary** — editable
    from the popup and from Settings.

- **Note assistant panel** on the right — per open note.
  - An **"Automatic summary"** switch in the panel header. When a note is
    opened for the first time, has no sidecar thread yet, and the switch
    is on, its summary is generated and stored as the first card of the
    thread. Off means nothing happens automatically; a manual "Summarise
    now" button covers changing your mind afterwards.
  - The switch is seeded from a global default (Settings → Assistant,
    "Summarise notes automatically by default") and overrides it **for
    the open note only** — it never changes the default itself.
  - Below it, **Ask**: a question about the note goes to the LLM with the
    full document as context. An answer becomes a card; a
    document-modifying instruction goes through the same confirmation
    flow as Actions. Disabled when the LLM master switch is off. No RAG —
    the editor buffer goes straight into the prompt.
  - **Generation has no timeout.** While the model works, the panel shows
    how long it has been thinking and a Cancel button; a finished card
    keeps "took 8s". A local model legitimately needs minutes, so the
    user ends the wait, not a fixed timeout.
  - The thread is persisted next to the note as `.{name}.chat.json`,
    never into the note itself.
  - **Ask carries the running conversation.** A follow-up question sends
    the note's earlier cards as chat turns (`historyForAsk`, capped at
    ~12), so the model answers in context rather than re-reading the
    document cold each time.
  - Each answer / summary card has an **insert-into-note** arrow beside
    Copy — drops the card text into the editor at the caret.

- **Vault MCP server ([ADR-0021](../docs/09_architecture_decisions/0021-mcp-vault-server.md)):**
  a local Model Context Protocol server exposing three tools over the
  active vault — `vault_search` (tags + free text + an optional **regex**
  filter, or a standalone whole-vault regex line scan), `vault_read`,
  `vault_write` (overwrite / append). Hand-rolled JSON-RPC (no SDK
  dependency), two transports: a bundled **stdio bridge** script for
  desktop clients and an **opt-in localhost HTTP endpoint** for network
  clients. A `vault_write` is shown in the shared diff dialog for
  confirmation before it touches disk, unless **"YOLO mode"** (Settings →
  MCP, off by default) is on. The built-in assistant uses the same tool
  set during Ask when the server is enabled (an OpenAI tool-calling loop
  in `LmStudioClient`, with a capability fallback). Settings gains an
  **MCP** category (enable switch, HTTP port, YOLO switch, client config
  snippet).

- **"Add entry" is a dock panel.** The capture drawer is no longer a
  fixed strip: it is a movable/collapsible panel whose default home is a
  new **bottom dock** (a band under the editor). See
  [ADR-0019](../docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)'s
  "Later change".

- **Manual refresh:** there is no file watcher. A refresh button in the
  sidebar re-reads the vault from disk and rebuilds the tag index; the
  app also refreshes itself after the writes it makes (note save, first
  save of a daily-note draft, file/folder create or delete). Rationale:
  with thin, optional frontmatter there is no "frontmatter-only vs. body"
  distinction left to justify a watcher, and chokidar's per-write
  ignore-window, debounce and lifecycle are strictly more moving parts. A
  watcher stays a purely additive future option.

---

## Phase 2

- **Dedicated keyword search / FTS index** — the free-text mode of tag
  search already covers the common case over section text and headings; a
  standalone SQLite FTS index over whole files is the deferred step.
- **Daily tasks:** inline `#task` syntax in any note file, a generated
  (read-only) day view built from timestamp scanning — distinct from the
  daily note file itself (that's a normal editable file; this is an
  aggregate view).
- Semantic search (embeddings via transformers.js + sqlite-vec, RAG for
  the "all notes" chat scope).
- Daily wrap-up (yesterday done/worked-on, prioritized list for today) —
  triggered by date rollover, not by app start (the app may run
  continuously in the tray).

## Phase 3

- Multi-vault (primary purpose: separating sensitive content — personnel
  topics, interviews — from general notes), a fixed default vault, manual
  switch before capture.
- Optional cross-vault search mode (default: scoped per vault).
- Image paste (editor + quick-capture), stored in a global `assets/`
  folder, a dedicated Electron protocol for safe rendering, no
  auto-caption.

## Phase 4 — Experiments

- Interview mode: templates with starter questions, the model drafts
  adaptive follow-up questions, text-only, result feeds into the normal
  processing pipeline (primarily lands in the sensitive vault).
- Task center: an active, writable task overview across all files
  (checking a box here writes back to the source file, using the
  mandatory `#task id:` instead of line numbers).
- Job queue: configurable background processes (re-indexing after a model
  change, export), status/progress, persisted against crashes,
  auto-pauses on interactive use.

## Future Scope (noted, no target date)

- OCR for handwritten notes (iPad expansion stage, Apple Vision Framework
  or local Tesseract).
- iPad/iPhone access via Tailscale to the PC backend.
- Audio recording in interview mode (local Whisper).
- Automatic image captioning via a vision model.
- Editor: footnote rendering in Live Preview (needs a custom Lezer
  markdown extension), `Ctrl`-click to open concealed link targets.
- An additive chokidar file watcher, if manual refresh proves too coarse.
- playwright m365 copilot über browser automatisierung

---

## Open Risks / Undecided Details

- Stale view without a watcher: an external tool changing vault files is
  not noticed until the next manual refresh. Acceptable for a
  single-user, single-machine tool; revisit if it bites.
- Model contention: assistant usage vs. any benchmarking models running
  in parallel — needs an availability check before every call.
- Tag sprawl: nothing prevents near-duplicate tags (`sailing` vs.
  `boat`). Autotagging biases toward reusing existing vocabulary, but the
  user can always type a fresh tag, and there is no merge/alias tool yet.
- Very large vocabularies: the autotag prompt embeds the full tag list.
  Fine for tens to low hundreds of tags; a pre-filter step would be
  needed well beyond that (see `classifier-spec.md`).
