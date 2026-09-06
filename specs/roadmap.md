# Drey — Concept & Roadmap

## Vision
An AI-powered knowledge hub for note-taking and task automation.

## Core Architectural Principles (fixed, apply to every phase)
- Everything stays plain Markdown with YAML frontmatter — no proprietary
  format.
- No server — Electron app, direct file access to any folder (including
  OneDrive).
- Folder structure is **not hardcoded** — it emerges dynamically.
- Classification/synthesis via a **local** OpenAI-compatible API, no fixed
  model. Unsloth Desktop is the default; any server speaking that dialect
  works (Unsloth Desktop, llama.cpp, vLLM, Ollama), with an optional
  bearer API key for the ones that require auth. Still no cloud calls.
- Interactive requests (capture, chat) always take priority over
  background jobs.

## Tech Stack
Electron + Angular/TypeScript, CodeMirror 6 (editor), chokidar (file
watching), transformers.js (embeddings), sqlite-vec (vector search),
OpenAI-API-compatible backend (LLM backend), Electron Builder (packaging).

---

## Phase 1 — MVP

**Goal: usable day to day, smallest viable feature set**

- **Quick-capture:** a global hotkey brings the main window forward and
  opens today's daily note in a file `YYYY-MM-DD.md` in the editor — where
  exactly this file lives in the vault is not yet decided and may still
  change. On open, a fresh `## HH:mm` entry is appended, ready to type
  into. There's no separate popup window — capture happens in the full
  editor, so inline `#tag` autocomplete (from the existing tag vocabulary,
  see routing below) and the editor mode menu are always available.

- **Note templates:** a `templates/` folder in the vault holds Markdown
  templates with `{{date}}` / `{{time}}` / `{{datetime}}` / `{{title}}`
  placeholders. `templates/daily.md` seeds new daily notes and is
  scaffolded with a starter layout on first use; editing it changes how
  future daily notes look. The same substitution mechanism seeds files
  created by tag routing.

- **Deterministic routing:** a known tag → target file/folder is fixed, no
  LLM call needed. A new tag (first occurrence) → one-time short
  confirmation on whether a dedicated folder makes sense, automatic
  afterwards. Routing does not move files: a tagged, dated entry (a
  `## HH:mm` block, e.g. in a daily note) is — dated — **copied** into the
  `## History` section of its tag's master document; the source note keeps
  its own copy. "One place, no duplicate" still holds only for note
  *files* (nothing is moved or symlinked) — the copy is the difference
  between the timeline view and the topic view.

- **Local LLM — purpose:** the local model is used to answer questions
  about an open document, generate summaries, and carry out edits to the
  document on request. The connection lives in **Settings → LLM**: an
  enable switch (the master off-switch for Actions and the chat's Ask
  mode), base URL, an optional **API key**, and the model — loaded from a
  live `GET /v1/models` or typed by hand for a server that doesn't expose
  it. The key goes out as `Authorization: Bearer <key>`, the OpenAI
  convention, so besides LM Studio (which ignores it) any compatible
  server works: Unsloth Desktop (`sk-unsloth-…` keys on
  `http://127.0.0.1:8888/v1`), llama.cpp, vLLM, Ollama.

- **Dynamic folder structure:** one master document per tag (`art`: topic,
  person, team, project, or term), which serves as both context for later
  processing and glossary content — once a tag outgrows a single file, the
  master document becomes the folder's index, further notes sit alongside
  it.

- **Tag overview:** a browsable list of all tags (same index used for
  autocomplete), clicking one opens its master document


- **Settings & Actions:** a master-detail settings screen (category list +
  detail pane, opened from the sidebar entry). Settings are app config,
  **not vault content** — stored in `app-config.json` under the OS
  user-data dir, independent of the active vault. Edits live in a draft
  and are written only on **Save**; closing with unsaved changes asks
  first (save / discard / keep editing). Two categories to start:
  - **LLM** — the connection config above, plus a **debug log** of every
    request sent this session (URL, headers, body, status, timing,
    response), each expandable into a runnable `curl` command so a
    failing connection can be reproduced outside the app. The API key is
    masked in the panel; copying the curl substitutes the real one.
    In-memory only, not persisted.
  - **Actions** — trigger → prompt-template mappings. Trigger types: "on
    save" and "manual button"; each mapping has its own "confirmation
    required" toggle (default on). A template library (name, prompt text,
    result kind) with one built-in, editable but not deletable entry:
    **Update summary** (above). A document-modifying action's result is
    previewed and confirmed through the shared confirmation flow: an
    inline line diff for small localized changes, side-by-side
    before/after for whole-document rewrites; a "don't ask again for this
    action" checkbox flips the mapping's confirmation toggle.

