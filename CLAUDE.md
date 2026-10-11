# Drey — your private AI knowledge vault — Project Context for Claude Code

## Overview

Local, topic-based note-taking app (Electron + Angular). Full concept,
data schema, and classifier design live in `specs/`:

- `specs/roadmap.md` — overall concept, phases, open risks
- `specs/frontmatter-schema.md` — file/frontmatter format
- `specs/classifier-spec.md` — LLM prompts for task/note detection and tag suggestions

Read these three files before making a first proposal — they are the
binding specification, not just background reading.

`AGENTS.md` is the tool-neutral entry point for coding agents; it points
here, and everything in this file binds every agent regardless of tool.

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
  - Main-process and plugin tests (`electron/**/*.spec.ts`, `plugins/**/*.spec.ts`,
    plain Node, `vi.mock('electron')` where needed):
    `node node_modules/vitest/vitest.mjs run --config vitest.plugins.config.mts`
    (append a path fragment to scope it); their typecheck is
    `node node_modules/typescript/bin/tsc -p electron/tsconfig.spec.json`
  - Lint: `node node_modules/eslint/bin/eslint.js "electron/**/*.ts" "shared/**/*.ts" "src/**/*.ts" "plugins/**/*.ts"`
    — module boundaries plus `no-floating-promises` / `no-misused-promises`
    (a promise meant to run on its own is marked `void`)
  - Production renderer build: `node node_modules/@angular/cli/bin/ng.js build --configuration production`
  - Emit the main process: `node node_modules/typescript/bin/tsc -p electron/tsconfig.json`,
    then `node scripts/bundle-preload.mjs` — the main window is sandboxed
    and only runs the bundled one-file preload (`npm run build:electron`
    does both; tsc's own `preload.js` leaves `window.dreyApi` undefined)
- VS Code tasks and debug configs don't inherit `env.ps1`; `.vscode/` works
  around that three ways (see `docs/11`, "Environment gotchas").
- **`npm run dev` rebuilds and restarts Electron by itself**
  (`scripts/dev-electron.mjs`): a change under `electron/`, `shared/` or
  `plugins/` rebuilds the affected part of `dist-electron/` and asks the
  running app to quit (the ordinary quit, so unsaved tabs prompt first),
  then starts it again; `ng serve` keeps hot-reloading the renderer. A
  failed build restarts nothing. **Every other way of running the app
  still builds once** — `npm run app`, the VS Code debug configs, a
  packed build: there, touching `shared/`, `electron/` or `plugins/**`
  leaves a stale main process that disagrees with the renderer about the
  IPC contract _at runtime_ even though `tsc` is clean (unknown fields
  are silently stripped from IPC payloads). Rebuild and restart; verify
  with `grep <new-symbol> dist-electron/plugins/<id> -r` (and
  `grep <new-field> dist-electron/shared/*.js` for base IPC).

## Architecture & Design Decisions

- Electron main/renderer split. No Node integration in the renderer — all
  filesystem and LLM access goes through a `contextBridge` IPC boundary.
  The main window is **sandboxed** and its page runs under a
  **Content-Security-Policy** (`electron/content-security-policy.ts`,
  ADR-0001 later change): no inline script, no `eval`, no network
  `fetch` from the renderer, frames only from `plugin:` / `drey-asset:`.
  A feature that needs more widens the policy explicitly; the e2e
  fixture fails a test on any violation.
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
  CLI/web providers advertise no model listing at all). API keys (and
  the env / header values of external MCP servers) are encrypted in
  `app-config.json` with the OS user's key — `electron/config-secrets.ts`,
  ADR-0010 later change; plain in memory and over IPC. **No timeout on
  generation** — a local model may think for minutes; the user cancels
  instead ([ADR-0014](docs/09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md)).
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
  Owned by the assistant plugin; retrieval hydrates
  section text fresh from the vault at answer time. Since milestone 68
  the index also serves the Search panel's **Semantic** toggle and MCP
  `vault_search` mode `semantic` through a base
  `SemanticSearchProvider` seam (SDK 1.18, registered only while
  retrieval is enabled). Since milestone 71 the chip-on ask is
  **hybrid-agentic** ([ADR-0069](docs/09_architecture_decisions/0069-agentic-vault-exploration.md)):
  the top-k block stays as the floor, and scope-safe explore tools
  (`vault_overview` / `vault_find` / `vault_section`, closed over the
  chip's targets) let tool-capable models scan and read further; the
  host drops out-of-scope `vault_search`/`vault_read` from the ask
  (`vaultToolsScope`, SDK 1.20), and a cold/stale vault index
  self-heals via a background rebuild instead of browsing empty.
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
  editor tab, milestone 64), `git` (Git vaults, milestone 65), plus
  `sample` — dev/test-only since milestone 70 (built under
  `DREY_BUILD_SAMPLE_PLUGINS=1`; the authoring reference for
  `plugins/TUTORIAL.md`). Each is `plugin.json` +
  `main/` (CommonJS, Node) + `renderer/` (browser-context ESM + CSS over
  `plugin://`, **plain DOM**) + `shared/` types, built by
  `scripts/build-plugins.mjs` into `dist-electron/plugins/<id>/`. The
  renderer is **bundled** into one file (esbuild; ADR-0044 later change):
  it may import its own folder and the repo's `shared/` at runtime —
  never a package, `src/` or `electron/`; the build fails on those. Use
  the `shared/` function, do not copy it into the plugin.
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

