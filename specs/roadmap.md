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
  by default** (ADR-0047): `copilot-web` (Req-3/req-15, ADR-0040), the
  hosted presets (`openrouter`, `anthropic`, `zai-glm`), and Claude
  Code/GitHub Copilot CLIs — all behind the req-29 provider abstraction.
- Interactive requests (capture, chat) always take priority over
  background jobs.

## Tech Stack

Electron + Angular/TypeScript, CodeMirror 6 (editor), transformers.js
(embeddings, WASM-only; brute-force cosine over a JSON index per vault,
ADR-0055 — no sqlite-vec), OpenAI-API-compatible backend (LLM backend), Electron Builder (packaging).
No file watcher by default — vault is re-read on demand; opt-in chokidar
watcher for external changes (ADR-0045).

---

## Not yet implemented

Everything implemented lives in [`changelog.md`](changelog.md). When an
item below ships, move it there and remove it from this list. When work
starts on an item without an id, assign the next free one.

### Next milestones (priority order)

⚠️ Milestone ids: req-35 went to the Task Center (implemented as
milestone 44, then **reverted before release** — see the closed item
below and changelog.md); req-36 to the Autotag re-homing (shipped).
Check changelog.md for anything higher before assigning a new id
(req-40 went to the Git vaults, milestone 65).

Order set on 2026-10-10 after the milestone 33–58 verification round.
(Its first two items shipped: link update on rename + quick switcher /
command palette as milestone 59, the conflict dialog + local note
history as milestone 60. The 2026-10-10 startup work followed: analysis
+ speed as milestone 61, the splash window as milestone 62. Then Req-31,
the MCP client with the assistant's tool groups, as milestone 63,
req-19, draw.io diagrams, as milestone 64, and — on an owner request
outside the list — Git vaults (req-40) as milestone 65. Its last item,
the Req-2 Office remainder, shipped as milestone 66 — not as rendering:
Office documents open in their own program, ADR-0066. On a further owner
request the Git plugin followed with milestone 67: merge, stash, amend,
commit and push, file history.)

Nothing is ordered at the moment; the next item is the owner's pick from
the backlog below.

Follow-ups of milestone 66 (ADR-0066), none committed: rendering Office
documents in a tab (a plugin on the milestone-64 file-opener seam),
"Open in default program" for other file types in the Files panel's
context menu, a setting for the default drop behaviour (copy or link).

Follow-ups of milestone 64 (ADR-0064), none committed: a dirty state /
manual save for plugin tabs, "New diagram" in the Files panel's context
menu, converting a diagram between SVG and PNG, embedding a plain
`.drawio`, letting the assistant read a diagram.

Follow-ups of milestone 63 (ADR-0063), none committed: OAuth-protected
MCP servers, a per-question tools switch in the composer, handing the
configured servers to the Claude Code CLI provider, MCP resources /
prompts.

Follow-ups of milestone 65 (ADR-0065), none committed: clone a
repository as a new vault, a rebase / cherry-pick surface, staging
parts of a file, showing dotfiles such as `.gitignore` in the tree.
(Stash, merge with a conflict surface, amend, commit and push and the
per-file Git history shipped as milestone 67.)

Not ordered: **Semantic Search, remaining slices** — the core shipped as
milestone 41 / ADR-0055 (the assistant's Vault chip: top-k section
retrieval via transformers.js WASM + a JSON index per vault; sqlite-vec
was dropped — see the ADR for why). The remaining slices — semantic
hits in the Search panel and a semantic MCP `vault_search` mode —
shipped as milestone 68 over a new base `SemanticSearchProvider` seam
(ADR-0055 later change); pause / resume of large rebuilds was
considered and dropped (an ask queues behind at most one embed batch,
never a rebuild — see "Closed" below).

Outside the list, on an owner request: **the dock icon strip** shipped as
milestone 69 (ADR-0019 later change) — one icon row per dock replaces the
collapsed panel headers.

### Closed (won't do)

- **Pause / resume of large semantic rebuilds on interactive use** —
  considered for milestone 68 and dropped: an interactive ask never
  waits for a rebuild (the query embed queues behind at most one
  16-passage batch — tens of ms — then searches the current index),
  and the actual gap (a mid-rebuild index is incomplete) is not fixable
  by pausing. Recorded in ADR-0055's later-change section.

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

### Feature requests (backlog, unordered)

- **Req-6** — further CodeMirror 6 themes on demand (bundled set + `@uiw`
  themes ship since milestone 16).
- **Req-18** — flow descriptions / agentic workflow automation
  ("Description => Sebastian => Peter", "Description => Jira").
- **req-12** — automatic image captioning via a vision model.
- **req-13** — footnote rendering in Live Preview (needs a custom Lezer
  extension). (`Ctrl`-click for external links shipped as Req-5, wikilinks
  as req-20.)
- **req-27** — review internal prompts (partial: ask protocol reworked in
  milestone 31, ADR-0053).
- **Math (KaTeX) and callouts in Live Preview** — neither renders today
  (Mermaid does). PDF-export parity applies (changelog standing rule).
- **Due-date reminders** — the `📅` date is parsed and sortable, but
  nothing notifies.
- **Web clipper** — save the browser tab's page as a Markdown note.
- **Auto-update + code signing** — the installer is unsigned and there is
  no update channel (`docs/11`).
- **API keys out of plain text** — hosted-preset keys sit unencrypted in
  `app-config.json` (`docs/11`, technical debt).
- **Shared note parse for the per-vault indexes** — tags, tasks,
  backlinks and the semantic index each scan every `.md` on their own;
  only worth it once a large vault makes refresh slow.

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
  it bites. A dirty tab no longer wins silently: the save asks
  (milestone 60, ADR-0060).
- Model contention: assistant usage vs. parallel benchmarking runs —
  needs an availability check before every call.
- Tag sprawl: no near-duplicate detection (`sailing` vs. `boat`).
  Autotagging biases toward existing vocabulary; the rename/merge tool
  (milestone 53) allows consolidating by hand — detection stays missing.
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