- **A single vault** (no switching, no sensitive/general separation yet —
  that comes in Phase 3).

- **Editor:** one CodeMirror 6 view with a true **Live Preview** mode
  (Obsidian-/Typora-style): syntax markers conceal everywhere except
  around the selection, fenced code is highlighted via nested language
  parsing, tables/images render as widgets, task markers are clickable
  checkboxes; the cursor sits directly in the rendered document. A `⋯`
  menu on the chrome switches to a raw **Source** mode as the escape hatch
  (no toggle buttons); the last choice is the per-machine default for new
  notes, Live Preview by default. Both modes share typography (serif
  sized headings, mono code, accent links). Footnotes render as plain
  text for now (no Lezer footnote extension).

- **"Add entry" drawer** at the bottom of the main area — the capture
  surface. Collapsible; contains tag chips, the Markdown text (the same
  editor component as the main editor, compact, with Live Preview and
  `#tag` autocomplete), and inline spellcheck.
  - The appended block is `## HH:mm`, followed by the text and a meta
    line listing the assigned tags; empty parts are omitted. Appending
    saves immediately, so the entry's tags route to their master
    documents right away.
  - **Inline spellcheck**, active from the first word typed — in both
    this text field and the document editor: misspelled words get a red
    wavy underline, clicking one offers corrections. German and English
    ship with the app; further Hunspell dictionaries are addable, and the
    active language is picked in Settings → Spelling.

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

- **File watcher (chokidar):** distinguishes frontmatter-only change vs.
  body change vs. new external file; autosave conflicts at minimum
  surface as a warning with "keep mine / take external version".

---

## Phase 2
- **Keyword search** (SQLite FTS or simple text search over the files).
- **Daily tasks:** inline `#task` syntax in any note file, a generated
  (read-only) day view built from timestamp scanning — distinct from the
  daily note file itself (that's a normal editable file; this is an
  aggregate view).
- Semantic search (embeddings via transformers.js + sqlite-vec, RAG for
  the "all notes" chat scope).
- Daily wrap-up (yesterday done/worked-on, prioritized list for today) —
  triggered by date rollover, not by app start (the app may run
  continuously in the tray).
- Spell check: Electron's native spellchecker, dictionary fed from file
  titles/`aliases`, flagging only, no auto-correct.

## Phase 3
- Multi-vault (primary purpose: separating sensitive content — personnel
  topics, interviews — from general notes), a fixed default vault, manual
  switch before capture.
- Optional cross-vault search mode (default: scoped per vault).
- Image paste (editor + quick-capture popup), stored in a global
  `assets/` folder, a dedicated Electron protocol for safe rendering, no
  auto-caption.

## Phase 4 — Experiments
- Interview mode: templates with starter questions, the model drafts
  adaptive follow-up questions, text-only, result feeds into the normal
  processing pipeline (primarily lands in the sensitive vault).
- Task center: an active, writable task overview across all files
  (checking a box here writes back to the source file, needs stable task
  IDs instead of line numbers).
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

---

## Open Risks / Undecided Details
- Autosave-vs-watcher conflict: concrete UX not yet defined (diff view?
  conflict copy? undo?).
- Model contention: assistant usage vs. any benchmarking models running
  in parallel — needs an availability check before every call.
- Folder sprawl from new tags: the one-time confirmation on first
  occurrence of a tag is the only brake — no guarantee against
  near-duplicates (e.g. "sailing" vs. "boat").
- The exact storage location of the daily note file (`YYYY-MM-DD.md`) is
  still open; tag routing and later folder logic need to be able to tell
  structural folders like `templates/` (and the still-undetermined daily
  note location) apart from topic folders.