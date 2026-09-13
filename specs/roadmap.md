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
  folders on a tag's behalf. Nested tags (`#project/frontend`) are a label
  hierarchy — a naming convention, still not folders (ADR-0017).
- Classification/synthesis via a **local** OpenAI-compatible API, no fixed
  model. Unsloth Desktop is the default; any server speaking that dialect
  works (Unsloth Desktop, llama.cpp, vLLM, Ollama, LM Studio), with an
  optional bearer API key for the ones that require auth. Cloud calls are
  **documented, opt-in exceptions only, each off by default** (ADR-0047):
  the removable `copilot-web` provider (Req-3 / req-15, ADR-0040), which
  drives Microsoft Copilot's website through browser automation, and the
  hosted provider presets (`openrouter`, `anthropic`, `zai-glm`) plus the
  Claude Code / GitHub Copilot CLIs behind the req-29 provider
  abstraction. The local OpenAI-compatible endpoint stays the default.
- Interactive requests (capture, chat) always take priority over
  background jobs.

## Tech Stack

Electron + Angular/TypeScript, CodeMirror 6 (editor), transformers.js
(embeddings, Phase 2), sqlite-vec (vector search, Phase 2),
OpenAI-API-compatible backend (LLM backend), Electron Builder (packaging).
No file watcher by default — the vault is re-read on demand (see "Manual
refresh" below), with an opt-in chokidar watcher for external changes
(ADR-0045).

---

## Not yet implemented

Everything implemented lives in [`changelog.md`](changelog.md). When an
item below ships, move it there and remove it from this list.
Once you start working on one of the feature requests and it didn't had a Id then please assign the next one.

### Feature requests

- **Req-2** — render Office documents inline: Word, Excel, PowerPoint,
  PDF and Loop components. Insert a link that opens the document inline;
  dragging a document directly places it in the `attachments/` folder.
  (Effort to be discussed before implementation.)
- **Req-3 / req-15** — `copilot-web` provider: drive Microsoft 365
  Copilot's website via Playwright + system Edge as an LLM provider.
  Prototyped on branch `feat/copilot-web-provider` (ADR-0040) — fragile
  PoC, URL / selectors / timing editable in Settings. Unmerged; tracked
  with the Req-29 remainder below.
- **Req-17** — Jira integration: when a ticket link is inserted into a
  document, fetch its current status on load and render it inline with the
  text; plus the ability to create new tickets directly.
- **Req-6** — download further CodeMirror 6 themes on demand (a bundled
  set — the Drey look plus the published `@uiw` themes — ships since
  milestone 16).
- **Req-18** — flow descriptions / agentic workflow automation:
  "Task Description => Sebastian => Peter" (prepare a task, send it to
  Sebastian to discuss with Peter), "Description => Jira" (create a ticket
  from the description, return the new ticket's link).
- **req-9** — OCR remainder (iPad expansion stage): handwriting
  recognition on the tablet itself (Apple Vision Framework or local
  Tesseract). The **desktop half has shipped** — the `ocr` plugin
  transcribes embedded images / image tabs via the connected
  vision-capable LLM (ADR-0050, a deliberate deviation from the
  Tesseract idea). An "OCR drop field" that batch-processes dropped
  images stays parked.
- **req-10** — iPad/iPhone access via Tailscale to the PC backend.
- **req-11** — audio recording in interview mode (local Whisper; Windows
  integrated speech-to-text via Win+H as the likely first step).
- **req-12** — automatic image captioning via a vision model.
- **req-13** — editor: footnote rendering in Live Preview (needs a custom
  Lezer markdown extension); `Ctrl`-click to open concealed link targets.
- **req-16** — PDF export.
- **req-19** — integrate draw.io view and edit.
- **req-21** — dataview.js support.
- **Req-31** — MCP client: connect the app TO external MCP servers
  (`@modelcontextprotocol/sdk`, stdio + Streamable-HTTP transports),
  configured in an `mcpServers` config slice; their tools join the vault
  tools in one provider-neutral tool pool (namespaced
  `mcp__<server>__<tool>`), confirmation-gated per server. Builds on the
  Req-29 interface — every tool-capable provider can drive them.

  UX:
  Req - Editor - Lines shall only display the picture but no text, same for save please use a save symbol instead.
  Req - Files - If the mouse hovers over the file the tooltip shall display the whole path and name of the file
  Req - Assitant - the text shall automatically scroll when new text is received from the assistant.
  Req - Assistant - Use image for new text instead of text.
  Req - Assistant - Remove auto summary
  Req - Assistant - The assistant shall be bound to an open document, so when you change the document you will
  automatically get a new chat. If you switch back to another docuemtn, you will get the chat of that document.
  Of course I can add other files from the vault to the context.
  Req - Look at the internal prompts and review them

### Known-defect remainder

None open. bug-10(a) (payload validation) was fixed in milestone 23;
bug-10(b) (tool calls/results and applied-edit content never persisted,
the ~12-message history cap) resolved with Req-30's chat notes in
milestone 25 — see the changelog.

### Partials — the shipped half is in the changelog

- **Req-29 remainder** — the **`copilot-cli`** provider (GitHub Copilot
  CLI, `-p`) and the **`copilot-web`** routing (Req-3/req-15) are not on
  main; both ids stay unrouted in `electron/llm/providers/presets.ts`.
  Shipped: the abstraction itself, the local OpenAI-compatible provider,
  the hosted presets (OpenRouter / Anthropic API / Z.ai GLM), the
  Anthropic-Messages client and the Claude Code CLI provider.
- **req-22 remainder** — the context-menu **"add meeting log"** entry and
  the per-day **appointment picker** (the one covering the current time
  preselected; picking one inserts the meeting documentation). Needs a
  live calendar source, not just a dropped file. Shipped: `.ics`/`.msg`
  drag-and-drop and File → Import meeting (ADR-0041).

### Phase 2 leftovers

- Dedicated keyword search / FTS index — a standalone SQLite FTS index
  over whole files; the free-text mode of tag search covers the common
  case over section text and headings.
- Daily tasks day view — a generated (read-only) aggregate view built from
  timestamp scanning, distinct from the editable daily note file. (The
  task-collection + tick-back part shipped early as the Tasks panel.)
- Semantic search — embeddings via transformers.js + sqlite-vec, RAG for
  the "all notes" chat scope.
- Daily wrap-up — yesterday done/worked-on, a prioritized list for today;
  triggered by date rollover, not by app start.

### Phase 4 leftovers

- Interview mode — templates with starter questions, the model drafts
  adaptive follow-up questions, text-only, result feeds into the normal
  processing pipeline (primarily lands in the sensitive vault).
- Task center — the active, writable cross-file task overview with stable
  `#task id:` addressing instead of line numbers (the Tasks panel writes
  back by line number today).
- Job queue — configurable background processes (re-indexing after a model
  change, export), status/progress, persisted against crashes, auto-pauses
  on interactive use.

---

## Open Risks / Undecided Details

- Stale view with the watcher off: an external tool changing vault files
  is not noticed until the next manual refresh. Acceptable for a
  single-user, single-machine tool; the opt-in watcher (req-14,
  ADR-0045) covers it when it bites. With the watcher on, a *dirty* open
  tab still wins over an external change on save (last-writer-wins; no
  conflict dialog).
- Model contention: assistant usage vs. any benchmarking models running
  in parallel — needs an availability check before every call.
- Tag sprawl: nothing prevents near-duplicate tags (`sailing` vs.
  `boat`). Autotagging biases toward reusing existing vocabulary, but the
  user can always type a fresh tag, and there is no merge/alias tool yet.
- Very large vocabularies: the autotag prompt embeds the full tag list.
  Fine for tens to low hundreds of tags; a pre-filter step would be
  needed well beyond that (see `classifier-spec.md`).

---

## Won't do (decided against, kept for the record)

req-24 Editor, the Lines On shall just contain the image but not text an ylonger
  → Dropped after inspection (2026-09-12): the Live Preview image embed
    already renders as the image only while the caret is elsewhere; the
    caret-in / `</>` reveal of the raw `![alt](path)` line (with the
    rendered picture kept below, Req-1) is the intended editing affordance.

req-25 Editor written status informations like unsaved draft or Saved shall be removed. I opt to go the way of saving all changes to the document, so that it is guaranteed that they are stored.
  → Decided against (2026-09-12): we stay with **manual save** (Ctrl+S /
    Save button). An autosave design was drafted and shelved.

req-26 frontmatter needs to be updated on save
  → Dropped after inspection (2026-09-12): already implemented exactly as
    specified — `note:save` bumps `updated:` and fills `created:` whenever
    the file has a frontmatter fence, and fence-less files are written
    back byte-for-byte (the app never adds a header that wasn't there,
    `specs/frontmatter-schema.md`).
