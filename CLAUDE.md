# Drey — your private AI knowledge vault — Project Context for Claude Code

## Overview

Local, topic-based note-taking app (Electron + Angular). Full concept,
data schema, and classifier design live in `specs/`:

- `specs/roadmap.md` — overall concept, phases, open risks
- `specs/frontmatter-schema.md` — file/frontmatter format
- `specs/classifier-spec.md` — LLM prompts for task/note detection and tag suggestions

Read these three files before making a first proposal — they are the
binding specification, not just background reading.

## Language Convention

- Code, comments, identifiers, file/folder names, commit messages: **English**.
- **Everything the UI displays is English.** Every string a user can read on
  screen: labels, buttons, placeholders, headings, settings category names,
  hints, empty states, error and status messages, `title`/`aria-label`
  attributes, native Electron dialog titles and text, and the _names_ of
  built-in Action templates. No exceptions, including for features whose
  content is German — a German mockup or a German feature request is a
  description of the layout and behaviour, **not** an instruction to write
  German labels. Translate them.
- Content the user actually writes into vault files at runtime (notes,
  tags, entry text) stays **German** — that's user data, not a code
  artifact, and is out of scope for this convention.
- LLM prompt templates (system prompts sent to the local model) are
  **English too**, like all other code — `specs/classifier-spec.md` and
  `shared/app-config.ts`. The model is only ever asked for a structured
  JSON verdict, so matching the German note content buys nothing; the
  earlier "keep prompts German" exception was dropped in milestone 12.1.

## Toolchain — no global Node

There is **no global `node`/`npm` on PATH** (neither in PowerShell nor in a
Bash shell). A portable Node lives at `.tools/node/` (gitignored, so the
toolchain is removable by deleting `.tools/`). Never assume a bare `node`,
`npm`, `npx`, `ng`, `tsc` or `vitest` command works.

