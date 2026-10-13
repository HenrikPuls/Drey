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
  assistant's `web_fetch` / external MCP servers. A `copilot-web` provider
  was prototyped but never merged (see `decisions.md`).
- Interactive requests (capture, chat) always take priority over
  background jobs.

## Tech Stack

Electron + Angular/TypeScript, CodeMirror 6 (editor), transformers.js
(embeddings, WASM-only; brute-force cosine over a JSON index per vault,
ADR-0055 — no sqlite-vec), OpenAI-API-compatible backend (LLM backend), Electron Builder (packaging).
No file watcher by default — vault is re-read on demand; opt-in chokidar
watcher for external changes (ADR-0045).

---

## Roadmap

Open work only. Everything implemented lives in
[`changelog.md`](changelog.md); everything decided against or excluded
lives in [`decisions.md`](decisions.md). When an item ships, move it to the
changelog and delete it here — no shipped history on this page.

**Status (2026-10-13):** version 0.6.0, milestones 1–74 and 76–79
shipped. Milestone ids are assigned when work starts — check
`changelog.md` for the highest used (latest: milestone 79; milestone 75
is assigned to "Configurable shortcuts" below; latest requirement id: req-42, the Cyberpunk app mark —
an owner request outside the list, shipped in the same step).
Items A1–A5 of the architectural cleanup shipped on 2026-10-13
(changelog); A6–A12 remain.

### Known defects

(none known)

### Now (small, daily value)

The assistant tool rework (owner request, outside the list, 2026-10-13)
shipped as milestones 76–79 — see the changelog; all four await the
owner's verification.

3. **Configurable shortcuts (milestone 75).** One user-defined binding
   per command, stored locally in the app config (never in the vault).
   `KeybindingService` has no override layer today. Decided with the owner
   (2026-10-13): rebindable are every command in the registry (core and
   plugin) **and** the global quick-capture hotkey (`electron/main.ts`
   anticipates it); the editor's own keys (CodeMirror keymap, Tab, zoom,
   plugins' raw key handlers) stay fixed and are listed as fixed. A chord
   another command holds is shown with its holder and a **Replace** that
   leaves the other command without a shortcut; chords the editor or
   Electron needs are refused. Needs an ADR; the palette, the menus and
   the generated shortcuts page (ADR-0067) follow the registry.

### Next

6. **Zen mode.** A focused, chrome-free writing/reading view (docks,
   titlebar and status bar hidden, one toggle). F11 full screen exists
   (`window.toggleFullScreen`); this is a separate layout mode.
~~7. **Screenshots in the app.** Capture a region or window and embed it
   as an attachment (`attachments/`, ADR-0024). ⚠️ Scope open: whole
   window, region, or another application's window.~~
8. **Auto-update + code signing.** The installer is unsigned and there is
   no update channel (`docs/11`). Only worth it if Drey is handed to
   others — ⚠️ owner decision.
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
- **Due-date reminders.** The `📅` date is parsed and sortable, but nothing
  notifies.
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
value for effort. A1–A5 are done (see `changelog.md`); the ids of the
rest are kept so they still match `docs/11`.

- **A6 — Plugin settings out of the base config.** `AppConfig` holds
  `actions`, `templates`, `entry` and the plugins' built-in prompt texts.
  Rule from now on: a new plugin setting goes into the plugin's own
  config. Moving the existing slices changes the settings file —
  ⚠️ owner decision, later change to ADR-0010.
- **A7 — One generic service registry between plugins.** Three provider
  slots (section search, semantic search, task query) were each added to
  the base by hand, and the host names the assistant
  (`assistantToolbox`, `tagSuggester`, `origin: 'assistant'`). Before a
  fourth provider: a typed `provide` / `get` registry in the SDK.
  ⚠️ Needs an ADR; a real alternative, not a refactoring.
- **A8 — Large modules, when next touched.** `markdown-surface.ts`,
  `vault-manager.ts` (vault registry apart from file operations; delete
  the sidecar plumbing), `dock.service.ts`, the assistant's
  `renderer/state.ts` and `main/semantic/service.ts`. No milestone of its
  own.