## Ownership Map — who owns what

One line per building block — the deterministic answer to "where does a
change go". The per-component detail (current behaviour, contracts,
gotchas) and the **Feature → files** index live in
[docs/05 §5.0](docs/05_building_block_view.md) ("Component reference
(current)"); keep that section in step when a boundary changes.

Main process (`electron/`):

- `main.ts` — composition root: the sandboxed window, privileged
  schemes, single-instance lock, quick-capture hotkey
- `vault-manager.ts` — `VaultManager`: the multi-vault registry
  (ADR-0051) + all vault/note file IO over `safe-file.ts` atomic writes;
  mutations record in the own-write ledger
- `note-manager.ts` — the `note:save` pipeline: mtime conflict guard +
  frontmatter bump (ADR-0060); feature work rides the save/vault hook
  registries
- `daily-note.ts` — daily-note creation + template substitution
- `session/` — session snapshot/restore + unsaved-buffer backups (ADR-0043)
- `history/` — `NoteHistoryStore`: per-write local note versions, the
  "File history…" backend (ADR-0060)
- `vault-watcher.ts` + `own-write-ledger.ts` + `vault-change-announcer.ts` —
  the opt-in watcher and the one shared external-change round (ADR-0045)
- `external-open.ts` + `ipc/external-handlers.ts` — files the OS hands to
  Drey (ADR-0054)
- `link-rewriter.ts` — link-integrity rewrites on rename/move (ADR-0059)
  over the pure `shared/link-rewrite.ts`
- `llm/` — the LLM transport: `LlmClient` + per-call `LlmRouter`,
  `providers/` (ADR-0047), the task registry, `tag-suggest.ts`
- `mcp/` — the vault MCP server (ADR-0021); `mcp-client/` — external MCP
  servers, `web_fetch`, the assistant toolbox (ADR-0063)
- `plugin-host/` — discovery, activation/quarantine, per-plugin config,
  save/vault hooks, the section-search **and** semantic-search provider
  slots, the `.zip` installer (ADR-0044/0068)
- `spellcheck.ts` — nspell + Hunspell dictionaries; `pdf-export.ts` — the
  "Export as PDF…" flow
- `safe-file.ts` — atomic writes + guarded config reads (data safety);
  `config-secrets.ts` — API keys encrypted in `app-config.json`
  (ADR-0010 later change); `content-security-policy.ts` — the
  renderer CSP (ADR-0001 later change)
- `ipc/` — thin, feature-free base channel handlers

Renderer (`src/app/`):

- `services/EditorService` — multi-document state as a facade over the
  focused pane (ADR-0003/0037), over `OpenDocsStore` (the registry),
  `DocOpenService`, `DocSaveService` and `DocDiskSyncService`; `services/DocHistoryService` — the
  back/forward history (M55)
- `panes/` — `PaneService` split tree + dock regions (ADR-0037/0038),
  `TabDragService` + `dnd/` (ADR-0039), `PaneDropService`
- `editor/` — the only CodeMirror surface: `MarkdownSurface`, Live
  Preview (ADR-0009), modes (ADR-0008/0036), wikilinks (ADR-0046), tag
  pills/completion (`editor/tags/`), spellcheck (ADR-0013/0056),
  toolbar + slash commands (M42/M46)
- `dock/` — `DockService` + `DockStrip` (icon strips, M69) +
  `WidgetRegistryService`: the three docks, every panel, each dock's
  editor band (ADR-0019/0034/0038)
- `vault/` — `FilesPanel` + `VaultService` (trees, vault management;
  the panel handles input only, over `FilesTreeState` and
  `FileOperationsService` in `dock/panels/`);
  `calendar/`, `windows/`
- `keybindings/` — `KeybindingService`: commands + chords; `palette/` —
  the quick switcher / command palette (M59)
- `link-update/` — the rename/move link-integrity dialog (ADR-0059)
- `conflict/` + `history/` — save-conflict merge + file-history UIs
  (ADR-0060), both over `diff-view/` (the shared `DiffView`)
- `confirmation-dialog/` — the one ADR-0011 dialog; `tool-approval/` —
  external-tool asks (ADR-0063)
- `settings/` — the settings framework + core categories (ADR-0010)
- `help/` — the Help menu: bundled manual (`docs/manual/` →
  `public/manual/` via `scripts/sync-manual.mjs`) + the live-generated
  shortcuts page (ADR-0067)
- `plugin-host/` — the renderer plugin host: `DreyPluginApi` impl,
  registries, the three DOM mount hosts
- `titlebar/` (menu bar, window controls), `status-bar/`,
  `image-viewer/` (ADR-0026), `pdf-viewer/` (ADR-0052),
  `external-open/`, `services/` (settings/appearance/theme/spellcheck
  singletons)

Cross-layer:

- `shared/plugin-api/` — the frozen, versioned plugin SDK (manifest,
  `DreyPluginApi`, `MainPluginContext`, `PLUGIN_API_VERSION`)
- `shared/ipc-api.ts` — the base IPC contract; the rest of `shared/` is
  pure, testable logic both sides share (frontmatter, tags, tasks,
  wikilinks, link-rewrite, app-config, …)

Plugins (`plugins/<id>/`, ADR-0044 — each `plugin.json` + `main/` +
`renderer/` (esbuild-bundled) + `shared/`, built into
`dist-electron/plugins/<id>/`):

- `tags/` — tag data owner: section index, prefix colors, rename/merge,
  the Search panel incl. the Semantic toggle over the base seam
  (ADR-0017, M33/37/53, M68)
- `tasks/` — Tasks panel + per-vault task index, inline metadata
  (ADR-0033)
- `templates/` — Templates panel, slash-menu template entries, snippets
  (M46)
- `assistant/` — Assistant panel: chat notes (ADR-0048), Actions, live
  edit (ADR-0049), semantic retrieval + explore tools (ADR-0055/0069 —
  it also registers the `SemanticSearchProvider`)
- `meeting/` — `.ics`/`.msg` meeting-section import (ADR-0041)
- `browser/` — the in-editor browser tab (ADR-0042)
- `ocr/` — vision-LLM OCR on images (ADR-0050)
- `outline/` — heading tree of the open note; `backlinks/` — the
  "what links here" panel (M54)
- `drawio/` — the diagram editor tab (ADR-0064)
- `git/` — Git vaults + Source control panel incl. merge, stash, amend,
  file history (ADR-0065 + M67)
- `sample/` — the authoring reference, dev/test-only (ADR-0068);
  `plugins/TUTORIAL.md` + `plugins/AUTHORING.md` are the guides

This map is a starting point, not a fixed contract — but any deviation
should be called out explicitly (see Working Style below), not
introduced silently.

## UI / UX Design

- Visual style: minimal and unobtrusive — flat surfaces, no heavy borders
  or shadows, generous whitespace, no visual clutter. Since milestone 43
  ([ADR-0057](docs/09_architecture_decisions/0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md)):
  chrome labels are sentence-case **sans** (mono only for code, the
  meta-bar path and line numbers); panel controls are **icon-only** with a
  `title` + `aria-label`, drawn with the global `.icon-btn` / `.seg`
  classes (plugins get glyphs via `api.ui.icon`); panel fields carry no
  placeholder text. Two bespoke themes ship — **Drey** (terracotta) and
  **Anthrazit** (neutral charcoal gray, blue accent, AA contrast — ADR-0057 later change; the fresh-install default).
- Overall layout ([ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)):
  a frameless window with a **custom titlebar** (accent square, the two
  dock toggles, the HTML File/Edit/Selection/View menu bar, back/forward
  arrows, window controls; each toggle folds its whole side dock away,
  `Ctrl+B` / `Ctrl+Alt+B`), then a row of **[left dock | centre column |
  right dock]** — the centre column being the editor area above a
  **bottom dock** band — then a 28px **status bar** (word/char count ·
  context hint · Settings entry).
  - **Docks**: three (`left`, `right`, `bottom`), each an ordered list of
    the ten panels — **Calendar, Files, Templates, Search, Tasks, Open
    windows, Outline, Backlinks, Source control, Assistant** (the core
    ones registered by the base; Templates/Search/Tasks/Assistant/
    Outline/Backlinks/Source control are provided by plugins, ADR-0044). A
    panel is dragged between docks by its header, resized against its
    neighbour by a splitter, and **opened or closed from the dock's icon
    strip** — a 32px row at the top of each dock with one icon toggle
    per panel living there (milestone 69, ADR-0019 later change). A
    closed panel shows only as its icon (no header row; status value in
    the tooltip); clicking an open panel's header closes it; the icon is
    draggable like the header. Closing a side dock's last open panel
    folds the dock. Every panel header is built the same way
    (sentence-case title + optional status value + the panel's icon
    controls + drag grip). Default:
    Calendar/Files/Templates/Search/Tasks/Open windows/Outline/Backlinks/
    Source control left, Assistant right, nothing in the bottom band,
    Templates + Search + Tasks + Outline + Backlinks + Source control
    closed. Calendar takes its content height, not a
    flex share; its header is the **month/year dropdown**
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
    row (name, active-vault dot, fold chevron, path tooltip) above the
    tree; in-place create/rename/delete in the tree; the vault row's
    context menu (Set active / Rename / Add vault / Open in File
    Explorer / Remove); drag & drop of files/folders within and across
    vaults (req-23).
  - **Centre column**: a 32px tab bar for open documents — the dock icon
    strips' height (`--panel-head-h`), so their bottom borders form one
    line under the titlebar — a 40px meta bar
    (path · formatting buttons · Unsaved · Lines toggle · Save · `⋯`),
    the editor (Live Preview ⇄ source via the `⋯` menu — no toggle
    buttons; ADR-0008/0009), then the bottom dock band. Capture is the
    `/` menu's **Entry** block.
  - **Settings**: a full-surface overlay opened from the status-bar
    entry — master-detail (category list left, detail pane right), core
    categories in alphabetical order, plugin-contributed categories
    (sorted by label) before "About" via `PluginSettingsHost`. X sits
    top-right; Discard is always enabled and closes (dirty-state
    warning). The confirmation dialog (Actions / Ask edits / MCP
    writes) is a centred modal: inline line diff for localized changes,
    an aligned split diff for whole-document rewrites (ADR-0011).
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
- No visual mockup file exists for the current layout — this section plus
  docs/05 §5.0 are the source of truth for layout intent, not an assumed
  saved mockup.
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
  a component boundary from the Ownership Map above (its detail: docs/05
  §5.0, "Component reference") changes or gets refined.
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

- [specs/changelog.md](specs/changelog.md) — milestones 22–70, newest
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

- **Last completed:** milestone 70 — local plugin packages (ADR-0068:
  the sample plugin left the default build — dev/test + SDK reference
  only, built under `DREY_BUILD_SAMPLE_PLUGINS=1`; `plugins/TUTORIAL.md`
  is the step-by-step authoring guide; Settings → Panels & plugins
  installs a plugin from a `.zip` package / removes it, applies on
  restart). Before it: milestone 69 — the dock icon strip (ADR-0019
  later change, SDK 1.19 `PluginWidgetContrib.icon`), milestone 68 —
  the semantic search remainder (a base `SemanticSearchProvider` seam,
  SDK 1.18, semantic mode in the Search panel and a semantic
  `vault_search` mode, ADR-0055 later change), and milestone 67 — the
  Git plugin's merge, stash, amend and file history.
  Milestones 59–70, the Vault-chip picker, the dev escape hatch and the
  build-origin/mouse-button work are owner-verified.
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
