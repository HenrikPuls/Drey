# Drey — Concept & Roadmap

## Vision
Local, topic-based note-taking app. Runs in the background, thoughts land
in Markdown files via quick-capture, a local LLM classifies automatically
(topic/person/task) and asks when unsure instead of misfiling silently.

## Core Architectural Principles (fixed, apply to every phase)
- Everything stays plain Markdown with YAML frontmatter — no proprietary format
- No server — Electron app, direct file access to any folder (including OneDrive)
- Folder structure is **not hardcoded** — it emerges dynamically. The LLM
  proposes new folders, confirmation happens via the inbox (no popup interruption)
- Inline `#tag` syntax (like Obsidian) is the primary, fast assignment path —
  a known tag routes deterministically with no LLM call. A note can carry
  multiple tags, but **the first/primary tag determines the physical
  location** (one place, no symlink/duplicate); other tags are pure search metadata
- Classification/synthesis via LM Studio (local OpenAI-compatible API), no
  fixed model
- Interactive requests (capture, chat) always take priority over background jobs

## Tech Stack
Electron + Angular/TypeScript, CodeMirror 6 (editor), chokidar (file
watching), transformers.js (embeddings), sqlite-vec (vector search), LM
Studio (LLM backend), Electron Builder (packaging).

---

## Phase 1 — MVP

**Goal: usable day to day, smallest viable feature set**

- Quick-capture: a global hotkey brings the main window forward and opens
  today's daily note (`daily/YYYY-MM-DD.md`) in the editor, appending a
  fresh `## HH:mm` entry to type into. No separate popup window — capture
  happens in the full editor, so inline `#tag` autocomplete (from the
  existing tag vocabulary, see routing below) and the source/rendered
  toggle are all there.
- Note templates: a `templates/` folder in the vault holds Markdown
  templates with `{{date}}` / `{{time}}` / `{{datetime}}` / `{{title}}`
  placeholders. `templates/daily.md` seeds new daily notes and is
  scaffolded with a starter layout on first use; editing it changes how
  future daily notes look. The same substitution mechanism seeds files
  created by tag routing.
- Deterministic routing: a known tag → target file/folder is fixed, no LLM
  call needed. A new tag (first occurrence) → one-time short confirmation
  on whether a dedicated folder makes sense, automatic afterwards
- LLM classification only as a fallback: task vs. note detection, and for
  blocks with no tag at all (see batch review) — a small local model (e.g.
  Qwen3-4B / Gemma3-4B), dedicated and separate from benchmarking models
- Dynamic folder structure: one master document per tag (`art`: topic,
  person, team, project, or term), which is both classifier context and
  glossary content at once — once a tag outgrows a single file, the master
  document becomes the folder's index, further notes sit alongside it
- Tag overview: a browsable list of all tags (same index used for
  autocomplete), clicking one opens its master document — replaces the
  separate glossary concept originally planned for Phase 3
- Summary in the master document: manual button, recency-weighted (last 7
  days/N entries in full, older entries compressed or dropped), `#important`
  marker for entries that should survive regardless of age
- Batch review (inbox): tag-less blocks get LLM tag suggestions as chips on
  click (hover to delete/edit, click to confirm); also holds externally
  created files with no frontmatter — reviewed at leisure, no interruption
- A single vault (no switching, no sensitive/general separation yet)
- Editor: CodeMirror 6, source/rendered view via tab switch (no live
  preview), click-to-edit. Optional **auto-switch mode** (off by default,
  a persisted per-machine preference): the rendered view keeps its own
  caret and no longer switches on a click — the first character typed is
  what drops into source (at the matching source offset), and Ctrl+S
  returns to the rendered view at the same spot. Still a tab switch, not
  live preview; the source↔rendered position sync is best-effort
  (character-precise for prose/headings/fenced code). See
  [ADR-0004](../docs/09_architecture_decisions/0004-auto-switch-editor-mode.md).
- Chat input at the bottom, scope "this document" (editor buffer goes
  straight into the prompt, no RAG needed)
- Keyword search (SQLite FTS or simple text search over the files)
- File watcher (chokidar): distinguishes frontmatter-only change vs.
  body change vs. new external file; autosave conflict at minimum surfaces
  as a warning with "keep mine / take external version"
- Daily tasks: inline `#task` syntax in any note file, a generated
  (read-only) day view built from timestamp scanning — distinct from the
  daily note above (that is a normal editable file; this is an aggregate view)

**Before Phase 1, as a separate step, not blocking coding:**
Manually classify 20–30 real example captures, test the chosen small model
against them, before the inbox confidence threshold gets hardcoded.

---

## Phase 2
- Semantic search (embeddings via transformers.js + sqlite-vec, RAG for the
  "all notes" chat scope)
- Daily wrap-up (yesterday done/worked-on, prioritized list for today) —
  triggered by date rollover, not by app start (the app may run continuously in the tray)
- Spell check: Electron's native spellchecker, dictionary fed from file
  titles/`aliases`, flagging only, no auto-correct

## Phase 3
- Multi-vault (primary purpose: separating sensitive content — personnel
  topics, interviews — from general notes), a fixed default vault, manual
  switch before capture
- Optional cross-vault search mode (default: scoped per vault)
- Image paste (editor + quick-capture popup), stored in a global `assets/`
  folder, a dedicated Electron protocol for safe rendering, no auto-caption

## Phase 4 — Experiments
- Interview mode: templates with starter questions, the model drafts
  adaptive follow-up questions, text-only, result feeds into the normal
  classification pipeline (primarily lands in the sensitive vault)
- Task center: an active, writable task overview across all files
  (checking a box here writes back to the source file, needs stable task
  IDs instead of line numbers)
- Job queue: configurable background processes (re-indexing after a model
  change, batch reclassification of the inbox, export), status/progress,
  persisted against crashes, auto-pauses on interactive use

## Future Scope (noted, no target date)
- OCR for handwritten notes (iPad expansion stage, Apple Vision Framework
  or local Tesseract)
- iPad/iPhone access via Tailscale to the PC backend
- Audio recording in interview mode (local Whisper)
- Automatic image captioning via a vision model (classification/search)
- Editor live preview (true Obsidian-style inline rendering instead of tab switch)

---

## Open Risks / Undecided Details
- Autosave-vs-watcher conflict: concrete UX not yet defined (diff view?
  conflict copy? undo?)
- Model contention: classifier/embeddings vs. benchmarking models in LM
  Studio — needs an availability check before every call
- Folder sprawl from LLM suggestions: inbox review acts as a brake, but no
  guarantee against near-duplicates (e.g. "sailing" vs. "boat")
- Structural folders (`daily/`, `templates/`) are not topic folders — tag
  routing and LLM folder proposals must skip them
