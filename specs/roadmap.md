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
  fixed model (Unsloth Desktop default; llama.cpp/vLLM/Ollama/LM Studio
  also work). Cloud calls are **documented, opt-in exceptions, each off
  by default** (ADR-0047): `copilot-web` (Req-3/req-15, ADR-0040), the
  hosted presets (`openrouter`, `anthropic`, `zai-glm`), and Claude
  Code/GitHub Copilot CLIs — all behind the req-29 provider abstraction.
- Interactive requests (capture, chat) always take priority over
  background jobs.

## Tech Stack

Electron + Angular/TypeScript, CodeMirror 6 (editor), transformers.js
(embeddings, Phase 2), sqlite-vec (vector search, Phase 2),
OpenAI-API-compatible backend (LLM backend), Electron Builder (packaging).
No file watcher by default — vault is re-read on demand; opt-in chokidar
watcher for external changes (ADR-0045).

---

## Not yet implemented

Everything implemented lives in [`changelog.md`](changelog.md). When an
item below ships, move it there and remove it from this list. When work
starts on an item without an id, assign the next free one.

### Next milestones (priority order)

⚠️ Neither item below has an id assigned yet — the highest visible id in
this file is req-34/Req-34, but changelog.md may already use higher
numbers I can't see. Check there before assigning req-35/req-36 (or
whatever's next).

1. **Semantic Search** — embeddings via transformers.js + sqlite-vec,
   wired into the "all notes" chat scope (RAG). Reindexing runs as a
   scoped async background step (progress, crash-persisted, pauses on
   interactive use) — sized for this one consumer only. Do not build a
   generic Job Queue subsystem yet (see Excluded ideas).
2. **Task Center** — stable `#task id:` addressing; migrate the Tasks
   panel's write-back from line-number to id-based. Closes the silent
   mis-tick risk when a task's line number shifts between scan and
   write-back.

### Feature requests (backlog, unordered)

- **Req-2 (remainder)** — render Office documents inline (Word, Excel,
  PowerPoint, Loop). PDF slice shipped (milestone 30, ADR-0052: drag-in
  → `attachments/` → built-in viewer); PDF export also shipped (req-16).
  Office formats remain unrendered. (Effort TBD.)
- **Req-6** — further CodeMirror 6 themes on demand (bundled set + `@uiw`
  themes ship since milestone 16).
- **Req-18** — flow descriptions / agentic workflow automation
  ("Description => Sebastian => Peter", "Description => Jira").
- **req-12** — automatic image captioning via a vision model.
- **req-13** — footnote rendering in Live Preview (needs a custom Lezer
  extension). (`Ctrl`-click for external links shipped as Req-5, wikilinks
  as req-20.)
- **req-19** — draw.io view/edit integration.
- **req-27** — review internal prompts (partial: ask protocol reworked in
  milestone 31, ADR-0053).

### Announced follow-ups

- **M-B remainder** (milestone 28, ADR-0051) — multi-vault round three,
  tasks side: per-vault tasks index, tasks panel "all vaults" scope.
  (Search halves shipped in milestone 33.)

### Known-defect remainder

(none currently)

### Partials — shipped half is in the changelog

- **Req-29 remainder** — `copilot-cli` (GitHub Copilot CLI, `-p`) and
  `copilot-web` routing (Req-3/req-15) not on main; ids unrouted in
  `electron/llm/providers/presets.ts`. Shipped: the abstraction, local
  OpenAI-compatible provider, hosted presets, Anthropic-Messages client,
  Claude Code CLI provider.
- **req-22 remainder** — context-menu "add meeting log" + per-day
  appointment picker; needs a live calendar source. Shipped:
  `.ics`/`.msg` drag-and-drop, File → Import meeting (ADR-0041).

## Excluded ideas

- **Req-3/req-15** — `copilot-web` provider (Playwright + system Edge
  driving M365 Copilot's website). Prototyped, unmerged
  (`feat/copilot-web-provider`, ADR-0040) — fragile PoC. Tracked with the
  Req-29 remainder above.
- **Req-17** — Jira integration: inline live ticket status, create
  tickets from the editor.
- **req-9** — OCR remainder (iPad): on-device handwriting recognition.
  Desktop half shipped (`ocr` plugin, vision-capable LLM, ADR-0050).
- **req-21** — dataview.js support.
- **req-10** — iPad/iPhone access via Tailscale.
- **req-11** — audio recording in interview mode (local Whisper; Win+H
  as likely first step).
- **Req-31** — MCP client (connect Drey to external MCP servers).
  Builds on the Req-29 interface once that exists.
- **Job Queue (generic, multi-consumer)** — background processes with
  status/progress, crash persistence, auto-pause on interactive use,
  meant to cover both re-indexing and export. No second consumer exists
  yet; a scoped version ships inside the Semantic Search milestone
  instead. Revisit as a standalone subsystem once export (or similar)
  needs it too.
- **Dedicated keyword search / FTS index** — free-text tag search already
  covers the common case; no evidence it's a bottleneck.
- **Daily tasks day view** — read-only multi-day aggregate; Tasks panel
  already covers collection + tick-back. Only useful if tasks end up
  scattered across many notes instead of daily notes.
- **Daily wrap-up** — automation convenience on existing data, no
  structural gap.
- **Interview mode** — templated adaptive interviews; real prompt-design
  effort, no confirmed usage pattern yet.

## Open Risks / Undecided Details

- Stale view with the watcher off: external file changes go unnoticed
  until manual refresh. Opt-in watcher (req-14, ADR-0045) covers it when
  it bites. With the watcher on: dirty open tab still wins over an
  external change on save (last-writer-wins, no conflict dialog).
- Model contention: assistant usage vs. parallel benchmarking runs —
  needs an availability check before every call.
- Tag sprawl: no near-duplicate detection (`sailing` vs. `boat`).
  Autotagging biases toward existing vocabulary; no merge/alias tool yet.
- Very large vocabularies: autotag prompt embeds the full tag list — fine
  to low hundreds, needs a pre-filter beyond that (see
  `classifier-spec.md`).

---

## Won't do (decided against, kept for the record)

**req-24** — Editor: image lines should show only the image, no text.
→ Dropped (2026-09-12): Live Preview already renders image-only outside
  the caret; caret-in reveals the raw `![alt](path)` line by design
  (Req-1).

**req-25** — Remove "unsaved"/"saved" status; always persist changes.
→ Decided against (2026-09-12): staying with manual save (Ctrl+S/Save
  button). Autosave design drafted and shelved.

**req-26** — Frontmatter must update on save.
→ Dropped (2026-09-12): already implemented — `note:save` bumps
  `updated:` and fills `created:` when a frontmatter fence exists;
  fence-less files stay byte-for-byte (`specs/frontmatter-schema.md`).