- PowerShell, per session, from the repo root: `. .\env.ps1`
- Any checkout or worktree, one command: `.\dev.ps1` — bootstraps
  `.tools/` (junction into the source checkout's vendored Node) and
  `node_modules/` (`npm ci`) when missing, then runs `npm run dev`;
  `.\dev.ps1 -Built` runs `npm run app` instead — always a fresh
  production build, then the packaged-style app from `dist/` (no dev
  server, no port 4200, no DevTools); `.\dev.ps1 -Multi` (combinable)
  opts out of the single-instance lock (`DREY_MULTI_INSTANCE=1`, see
  the lock in `electron/main.ts`) so parallel checkouts run side by
  side for checking several agent outputs — they share one userData /
  one set of settings (config/session = last writer wins); the lock
  holder keeps the quick-capture hotkey
- Bash: `export PATH="$PWD/.tools/node:$PATH"`, then invoke tools **by
  script path**, not by bin-shim name:
  - Typecheck main + shared: `node node_modules/typescript/bin/tsc -p electron/tsconfig.json --noEmit`
  - Typecheck renderer: `node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit`
  - Unit tests: `node node_modules/@angular/cli/bin/ng.js test --watch=false`
    (add `--include "src/.../x.spec.ts"` to scope it)
  - Production renderer build: `node node_modules/@angular/cli/bin/ng.js build --configuration production`
  - Emit the main process: `node node_modules/typescript/bin/tsc -p electron/tsconfig.json`
- VS Code tasks and debug configs don't inherit `env.ps1`; `.vscode/` works
  around that three ways (see `docs/11`, "Environment gotchas").
- **`npm run dev` builds `dist-electron/` only once, at startup** (the
  `dev:electron` leg runs `tsc` *and* `build:plugins` then starts
  Electron), while `ng serve` hot-reloads the renderer forever. Since
  `shared/` compiles into both contexts, touching `shared/` or
  `electron/` leaves the two sides disagreeing about the IPC contract _at
  runtime_ even though `tsc` is clean — fields the stale main process
  doesn't know get silently stripped from IPC payloads. The same applies
  to plugins: touching `plugins/**` or `shared/plugin-api/**` leaves the
  running app on the previously built `dist-electron/plugins/<id>/` — a
  changed renderer module 404s or misbehaves until rebuilt. After any
  such change, rebuild and restart Electron; verify with
  `grep <new-symbol> dist-electron/plugins/<id> -r` (and
  `grep <new-field> dist-electron/shared/*.js` for base IPC).

## Architecture & Design Decisions

- Electron main/renderer split. No Node integration in the renderer — all
  filesystem and LLM access goes through a `contextBridge` IPC boundary.
- No server/backend process. A vault is just a folder on disk (can live on
  OneDrive); the app reads/writes files directly, no client-server split.
- Editor: CodeMirror 6 in the renderer, extended via Compartments. Plugins
  compose editor extensions from the **host's** CM module instances
  (`api.editor.cm`), never their own runtime copy (ADR-0044 rule 1).
- Storage format: plain Markdown + YAML frontmatter. No proprietary format,
  no database as source of truth (see `specs/frontmatter-schema.md`).
- Folder structure is the user's own — the app imposes only `templates/`,
  `daily/` (the daily-notes root is configurable, `daily.dir`, default
  `daily/`), `chats/` (assistant conversation notes, ADR-0048, indexed
  like `daily/`), and the hidden `.drafts/` (bug-5's exit-time auto-saves of
  untitled tabs, Notepad++-style; invisible to the file tree and indexes,
  see `specs/frontmatter-schema.md`). Topics are free inline `#tag` labels, never directories
  ([ADR-0017](docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md)).
- Tags are free inline `#tag`s in the note body — no frontmatter `tags[]`.
  The **tags plugin** (`plugins/tags/`) is the tag **data owner**: a
  per-vault index of *every* heading-delimited section (tagged or not —
  milestone 33, so text search reaches untagged notes), kept fresh through
  the save/vault hook registries, plus the tag **prefix colors** and the
  **tag rename/merge** (Settings → Tags; longest `/`-namespace prefix
  wins, deterministic auto palette otherwise; the rename is a
  grammar-faithful token rewrite over the M33 replace discipline,
  descendants included by default, milestone 53). The tag **chrome is base**: editor pills +
  `#tag` completion (`src/app/editor/tags/`, fed by the base
  `TagVocabularyService` over `search:vocabulary` + `search:changed`) and
  a shared tag chip field (`TagField`, also handed to plugins as
  `api.ui.createTagField`; its free-text mode lifts typed `#tag` words
  into chips, ADR-0057). Its **search** panel: an icon scope switch
  (document | vault | all vaults), **one** field for tag chips AND free
  text with case/whole-word/regex toggles, per-file grouped hits, replace
  (buffer patch in file scope; one bundled confirmation vault-wide), the
  Export scratch tab and an LLM **Summarize** digest of the hits
  (milestone 37, editable `builtin:search-summary` prompt). MCP
  `vault_search` takes an optional `vault` argument.
  The MCP server reads the index through the registered
  `SectionSearchProvider` (which also serves vocabulary + prefix styles)
  and degrades with a clear error when the tags plugin is disabled.
  `#task` is reserved; the LLM only _suggests_ tags (Autotag — re-homed in
  milestone 45 as the editor `⋯` menu's "Suggest tags" row: it sends the
  caret's heading section (`shared/note-sections.ts`) and applies the
  suggested tags to it directly). See `specs/classifier-spec.md`.
- LLM transport behind a provider abstraction
  ([ADR-0047](docs/09_architecture_decisions/0047-llm-provider-abstraction.md)):
  base-owned `LlmClient` interface + a per-call `LlmRouter` over
  `electron/llm/providers/`. The default is the **local OpenAI-compatible
  endpoint** (LM Studio default; Unsloth Desktop, llama.cpp, vLLM, Ollama
  all work) with an optional `Authorization: Bearer` API key. Hosted
  presets (OpenRouter, Anthropic API, Z.ai GLM) and CLI providers
  (Claude Code headless, GitHub Copilot CLI) are **opt-in, off by
  default** — a documented exception to the old "no cloud calls" rule,
  same as the removable `copilot-web` scraper (ADR-0040). No hardcoded
  model id — never assume a specific model is loaded, and never assume
  `/v1/models` is reachable (the model id must stay hand-enterable;
  CLI/web providers advertise no model listing at all). API keys sit in
  `app-config.json` in plain text (`docs/11`).
- **Semantic vault retrieval** (milestone 41,
  [ADR-0055](docs/09_architecture_decisions/0055-semantic-vault-retrieval.md)):
  the assistant's **Vault chip** retrieves the top-k note sections most
  similar to the question into the system prompt. Embeddings via
  transformers.js **WASM-only in a worker thread** (the native
  `onnxruntime-node`/`sharp` deps are stubbed; the WASM runtime is
  injected via `globalThis[Symbol.for('onnxruntime')]`), one JSON index
  per vault under `<userData>/plugins/assistant/semantic-index/` with
  brute-force cosine — no sqlite-vec, no native modules, no database.
  **Chat notes are excluded** (`chats/` would embed the literal question
  text of past conversations and displace the notes that answer them;
  ADR-0055 later-change).
  Owned by the assistant plugin (its only consumer); retrieval hydrates
  section text fresh from the vault at answer time.
- **Manual refresh, plus an opt-in watcher.** By default there is no file
  watcher ([ADR-0018](docs/09_architecture_decisions/0018-manual-refresh-no-file-watcher.md)):
  a manual refresh runs one full round in main (index rebuild + a
  `vault:changed` renderer push), and the app refreshes after its own
  writes (save, first daily-draft save, create/delete). The purely
  additive watcher ADR-0018 left open now exists as an **opt-in**
  (`vault.watch`, Settings → Vault, off by default —
  [ADR-0045](docs/09_architecture_decisions/0045-optional-vault-file-watcher.md)):
  chokidar + an own-write ledger (mtime matching, so the app's own saves
  never echo) feed the same external-change round; clean open tabs
  auto-reload from disk; a dirty tab is marked "Changed on disk".
- **Save conflicts are asked, overwrites leave a version** (milestone 60,
  [ADR-0060](docs/09_architecture_decisions/0060-save-conflicts-and-local-note-history.md)):
  `note:save` carries the mtime the tab last saw; when the file changed
  since, main writes nothing and the renderer opens a merge view (on disk
  | result | mine, per-block checkboxes, editable result) — watcher on or
  off. `VaultManager.writeFile` records the
  text every write replaces in a local history under
  `<userData>/history/` (never in the vault; the user's own saves
  throttled, chats and `.drafts/` excluded).
- **Assistant tool groups + MCP client** (milestone 63,
  [ADR-0063](docs/09_architecture_decisions/0063-mcp-client-and-assistant-tool-groups.md)):
  what the assistant may call is the `tools` config slice (Settings →
  Assistant tools) — one switch per group (vault, tasks, templates, web
  fetch, each external MCP server), `write: confirm | auto` on the
  writing groups, `approval: ask | allow` on everything that leaves the
  machine. External servers connect in main over the official MCP SDK
  (stdio / Streamable HTTP, tools only) and reach the model as
  `mcp__<id>__<tool>`. `mcp.enabled` / `mcp.yolo` only govern the
  server Drey offers to other programs. Opt-in, off by default — a
  further exception to "no cloud calls".
- **draw.io diagrams** (milestone 64,
  [ADR-0064](docs/09_architecture_decisions/0064-drawio-diagrams.md)): the `drawio` plugin opens `.drawio.svg` /
  `.drawio.png` / `.drawio` files in a tab holding draw.io's own web
  app — bundled, offline, in an iframe over `plugin://drawio/webapp/`
  (fetched by `npm run fetch:drawio` from a pinned, checksummed release;
  not in git). The two picture formats are ordinary images that carry
  the diagram, so a note embeds them with the existing image embed and
  the PDF export needs nothing; which one a new diagram gets is
  Settings → Diagrams (SVG by default). A diagram is inserted from the
  formatting bar's shapes button, `/diagram` or the context menu; until
  first drawn it is a placeholder picture. Diagram tabs **save
  automatically**. SDK 1.16 added what it needed: file openers by name
  suffix (`FileOpenerRegistry`, asked first in `EditorService.openFile`),
  binary read / write, `announce` on vault writes, and plugin buttons in
  the formatting bar (`ToolbarContributionsService`); a changed picture
  now reloads in open notes (`refreshChangedAssets`).
- **Office documents open in their own program** (milestone 66,
  [ADR-0066](docs/09_architecture_decisions/0066-office-documents-open-in-their-own-program.md)):
  Drey renders no Word / Excel / PowerPoint. A vault file whose
  extension is on the document allowlist (`shared/external-document.ts`)
  never opens as a tab — `EditorService.openFile` hands it to the OS
  (`shell.openPath`, allowlist re-checked in main). A note link may also
  be a local `file:` URL to a document outside the vault; nothing else
  reaches `file:`, and never a network share. Dropping an Office file
  copies it into `attachments/` and links it; **Alt-drop** links the
  original instead.
- **Git vaults** (milestone 65,
  [ADR-0065](docs/09_architecture_decisions/0065-git-vaults-source-control-plugin.md)):
  a vault can be a Git repository (its root or a folder inside it). The
  `git` plugin runs the **installed git** (`execFile`, no shell, one
  queue per repository, no timeout but cancellable) — never a JS or
  native reimplementation. File status reaches the Files panel through
  a base-owned decoration seam (`api.ui.setFileDecorations` →
  `FileDecorationService`; the base knows no Git); a plugin that
  rewrote the working tree calls `ctx.vault.announceChanges`. A save
  sets `updated:` only where the note already has it and **never adds
  frontmatter** (`touchUpdated`), in every vault. Milestone 67 (ADR-0065
  later change) adds merge with a conflict surface (keep mine / keep
  theirs / mark resolved, abort), stash, amend (never of a pushed
  commit — Drey does not force-push), commit and push, the "not pushed"
  history marker and a per-file *Git history* dialog; rebase, clone and
  hunk staging stay out.
- **Runtime plugin system**
  ([ADR-0044](docs/09_architecture_decisions/0044-runtime-plugin-system.md)):
  a **base application** (shell, editor + panes, vault/note IO, session
  restore, keybindings, spellcheck, MCP server, LLM *transport*, and the
  two plugin hosts) plus **runtime-loadable, in-process, trusted plugins**
  under `plugins/<id>/` — templates, meeting, tags, tasks, assistant
  (Assistant + Actions), browser, `ocr` (vision-LLM OCR, ADR-0050),
  `outline` (the open note's heading tree, renderer-only), `backlinks`
  (the "what links here" panel, milestone 54), `drawio` (the diagram
  editor tab, milestone 64), `git` (Git vaults, milestone 65),
  `sample`. Each is `plugin.json` +
  `main/` (CommonJS, Node) + `renderer/` (browser-context ESM + CSS over
  `plugin://`, **plain DOM**) + `shared/` types, built by
  `scripts/build-plugins.mjs` into `dist-electron/plugins/<id>/`.
  Discovery: built-in root + `<userData>/plugins/<id>/` +
  `DREY_EXTRA_PLUGIN_DIR` (dev). Every extension point is a base-owned
  registry — dock panels, doc kinds, Settings pages, menu rows, commands,
  editor extensions, drop decoders, context-menu items, composer slot,
  save hooks, vault hooks, section search — and the SDK in
  `shared/plugin-api/` is the versioned contract (major `apiVersion`
  gate). IPC is two fixed channels (`plugin:invoke` / `plugin:event`);
  enabling/disabling is `plugins.disabled` in app-config (Settings →
  Panels & plugins) and applies on restart. Base modules keep the
  ADR-0016 barrel convention (`eslint.config.mjs` deep-import ban);
  `shared/ipc-api.ts` stays the base cross-layer contract. Current
  structure: [docs/05 §5.0](docs/05_building_block_view.md).

## Relevant Components

Base components below; the feature *panels and backends* (tags/search,
tasks, templates, assistant + Actions, meeting import, browser tab) are
runtime plugins under `plugins/<id>/` —
[docs/05 §5.0](docs/05_building_block_view.md) has the seam table and the
plugin-owned behavioural contracts.

Main process:

- `VaultManager` — the multi-vault registry
  ([ADR-0051](docs/09_architecture_decisions/0051-multi-vault-registry.md)):
  every registered vault (`{id, name, path}`, stable minted ids) in
  `<userData>/vault-config.json` v2 plus which one is **active** (the
  default target for daily notes, capture, chats, drafts). Per-vault path
  resolution — every op takes an optional trailing `vaultId` defaulting
  to active — `deleteEntry()`, `pickSavePath()` (rooted at the given
  vault) and cross-vault moves (copy + delete, sidecar travels along);
  every mutating method records itself in the own-write ledger so the
  watcher can drop its own echoes
- `VaultWatcher` + `OwnWriteLedger` +
  `VaultChangeAnnouncer` (`electron/vault-watcher.ts`,
  `own-write-ledger.ts`, `vault-change-announcer.ts`) — the opt-in vault
  watcher ([ADR-0045](docs/09_architecture_decisions/0045-optional-vault-file-watcher.md)),
  one chokidar instance **per registered vault** (reconciled on registry
  changes) → ledger suppression (vault-scoped keys) → one debounced round
  per vault (per-`.md` plugin vault-change events + the `vault:changed`
  renderer push with `vaultId` + changed paths; a payload-less push is
  the registry-level round). The same round backs the manual refresh
  (`vault:refresh`), registry mutations and MCP writes.
  `EditorService.reloadFromVaultChange` auto-reloads **clean** tabs among
  the changed paths and marks dirty ones `diskChanged` (ADR-0060)
- `NoteHistoryStore` (`electron/history/note-history-store.ts`,
  milestone 60, ADR-0060) — earlier versions of notes under
  `<userData>/history/<vaultId>/`, fed by `VaultManager.writeFile` (each
  write names its `origin`) and kept attached across renames; bounded by
  `vault.history`. `NoteManager.saveNote` holds the conflict guard
  (`baseModifiedMs` → `NoteSaveResult.conflict`)
- `ExternalFileGate` + `extractOpenPaths` (`electron/external-open.ts`,
  [ADR-0054](docs/09_architecture_decisions/0054-opening-files-from-the-os.md)) —
  files the OS hands to Drey (Explorer "Open with" / default program for
  `.md`/`.markdown`/`.mdx`/`.txt`, registered by the NSIS installer's
  `fileAssociations`; the portable build registers nothing). Launch argv and
  `second-instance` are queued, classified by `locateInVaults` (inside a
  registered vault → an ordinary vault tab; anywhere else → a **pinned
  external tab**, `external://<path>`, edited normally and saved in place
  via `external:write` without the vault pipeline; "Save as…" copies it
  into the active vault) and gated by a read/write allowlist
  (only OS-collected paths, registered extension, 50 MB). The renderer
  *pulls* the queue once after session restore, later launches are
  *pushed*; `src/app/external-open/ExternalOpenService` routes them.
  External tabs are not session-restored
- `electron/plugin-host/` — discovery (built-ins +
  `<userData>/plugins/*` + `DREY_EXTRA_PLUGIN_DIR`; manifest validation;
  `plugins.disabled` + `apiVersion` gating), main-side activation
  (quarantine on throw), per-plugin config store, and the registries the
  plugins fill: **save hooks** (`onNoteSaved → {content?,
  pendingActions?}`; skipped when the save applies a confirmed rewrite),
  **vault hooks** (open/refresh/write/delete/rename) and the
  **section-search provider** (the MCP `vault_search` backend)
- The feature backends — `TagIndex`, `TaskIndex`, the assistant's
  ActionEngine (Actions) and ChatEngine/ChatStore (chat notes,
  ADR-0048), the assistant's template tools (`template-tools.ts`,
  milestone 58, over `ctx.vault.delete` — SDK 1.14's new plugin delete
  seam), the backlinks `BacklinkIndex` (milestone 54) — live in
  their plugins.
  `suggestTags` (the Autotag prompt) stayed base:
  `electron/llm/tag-suggest.ts`
- `LmStudioClient` — HTTP client for the local OpenAI-compatible endpoint
  (`GET /models`, `POST /chat/completions`), optional bearer API key.
  **No timeout on generation** — a local model may think for minutes; the
  user cancels instead ([ADR-0014](docs/09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md)).
  Its optional tool loop (`vaultTools` chat option) backs the assistant
  plugin's vault tool use when `tools.vault.enabled`
- `LlmTaskRegistry` — one `AbortController` per in-flight generation, so
  `llm:cancel` can abort it
- `AppConfigStore` — reads/persists `app-config.json` under the OS user-data
  dir (all app settings slices: LLM, spellcheck, appearance, MCP,
  `widgets`, `plugins`); app config, never in the vault
  ([ADR-0010](docs/09_architecture_decisions/0010-app-settings-storage.md))
- `electron/mcp/` ([ADR-0021](docs/09_architecture_decisions/0021-mcp-vault-server.md)) —
  the vault MCP server. `VaultTools` (`vault_search` with a regex filter /
  `vault_read` / `vault_write`), `createVaultMcpServer` (the MCP SDK's `Server`, since milestone 63),
  `McpHttpTransport` (opt-in localhost `POST /mcp`) and a standalone
  `stdio-bridge.ts` script. `vault_write` routes through the ADR-0011
  confirmation dialog (main→renderer bridge) unless "YOLO mode" is on
  (for MCP clients; the assistant's writes follow `tools.vault.write`)
- `electron/mcp-client/` (milestone 63, ADR-0063) — the other direction:
  `McpClientManager` (one SDK client per configured external server,
  tool list + status), `web-fetch.ts` (the built-in `web_fetch`) and
  `AssistantToolbox` (the external tool set of a chat call, each source
  behind its approval rule via `ToolApprovalBridge`). The plugin host
  merges it into `ctx.llm.chat` when a plugin passes `externalTools`
- `SpellcheckService` (main) — nspell + the bundled/added Hunspell
  dictionaries; answers `spell:check` with misspelled words + suggestions

Renderer (Angular):

- `App` composes a **titlebar / [left dock | main column | right dock] /
  status bar** shell directly.
- `DockService` + `Dock` + `PanelFrame` (`src/app/dock/`) — the dock
  system: `DockService` holds the whole `LayoutState` (which panel in
  which dock, order, `flexes`, collapse, `leftW`/`rightW`, `bottomH`;
  `localStorage['drey.dock']`) and runs the header-drag / splitter /
  dock-edge-resize gestures. Three docks — `left | right | bottom` (the
  bottom one a resizable band under the editor). Panels come from the
  runtime **`WidgetRegistryService`**: core panels via
  `registerCoreWidgets()` — `CalendarPanel`, `FilesPanel` (one section
  per registered vault — the vault header row stacked per ADR-0051 —
  plus the file trees, right-click new/delete, inline create, add /
  rename / remove / set-active vault management in the vault row's
  context menu, and drag & drop of files/folders within or across
  vaults, req-23),
  `WindowsPanel`, `SearchPanelHost` — while the templates / search
  / tasks / assistant panels are plugin widgets mounting plain DOM into
  `PluginWidgetHost`. Persisted layout keys on widget ids — plugin
  widgets keep their ids (ADR-0044 rule 5).
  `PanelFrame` is the identical 32px header every panel shares.
  `DockService.contentHeight(id)` marks a panel (currently `calendar`)
  that sizes to its content rather than a flex share.
- `TitlebarComponent` + `MenuBar` + `MenuService` (`src/app/titlebar/`) —
  the frameless-window titlebar: accent square, the left dock toggle,
  the HTML File/Edit/Selection/View menu bar, the **back/forward arrows**
  (milestone 55, right of the menu bar — `DocHistoryService`), the right
  dock toggle, and
  — off macOS — minimize/maximize/close over the `window:*` IPC channels
  ([ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)).
  Menu rows dispatch three ways: `KeybindingService` command ids
  (New note, Save, Search…), the `edit:exec` IPC → `webContents`
  (Undo/Redo/Cut/Copy/Paste/Select all, works in any focused field), and
  CodeMirror commands against the surface `EditTargetService` last saw
  focused (Find in note, Select line, Move line, Duplicate selection,
  Toggle task done — disabled when no editor is focused).
- `StatusBarComponent` (`src/app/status-bar/`) — the 28px bottom bar:
  word/char count, a context hint (the drag instruction while a panel is
  moving), and the Settings entry.
- Search panel — `plugins/tags/` (DOM dock widget): an icon scope
  switch (document | vault | all vaults), **one** field (the shared tag
  field in free-text mode: a typed `#name` becomes a chip, the rest is
  the text query) with `Aa`/`ab`/`.*` match toggles → section hits
  **grouped per file** (click opens the file at the line through the
  document API, vault-aware), and — as icon buttons on the result line —
  a replace row (file scope patches the buffer; vault/all goes through one
  bundled per-file-diff confirmation), **Export** (dumps the hits into an
  unsaved `search-results.md` scratch tab) and
  **Summarize** (when an LLM is configured), which streams a topic
  digest of the hits — via the plugin's `summarise` backend over the
  editable `builtin:search-summary` template — into an unsaved
  `search-summary.md` scratch tab, cancellable (milestone 37). Next to
  the scope switch a speech-bubble **Include chats** toggle: chat notes
  (`chats/`) stay indexed but are left out of vault / all-vault hits —
  and out of "Replace all" — unless it is on (off by default; the
  document scope searches the open note as it is). Panel +
  toggle prefs persist in `localStorage['drey.search']`
- Tasks panel — `plugins/tasks/` (DOM dock widget, ADR-0033):
  checkbox / `#task` lines in the open document, the whole vault, or all
  vaults (Doc | Vault | All scope toggle, milestone 34) · "hide done" · a
  kind filter · a sort cycle (file order | due | priority, milestone 51 —
  due/priority sorts flatten the grouped view) — all persisted to
  `localStorage['drey.tasks']`. Task lines carry **Obsidian-compatible
  inline metadata** (req-37): a due `📅 YYYY-MM-DD` and a priority glyph
  (`🔺`/`⏫`/`🔽`), parsed + stripped by the shared scanner into
  `TaskRecord.due`/`TaskRecord.priority` (so `resolveTaskLine`'s
  text+kind matching never sees them; `specs/frontmatter-schema.md`,
  ADR-0033 later-change). Rows show a due badge (overdue/today colored)
  + the glyph — both are buttons that re-open their picker at the badge
  and write back through the shared `applyToTaskLine` routing; editor
  completion on task lines (`due`/`fällig` with a native date-picker
  popover defaulting to today, `prio`/`priority` with the glyph list)
  and a plain click on a token chip re-opens the same pickers in place —
  `task-meta.ts` over the host's markdown language data (options ride
  `filter: false`, else CM's label fuzzy-matcher drops the
  emoji-prefixed labels). Document scope
  scans the live editor buffer through the document API; vault/all scope
  calls the plugin's `backend.invoke('list', …)` over its **per-vault
  index** (every record stamped `vaultId`; vault scope filters to the
  registry's active vault at pull time, all scope groups per file with a
  vault badge). A row's checkbox rewrites the buffer line through
  `documents.setBuffer` + save (closed files through
  `vault.writeFile { vaultId }`); a row click opens the file at the line,
  in its vault
- Source control panel — `plugins/git/` (DOM dock widget, ADR-0065):
  the repository of the focused document's vault — branch button (→
  branch picker: switch, track a remote branch, create), commit message
  + commit, *Merge conflicts* / *Staged changes* / *Changes* lists (row
  click compares through `api.ui.showDiff`; stage / unstage / discard /
  open), a collapsible *History* (commits not on the upstream carry
  "↑ not pushed"), header icons Fetch · Pull · Push · More (merge a
  branch, stash, stashes, amend, file history) · Refresh; a merge shows
  a banner with an abort icon, the commit box has *Commit* and *Commit
  and push* (`Ctrl+Shift+Enter`). The main entry (`GitRunner` + the pure parsers in
  `shared/status.ts`) keeps one `VaultGitState` per vault, pushed as
  `status-updated`; the renderer turns it into Files-panel decorations.
  Asks before a commit with unsaved tabs; refuses checkout / pull while
  the vault has unsaved tabs. Settings → "Git" (`gitPath`)
- Assistant panel — `plugins/assistant/` (DOM dock widget; conversations
  since ADR-0048): **chat-first** — a chat
  picker + new chat in the head, turn cards rendered from the active
  chat note (`chats/<y>/<m>/…`, `kind: chat`; collapsible tool chips for
  the persisted `drey-tool` entries, streamed partial answers), the
  milestone-24 composer (context chips, auto-grow, model row) plus
  image/file chips (paste/drop or a native dialog stage EXTERNAL files
  into the vault via `api.vault.saveAsset` / `chat:attachExternal` —
  vision parts per provider capability, text attachments name-preserving).
  The chat note is the source of
  truth: every turn is appended main-side (`chat-engine.ts` +
  `chat-store.ts` via `ctx.vault.writeAnnounced`), and a follow-up
  full-replays the persisted history — tool pairs and applied edits
  included — or resumes a claude-code session; there is no `history`
  IPC field and no length cap. Chat notes are **auto-saved**: the tab
  follows the disk (an append reloads even a dirty tab) and hand edits
  persist after a short idle (`shared/structural-folders.ts`
  `isAutoSavePath`; also `.drafts/`), so chats and temp files never
  raise the exit prompt — only the user's own notes do. (The old
  auto-summary sidecar feature was removed entirely — ADR-0012
  superseded; pre-existing `.{name}.chat.json` files stay on disk,
  unread.) **Chat switching is explicit** (ADR-0048 later change): a
  chat note's `note:` frontmatter records the doc key the chat was
  started under (provenance + the picker's "this note" marker only — it
  steers nothing), and the ONLY implicit panel switch is a focused
  **chat-note tab** (opening a chat's Markdown from the vault hydrates
  the panel with it). Every other focus — daily, meeting, topic note,
  non-document — keeps exactly the current chat; at startup the newest
  chat loads once. A chat otherwise changes through the picker or
  "New chat". A "Prompts" picker in
  the composer inserts a prompt from `templates/prompts/*.md`
  (`# Titel` / `> Beschreibung` / body) into the composer for editing.
  Manual
  Actions live in the editor `⋯` menu as `editor-more` menu contributions.
  **Live edit** (ADR-0049): a "Live edit" chip in the composer opts one
  ask turn into immediate-apply editing — the model edits the open note
  through the `doc_*` tools (`doc_apply_diff` atomic find/replace hunks,
  `doc_write`, `doc_read`) over a main-side working copy; each mutating
  call pushes via the `chat:liveEdit` event into `documents.setBuffer`
  (one Ctrl+Z step per push), the document is locked for user input
  while the turn runs (`documents.setEditLock` → an `EditorView.editable`
   compartment + the meta bar's "Assistant is editing…" hint), the applied
   document persists as the turn's `edit` fence entry, and providers
   without tool support fail visibly
- **Vault chip — semantic vault retrieval** (milestone 41,
  [ADR-0055](docs/09_architecture_decisions/0055-semantic-vault-retrieval.md)):
  a second composer chip opens a vault picker — *Off / Active vault /
  All vaults* shortcuts plus one checkbox row per registered vault, so a
  non-active vault (e.g. a Git vault) is targetable without activating
  it; each ask with it on embeds the question in the assistant plugin's
  worker
  (transformers.js WASM-only, `plugins/assistant/main/semantic/`) and
  injects the top-k similar note sections into the system prompt —
  section text rides ONLY that call (never the replay; older turns cite
  via a compact ```drey-context fence that names the vault:
  `vault · path:line`). Index: one JSON file per **every registered**
  vault (scope-independent)
  under `<userData>/plugins/assistant/semantic-index/`, kept fresh by the
  save/vault hook registries, hydrated from the vault at answer time.
  Settings → "Assistant retrieval" (enabled, model id, k, score floor,
  per-vault status + rebuild). Independent of `mcp.enabled`; ignored for
  live-edit turns. A custom selection referencing no registered vault
  anymore degrades to a visible `unregistered` context status, never to
  the active vault.
- `KeybindingService` (`src/app/keybindings/`) — a capture-phase
  `keydown` listener mapping chord strings onto `Command`s, plus a
  capture-phase `mouseup` listener for `Command.mouseButton`
  (3 = XButton1/back, 4 = XButton2/forward, window-wide; the `mouseup`
  is swallowed so Chromium's own history default action never fires,
  and the matching `mousedown` is swallowed with
  `preventDefault` + `stopPropagation` so CodeMirror's caret placement
  never sees the press);
  features register from `App`. Commands: `search.open` (`Mod+Shift+F`),
  `note.new` (`Mod+N`), `note.save` (`Mod+S`), `note.saveAs`
  (`Mod+Shift+S`), `note.saveAll` (`Mod+Alt+S`),
  `editor.toggleLineNumbers` (`Mod+G`), `doc.back` (`Alt+Left`) /
  `doc.forward` (`Alt+Right`, the session document history over
  `DocHistoryService`; both also bound to the mouse side buttons,
  VS Code-style), `window.toggleFullScreen` (`F11`,
  OS fullscreen via `window:toggle-fullscreen`; the native menu's
  `togglefullscreen` role is deliberately absent — its F11 accelerator
  would swallow the key) — the titlebar menu invokes the
  same ids; milestone 59 adds `palette.files` (`Mod+P`) /
  `palette.commands` (`Mod+Shift+P`) and `settings.open` (`Mod+,`)
- `PaletteService` + `Palette` (`src/app/palette/`, milestone 59) — the
  quick switcher / command palette, one overlay: files of every vault
  (fuzzy on name then path, session-visited documents first, `Ctrl+Enter`
  opens beside the current tab, "Create note" on no match) or — behind
  a leading `>` — every `KeybindingService` command with its shortcut
- `LinkUpdateService` + `LinkUpdateDialog` (`src/app/link-update/`,
  milestone 59, [ADR-0059](docs/09_architecture_decisions/0059-link-integrity-on-rename.md)) —
  every Files-panel rename / move goes through `rename()`: main's
  `LinkRewriter` (`electron/link-rewriter.ts`) plans over the pure
  `shared/link-rewrite.ts` (a reference is rewritten only when what it
  opened before differs from what the same text opens after; attachments
  used only by a moved note travel with it), the dialog asks per
  `vault.updateLinksOnRename` (`ask | always | never`), dirty tabs are
  patched in the buffer. Wikilink grammar + resolver live in
  `shared/wikilinks.ts` (the backlinks plugin keeps its twin)
- `ConflictService` + `ConflictDialog` (`src/app/conflict/`) and
  `HistoryService` + `HistoryDialog` (`src/app/history/`), milestone 60
  (ADR-0060) — the save-conflict merge view over the pure
  `merge-model.ts` (`EditorService.saveNow` asks when main refuses a
  save; the meta bar's "Changed on disk" button asks early; the answer
  is the merged text) and "File history…" (editor `⋯` menu, tab context menu, command
  `note.history`): versions of the open note, diffed against the buffer,
  restored INTO the buffer. The history and the ADR-0011 dialog render
  through the shared `DiffView` (`src/app/diff-view/`)
- `DocHistoryService` (`src/app/services/doc-history.service.ts`,
  milestone 55) — one global, pointer-based back/forward history of the
  documents viewed this session (VS Code model over any number of
  panes; browser truncation of the forward branch; circular drop past
  100 entries). An `effect` on `EditorService.activePath()` records
  every activation; App `suspend()`s around the startup mass-opens and
  `resume()` seeds the landed-on doc; `back()`/`forward()` walk the
  pointer (serialized, `nav`-guarded), REOPEN closed vault/external
  documents (`keepFocused`, never a clean-tab replace) and lazily prune
  unrestorable entries (scratch tabs, plugin doc kinds). Purely
  in-memory — nothing rides into the session snapshot; caret/scroll
  restore rides the existing milestone-50 memory
- `PaneService` (`src/app/panes/`, ADR-0037) — the split-view editor
  layout: an arbitrary tree of row/column splits down to leaf panes, each
  a `{ tabs, active }` record. `PaneLayout` renders the tree recursively
  (draggable splitters between siblings); `PaneLeaf` renders one pane's
  own `TabBar` + `EditorComponent`/`ImageTab`/`PdfTab`. `EditorService` is a
  facade over the *focused* pane's document (`activePath`, `isDirty`,
  `save()`, word count, …). One pane per open path (not the same note
  live in two panes at once); a tab's own "Split right"/"Split down" (its
  context menu) creates a sibling pane. Opening a file (or a calendar day)
  **replaces** the focused pane's *clean* tab — a dirty or **pinned** tab
  (tab context menu, milestone 35) stays and the new file opens alongside; plugin doc kinds and the already-open reveal
  path are excluded, and internal flows (session restore, `saveAs`,
  multi-select open) pass `keepFocused` (ADR-0003 amendment, milestone 32).
  Dragging a tab is real DnD via
  `TabDragService` + the shared `src/app/dnd/` overlay (ADR-0039): source
  stays put, ghost chip + drop-line, `no-drop` over an invalid target,
  commit once on release onto a tab strip (precise slot) or a pane body
  (append); ESC / window-blur cancel. `App` also registers
  `pane.splitRight` (`Ctrl+Alt+Enter`), `pane.splitDown`
  (`Ctrl+Alt+Shift+Enter`) and `pane.focusNext`/`Prev` (`F6`/`Shift+F6`)
  commands + View-menu rows. A **vault file dropped on a pane** but not on
  `.cm-content` (tab strip, meta bar, empty state, padding) opens as a tab
  there — `PaneDropService` (`src/app/panes/`), from `PaneLeaf`'s
  `dragover`/`drop`; out-of-vault OS files stay with `DropGuardService`
  (ADR-0027 / ADR-0028 amendment). **Regions (milestone 20, ADR-0038):**
  each dock hosts at most one pane in its editor band —
  `detachToDock`/`reattachToCenter` (an occupied dock's occupant returns
  to the centre), band heights per side, splits refuse on docked panes, a
  band whose last tab closes dissolves. Docked editors ride the session
  snapshot's optional `dock` field and survive a restart with their tabs;
  `View → Reset layout` also calls `panes.resetRegions()`. `Dock`'s drag
  carries a widget id *or* an editor pane; the centre is an editor-only
  drop target.
- `EditorComponent` — one CodeMirror 6 view **per pane** (`[paneId]`
  input; `shownPath`/`shownDoc` resolve *that pane's* document via
  `PaneService`) with an inline Live Preview mode (decoration-based,
  ADR-0009) and a raw source mode, switched via a `⋯` mode menu
  (ADR-0008); the same `⋯` menu lists the manual Actions and "Save as…".
  A 40px meta bar carries the path, the **formatting buttons**
  (`MarkdownToolbar`, icon-only; hidden via `⋯` → "Formatting toolbar"),
  an "Unsaved" label, a **Lines** toggle (line-number gutter, `Ctrl+G`, an
  app-wide preference — not per-pane), Save and the `⋯` menu. Typing `/`
  opens the **slash menu** (`slash-commands.ts`): a **Templates** section
  — the built-in **Entry** block (the configured entry format, ADR-0022)
  plus the templates plugin's library entries, each with a preview card —
  then **Formatting** (ADR-0057). Typing a **snippet trigger** (`tbl`,
  `code`, `task`, …) offers a multi-line Markdown block with
  `${n:placeholder}` tabstops (milestone 46, templates plugin; the
  library is user-owned in app config and edited in Settings →
  Templates). The **fold gutter** is always live (Obsidian-style
  collapsible headings, hover-revealed chevron); only the line-number
  column follows the Lines toggle (`editorStructure` / `gutterTheme`).
  Inline `#tag`s render as pills; `Ctrl`/`Cmd`-click runs a tag search.
  `[[wikilinks]]` (ADR-0046) render as internal links in both modes
  (unresolved ones muted + dotted; Live Preview conceals the brackets, an
  alias leaving only its text); `Ctrl`/`Cmd`-click opens the target by
  name/path — at a `#heading` anchor's line when given — and **creates**
  a missing note; typing after `[[` autocompletes note names
  (`src/app/editor/wikilinks/`, a base feature over the file tree).
  Global per-id requests (quick-capture, the assistant's
  insert-into-note) are gated on `PaneService.focusedId()`, so only the
  focused pane's instance acts on one. `EditorService.requestInsertText`
  (consumed here) backs the assistant's insert-into-note arrow
- _(Removed in milestone 43,
  [ADR-0057](docs/09_architecture_decisions/0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md):
  `EntryDrawerComponent` / `EntryPanel`, the "Add entry" capture surface.
  Capture is the slash menu's Entry block; the entry format stays
  configurable under Settings → "Entry format".)_
- `ToolApprovalService` + `ToolApprovalDialog` (`src/app/tool-approval/`,
  milestone 63, ADR-0063) — the question before an external tool call
  runs (source, tool, arguments; Allow / Always allow / Deny), queued
  one at a time
- `McpBridgeService` — renderer side of the vault MCP server: shows an
  MCP client's `vault_write` in the shared confirmation diff and replies
  (the tree/index refresh after that write rides the shared
  `vault:changed` push, subscribed by `VaultService` for every change
  source — ADR-0045)
  ([ADR-0021](docs/09_architecture_decisions/0021-mcp-vault-server.md))
- `src/app/plugin-host/` — the renderer-side plugin host (ADR-0044):
  `plugin-host.service.ts` (activation before bootstrap, quarantine,
  the `plugin:event` fan-out, native-surface visibility synthesis),
  `plugin-api-impl.ts` (implements `DreyPluginApi` over the base
  services), the registries (editor extensions, drop decoders, doc kinds,
  menu contributions, settings pages) and the three DOM mount hosts for
  widgets / settings pages / doc kinds
- `SettingsComponent` — master-detail settings screen (category list +
  detail pane), core categories in alphabetical order — "Appearance",
  [ADR-0020](docs/09_architecture_decisions/0020-app-wide-appearance-accent-and-ui-scale.md),
  "Assistant tools" (the `tools` slice: group switches, write and
  approval rules, the external MCP servers — ADR-0063),
  "Daily notes", "Entry format" (what the slash menu's Entry block
  inserts, ADR-0022), "LLM", "MCP", "Panels & plugins" (`widgets.disabled` +
  `plugins.disabled` + each discovered plugin's live status),
  "Spelling", "Vault" (`vault.watch`, the opt-in external-change
  watcher, ADR-0045; `vault.updateLinksOnRename`, ADR-0059; `vault.history`, ADR-0060) — then **plugin-contributed categories** (sorted by
  label) before "About" and rendered through
  `PluginSettingsHost` (shared form vocabulary `plugin-settings.css`,
  author guide `plugins/AUTHORING.md`), saving immediately rather than
  via the footer bar (ADR-0044 rule 3). Opened from the status-bar entry.
  Category list is descriptor-driven (`*ngComponentOutlet`). The
  close (X) is top-right; the footer Discard is always enabled and closes,
  warning first when the draft is dirty
- `ConfirmationDialogComponent` — the one confirmation dialog shared by
  Actions, Ask-mode edits and MCP `vault_write` (inline line diff for a
  localized change; an **aligned split diff** — equal-size halves — for a
  whole-document rewrite; "don't ask again")
  ([ADR-0011](docs/09_architecture_decisions/0011-unified-confirmation-flow.md))

This is a starting point, not a fixed contract — but any deviation should
be called out explicitly (see Working Style below), not introduced silently.

## UI / UX Design

- Visual style: dark theme by default, minimal and unobtrusive — visual
  language similar to claude.ai (flat surfaces, no heavy borders or
  shadows, generous whitespace, sentence-case labels, no visual clutter).
  Since milestone 43
  ([ADR-0057](docs/09_architecture_decisions/0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md)):
  chrome labels are sentence-case **sans** (mono only for code, the
  meta-bar path and line numbers); panel controls are **icon-only** with a
  `title` + `aria-label`, drawn with the global `.icon-btn` / `.seg`
  classes (plugins get glyphs via `api.ui.icon`); panel fields carry no
  placeholder text. Two bespoke themes ship — **Drey** (terracotta) and
  **Anthrazit** (neutral charcoal gray, blue accent, AA contrast — ADR-0057 later change; the fresh-install default).
- Overall layout ([ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)):
  a frameless window with a **custom titlebar** (accent square + the
  left dock toggle + an HTML File/Edit/Selection/View menu bar + the right
  dock toggle + window controls; each toggle folds its whole side dock
  away, `Ctrl+B` / `Ctrl+Alt+B`, state kept and persisted), then a row
  of **[left dock | centre column | right dock]** — the centre column
  being the editor area above a **bottom dock** band — then a **28px
  status bar** (word/char count · context hint · Settings entry).
  - **Docks**: three (`left`, `right`, `bottom`), each an ordered list of
    the ten panels — **Calendar, Files, Templates, Search, Tasks, Open
    windows, Outline, Backlinks, Source control, Assistant** (the core
    ones registered by the base; Templates/Search/Tasks/Assistant/
    Outline/Backlinks/Source control are provided by plugins, ADR-0044). A
    panel is dragged between docks by its header, resized against its
    neighbour by a splitter, and collapsed to its 32px header. Every
    panel header is built the same way (sentence-case title + optional
    status value + the panel's icon controls + drag grip). Default:
    Calendar/Files/Templates/Search/Tasks/Open windows/Outline/Backlinks/
    Source control left, Assistant right, nothing in the bottom band,
    Templates + Search + Tasks + Outline + Backlinks + Source control
    collapsed. Calendar takes its content height, not a
    flex share; expanded, its header is the **month/year dropdown**
    itself (no "Calendar" title) with **Today** (opens today's daily
    note) and the month arrows.
    Each dock can additionally host one **editor band** above its panels
    (milestone 20, ADR-0038): a docked editor pane, its 32px header
    carrying the active tab's name, movable by header drag or the tab
    context menu, resizable by its own splitter; docked editors persist
    with the session.
    `View → Reset layout` restores it (and undocks the editor bands).
    Layout state persists (`localStorage['drey.dock']`).
  - **Files panel**: one section per registered vault — a vault header
    row (name, active-vault dot, fold chevron, path tooltip) above that
    vault's file tree, with the refresh + "Add vault …" buttons in the
    panel header. Clicking a file opens it (in its vault); right-click on
    a file/folder → new file/folder/rename/delete, edited **in place** in
    the tree (names stay on one line and fade at the right edge); right-click on a vault row →
    Set active / Rename / Add vault / Open in File Explorer / Remove
    (ADR-0051). Dragging a row onto a folder / file row / another vault's
    header row moves it (within or across vaults, req-23; no-drop on a
    same-dir no-op or a folder into itself).
  - **Centre column**: a 36px tab bar for open documents, a 40px meta bar
    (path · formatting buttons · Unsaved · Lines toggle · Save · `⋯`),
    the editor (Live Preview ⇄ source via the `⋯` menu — no toggle
    buttons; see ADR-0008/0009), then the **bottom dock** band (empty by
    default). Capture is the `/` menu's **Entry** block.
  - **Assistant panel**: chat-first head (the active chat's title as a
    muted label + a chat-list button opening the chat picker + a "+"
    icon for a new chat; the title is model-named — 57e's background
    naming call rewrites the question placeholder after the first turn,
    and the label re-renders live through the change rounds), turn cards
    with collapsible tool
    chips, a
    streamed partial answer while generating (the transcript follows the
    stream; scrolling up unpins), and the
    composer (context chips incl. images, auto-grow, and an icon tool
    row: Attach · Live edit · Vault context · Prompts · model picker).
    The panel keeps its chat across focus switches (only a focused
    chat-note tab or a picker/new-chat action changes it). No bottom chat bar.
  - **Settings**: a full-surface overlay opened from the status-bar entry
    — master-detail (category list on the left, detail pane on the
    right), core categories in alphabetical order (
    "Appearance" (theme, app-wide base font size + highlight colour +
    editor typeface, ADR-0020), "Assistant tools" (ADR-0063), "Daily notes", "Entry format", "LLM",
    "MCP", "Panels &
    plugins", "Spelling", "Vault" (ADR-0045)
    (ADR-0010; descriptor-driven list, ADR-0016)); plugin-contributed
    categories (sorted by label) append before "About".
    The X sits top-right; Discard is always active and closes (with a
    dirty-state warning). The
    confirmation dialog (Actions / Ask edits / MCP writes) is a centred
    modal: inline line diff for small changes, side-by-side before/after
    for whole-document rewrites (ADR-0011).
- Editing model: true in-place Live Preview (Obsidian-style, ADR-0009) —
  the cursor sits in the rendered document, syntax markers reveal only
  around the selection, tables/images render as widgets that show their
  raw Markdown while the selection is inside them; ArrowDown at the last
  row of a document-ending table (ArrowUp at one starting line 1) opens
  the missing line and steps out, so a table-only note stays editable.
  Source mode stays in the `⋯` menu as the escape hatch, not a separate
  "edit mode".
- Revealed embed source is always visibly contained: whenever an embed's
  Markdown source is shown (via the corner **`</>` View source** button or
  by moving the caret in), its raw lines sit inside a rounded, bordered
  container so the active-line highlight reads as in-scope. For an **image**
  the raw `![alt](path)` line is shown *together with* — above — the
  still-rendered picture, never replacing it. (`</>` = view source
  everywhere; the magnifier-with-`+` = zoom. Req-1.)
- A visual reference mockup for this layout was discussed and shown inline
  during planning, but it was never saved as a file — treat this section
  (plus the component list above) as the source of truth for layout intent,
  not an assumed saved mockup.
- The **v3 visual system** (milestone 14) has a real handoff:
  `handoff/DESIGN.md` (high-fidelity tokens, the four core principles, the
  dock-system spec) + `handoff/Drey App v3.dc.html` (interactive
  prototype, reference only) + `handoff/screenshots/`. Design tokens live
  centrally in `src/styles.css`. Deviations from the prototype are
  recorded in [ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)
  and `specs/`. The milestone-43 refinement
  ([ADR-0057](docs/09_architecture_decisions/0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md))
  supersedes the handoff's mono-uppercase chrome and text buttons; where
  the two disagree, ADR-0057 and this section win.

## Coding & Style Conventions

- TypeScript strict mode everywhere, no implicit `any`.
- Angular: standalone components, Angular style guide naming (kebab-case
  filenames, PascalCase class names).
- Prefer typed interfaces for every data shape crossing the IPC boundary
  (`Note`, `Task`, `TagEntry`, `VaultConfig`, `ClassifierResult`, ...) —
  define once in a shared types module, used by both main and renderer.
- ESLint + Prettier, default configs unless a concrete conflict comes up.
- No business logic inside components — components call services, services
  hold the logic.
- Background: strong C++/C# experience — prefer explicit typing and clear
  ownership boundaries over overly dynamic/implicit TypeScript patterns,
  even where the language would allow a shortcut.

## Documentation Requirements

Maintain arc42-compatible architecture documentation directly under `docs/`
(no extra `arc42/` subfolder — `docs/` already means this), one file per
arc42 section (numbered `01_introduction_and_goals.md` through
`12_glossary.md`). Create the full skeleton (even brief placeholder
sections) as part of milestone 1, then fill sections in incrementally as
the relevant work happens — don't write it all up front, and don't defer
it to the end either.

Two sections matter most and should stay current, not just get created
once:

- **Building Block View** (`docs/05_building_block_view.md`, static
  structure): main/renderer split, services, components — update whenever
  a component boundary from "Relevant Components" above changes or gets refined.
- **Runtime View** (`docs/06_runtime_view.md`, dynamic behavior): sequence
  diagrams for the key flows (quick-capture → daily note, save → re-index,
  tag search → hits → open-at-line / Export, Autotag, chat/RAG scope
  resolution) — add one as each flow gets implemented, not all up front.

Use Mermaid diagrams embedded directly in the Markdown files for both views
(renders in VS Code preview and GitHub, no extra tooling needed), unless a
specific diagram genuinely doesn't fit Mermaid's syntax.

Architecture Decision Records are part of arc42 section 9
("Architecture Decisions") per the arc42 template itself — not a separate
top-level folder. Store them under `docs/09_architecture_decisions/`, one
file per decision (`0001-short-title.md`, sequential numbering, MADR-style:
Title, Status, Context, Decision, Consequences). Write an ADR for
structural/lasting decisions with real trade-offs (e.g. the Electron
process split, tags as free labels + a section index (ADR-0017), the
storage format, the feature-module convention) — not for routine
implementation choices (a specific npm package, a minor naming convention). When in doubt
whether something warrants an ADR, ask rather than skip or over-produce.
`docs/09_architecture_decisions.md` itself stays a short index linking to
each ADR file — arc42's own guidance is to keep this central section short
and push details into the per-decision documents.

## Current State & Next Steps

The roadmap's Phase 1 (MVP) is complete, and the codebase has since been
restructured into a **base application with runtime plugins** (milestone
21, [ADR-0044](docs/09_architecture_decisions/0044-runtime-plugin-system.md);
packaging verified — see `docs/07_deployment_view.md`).

**Milestones 1–58 are complete and owner-verified** (verification round
closed 2026-10-10). This file does not restate them — the per-milestone
record is:

- [specs/changelog.md](specs/changelog.md) — milestones 22–67, newest
  first, plus requirements and fixes
- [docs/milestones-done.md](docs/milestones-done.md) — the archived
  build log, milestones 1–27
- the ADRs and `docs/05` / `docs/06` for the lasting structure

(Milestone 44, the Task Center's `#task/id:` addressing, was reverted
before release — ADR-0033 "considered and rejected"; the surviving piece
is the ambiguity skip in `resolveTaskLine`.)

## Milestones

Open work and its order live in [specs/roadmap.md](specs/roadmap.md)
("Next milestones") — that list is binding; keep this summary in step
with it.

- **Last completed:** milestone 67 — the Git plugin gains merge with
  conflict handling, stash, amend, commit and push, the "not pushed"
  marker and a per-file Git history (ADR-0065 later change). Before it:
  milestone 66 — Office documents open in their own program (ADR-0066).
  Milestones 59–67 are code-complete, owner verification pending.
- **Next, in order:** nothing ordered — the owner picks from the backlog
  in `specs/roadmap.md`.

A milestone that is code-complete but not yet verified by the owner is
marked "**Not yet manually verified by the owner**" in its changelog
entry — not here.

Pause after each milestone, show what works, don't push through several
milestones in one uninterrupted stretch. (Milestones 10, 11, 15 and 19
were explicit exceptions.)

## Working Style — important

This is meant to feel like pair programming, not a silent code generator:

- For every meaningful decision, briefly explain WHY this library/pattern/
  approach was chosen — especially where real trade-offs exist (which
  CodeMirror extension, how IPC messages are structured, why one package
  over another).
- Don't comment or explain every line of code — explanation belongs in the
  conversation, not in code comments.
- If something deviates from the `specs/` documents: say so explicitly and
  justify it, don't silently implement it differently. If it is implemented differently please update specs file appropriately
- For genuine alternatives with different trade-offs: state the options and
  a recommendation, then wait for confirmation — don't just pick the most
  likely option and run with it unasked.