- **A9 — Make `docs/05` and `docs/06` readable.** Move the
  milestone-by-milestone record (§5.1–§5.40) into an archive file and
  group the 57 runtime flows by topic. Changes section numbers that
  `CLAUDE.md` and the ADRs link to — ⚠️ owner decision.

Follow-ups of A1–A5 (found on the way, none started):

- **A10 — Typecheck the plugin specs.** `plugins/**/*.spec.ts` belongs
  only to the root `tsconfig.spec.json`, which no CI step compiles: the
  Node suite runs the specs without checking types. Six type errors sit
  in `plugins/assistant/main/chat-engine.spec.ts` (older than A1). Fix
  them and add the project to CI, or give the plugin specs a project of
  their own.
- **A11 — Check for import cycles in CI.** A3 removed the two renderer
  cycles and none exist in `electron/`, `shared/` or `plugins/`, but
  nothing stops a new one. A small script over the import graph (or
  `import/no-cycle`) as a lint step.
- **A12 — Tests for the split composition root.** `buildAppServices`
  (`electron/app-services.ts`), `MainWindowHost` and the
  `plugin-context.ts` builders can now be constructed on their own; only
  the end-to-end suite covers them so far.

### Needs an owner decision

- **Should the daily template follow `templates.dir`?** The daily note
  is seeded from the literal `templates/daily.md`, also when the template
  library folder (`templates.dir`) points elsewhere. That is what
  `frontmatter-schema.md` and the manual describe, so it is not a defect
  (checked for A4). Following the setting would need a migration for
  vaults whose edited `templates/daily.md` would otherwise be ignored.
  Proposed: leave as is.
- **Bookmark management and sync** (browser tab, ADR-0042 has none).
  Proposed: drop — scope creep for a Markdown hub; the web clipper covers
  the real need.
- **Routing to to-dos** ("seamless transitions between content and
  tasks"). Too vague to build. The assistant is already the task and
  navigation surface (milestone 57); Jira is excluded. Specify or drop.
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
- **Req-29 remainder** — `copilot-cli` (GitHub Copilot CLI, `-p`) not on
  main; id unrouted in `electron/llm/providers/presets.ts`.
- **Req-22 remainder** — context-menu "add meeting log" + per-day
  appointment picker; needs a live calendar source.
- **Shared note parse for the per-vault indexes** — tags, tasks,
  backlinks and the semantic index each scan every `.md` on their own;
  only worth it once a large vault makes refresh slow.

### Follow-ups of shipped milestones (none committed)

- **Milestone 63 (MCP, ADR-0063):** OAuth-protected servers, handing
  servers to the Claude Code CLI provider, MCP resources / prompts.
- **Milestone 76 (tool loop, ADR-0071):** streaming the answer of a
  request that carries tools (today it arrives in one piece; the panel
  shows the tool calls meanwhile); the abort signal for plugin and vault
  tools (a cancel waits for the tool call in flight); private-address
  guard for `web_fetch`; the synthetic `tasks_list` call of the post-hoc
  task block is replayed to the model as a call it made.
- **Milestone 77 (vault toolset, ADR-0071):** moving a note across
  vaults; deleting a folder; a per-call cache of file contents when one
  search reads a large vault; `tasks_list` and the template tools for a
  vault other than the active one.
- **Milestone 79 (web search, ADR-0063):** a key per search provider
  (switching the provider clears the one key); a config-change event for
  plugins, so the Web chip follows Settings at once instead of when the
  pointer or the focus returns to the composer; the private-address
  guard of milestone 76 for `web_search`'s SearXNG address too; the
  DuckDuckGo page reader breaks when that page changes — watch it.
- **Milestone 78 (open note through the tools, ADR-0071):** the
  confirmation of a tool change still opens while the ask is cancelled
  (the abort signal does not reach the vault tools, see milestone 76);
  an edit of a chat note or of a file opened from outside the vaults
  keeps the whole-document reply form (and such a file cannot be
  live-edited); the tag and semantic search of
  `vault_search` / `vault_retrieve` read their indexes, not unsaved
  buffers; several attached files as edit targets.
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
