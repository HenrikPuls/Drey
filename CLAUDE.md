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
  `daily/`, and the hidden `.drafts/` (bug-5's exit-time auto-saves of
  untitled tabs, Notepad++-style; invisible to the file tree and indexes,
  see `specs/frontmatter-schema.md`). Topics are free inline `#tag` labels, never directories
  ([ADR-0017](docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md)).
- Tags are free inline `#tag`s in the note body — no frontmatter `tags[]`.
  The **tags plugin** (`plugins/tags/`) holds the vocabulary and the
  inverted index of tagged `##`/`###` sections, kept fresh through the
  save/vault hook registries; its **search** panel (tags AND + free text)
  returns section-level hits with clickable links and a Markdown Export.
  The MCP server's `vault_search` reads the index through the registered
  `SectionSearchProvider` and degrades with a clear error when the tags
  plugin is disabled. `#task` is reserved; the LLM only _suggests_ tags
  (the drawer's Autotag button). See `specs/classifier-spec.md`.
- Local LLM over an OpenAI-compatible HTTP API — LM Studio is the default,
  but the client is generic (Unsloth Desktop, llama.cpp, vLLM, Ollama all
  work) with an optional `Authorization: Bearer` API key for servers that
  require auth. No cloud calls, no hardcoded model id — never assume a
  specific model is loaded, and never assume `/v1/models` is reachable
  (the model id must stay hand-enterable).
- sqlite-vec for vector search, transformers.js for embeddings (Phase 2,
  not part of the MVP).
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
  auto-reload from disk, dirty tabs stay last-writer-wins.
- **Runtime plugin system**
  ([ADR-0044](docs/09_architecture_decisions/0044-runtime-plugin-system.md)):
  a **base application** (shell, editor + panes, vault/note IO, session
  restore, keybindings, spellcheck, MCP server, LLM *transport*, and the
  two plugin hosts) plus **runtime-loadable, in-process, trusted plugins**
  under `plugins/<id>/` — templates, meeting, tags, tasks, assistant
  (Assistant + Actions), browser, `sample`. Each is `plugin.json` +
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

- `VaultManager` — vault registration, active vault, path resolution,
  `deleteEntry()` and `pickSavePath()` (native save dialog rooted at the
  vault); every mutating method records itself in the own-write ledger so
  the watcher can drop its own echoes
- `VaultWatcher` + `OwnWriteLedger` +
  `VaultChangeAnnouncer` (`electron/vault-watcher.ts`,
  `own-write-ledger.ts`, `vault-change-announcer.ts`) — the opt-in vault
  watcher ([ADR-0045](docs/09_architecture_decisions/0045-optional-vault-file-watcher.md)):
  chokidar (injected via a `watchFactory`) → ledger suppression → one
  debounced round (per-`.md` plugin vault-change events + the
  `vault:changed` renderer push with changed paths). The same round backs
  the manual refresh (`vault:refresh`) and MCP writes.
  `EditorService.reloadFromVaultChange` auto-reloads **clean** tabs among
  the changed paths; dirty tabs stay last-writer-wins
- `electron/plugin-host/` — discovery (built-ins +
  `<userData>/plugins/*` + `DREY_EXTRA_PLUGIN_DIR`; manifest validation;
  `plugins.disabled` + `apiVersion` gating), main-side activation
  (quarantine on throw), per-plugin config store, and the registries the
  plugins fill: **save hooks** (`onNoteSaved → {content?,
  pendingActions?}`; skipped when the save applies a confirmed rewrite),
  **vault hooks** (open/refresh/write/delete/rename) and the
  **section-search provider** (the MCP `vault_search` backend)
- The feature backends — `TagIndex`, `TaskIndex`, the assistant's
  ActionEngine + ChatStore sidecar thread — live in their plugins.
  `suggestTags` (the Autotag prompt) stayed base:
  `electron/llm/tag-suggest.ts`
- `LmStudioClient` — HTTP client for the local OpenAI-compatible endpoint
  (`GET /models`, `POST /chat/completions`), optional bearer API key.
  **No timeout on generation** — a local model may think for minutes; the
  user cancels instead ([ADR-0014](docs/09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md)).
  Its optional tool loop (`vaultTools` chat option) backs the assistant
  plugin's vault tool use when `mcp.enabled`
- `LlmTaskRegistry` — one `AbortController` per in-flight generation, so
  `llm:cancel` can abort it
- `AppConfigStore` — reads/persists `app-config.json` under the OS user-data
  dir (all app settings slices: LLM, spellcheck, appearance, MCP,
  `widgets`, `plugins`); app config, never in the vault
  ([ADR-0010](docs/09_architecture_decisions/0010-app-settings-storage.md))
- `electron/mcp/` ([ADR-0021](docs/09_architecture_decisions/0021-mcp-vault-server.md)) —
  the vault MCP server. `VaultTools` (`vault_search` with a regex filter /
  `vault_read` / `vault_write`), `McpServer` (hand-rolled JSON-RPC 2.0),
  `McpHttpTransport` (opt-in localhost `POST /mcp`) and a standalone
  `stdio-bridge.ts` script. `vault_write` routes through the ADR-0011
  confirmation dialog (main→renderer bridge) unless "YOLO mode" is on
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
  `registerCoreWidgets()` — `CalendarPanel`, `FilesPanel` (vault
  switcher + file tree + right-click new/delete + inline create + drag
  & drop of files/folders within the tree, req-23),
  `WindowsPanel`, `SearchPanelHost`, `EntryPanel` (the "Add entry"
  drawer — default home: the bottom dock) — while the templates / search
  / tasks / assistant panels are plugin widgets mounting plain DOM into
  `PluginWidgetHost`. Persisted layout keys on widget ids — plugin
  widgets keep their ids (ADR-0044 rule 5).
  `PanelFrame` is the identical 32px header every panel shares.
  `DockService.contentHeight(id)` marks a panel (currently `calendar`)
  that sizes to its content rather than a flex share.
- `TitlebarComponent` + `MenuBar` + `MenuService` (`src/app/titlebar/`) —
  the frameless-window titlebar: accent square, the HTML File/Edit/
  Selection/View menu bar, and — off macOS — minimize/maximize/close over
  the `window:*` IPC channels
  ([ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)).
  Menu rows dispatch three ways: `KeybindingService` command ids
  (New note, Save, Search…), the `edit:exec` IPC → `webContents`
  (Undo/Redo/Cut/Copy/Paste/Select all, works in any focused field), and
  CodeMirror commands against the surface `EditTargetService` last saw
  focused (Find in note, Select line, Move line, Duplicate selection,
  Toggle task done — disabled when no editor is focused).
- `StatusBarComponent` (`src/app/status-bar/`) — the 26px bottom bar:
  word/char count, a context hint (the drag instruction while a panel is
  moving), and the Settings entry.
- Search panel — `plugins/tags/` (DOM dock widget): tag chips + free text
  → section hits (click opens the file at the line through the document
  API), and an **Export** button that dumps the hits into an unsaved
  `search-results.md` scratch tab
- Tasks panel — `plugins/tasks/` (DOM dock widget, ADR-0033):
  checkbox / `#task` lines in the open document or the whole vault, a
  scope toggle · "hide done" · a kind filter (persisted to
  `localStorage['drey.tasks']`). Document scope scans the live editor
  buffer through the document API; vault scope calls the plugin's
  `backend.invoke('list', …)`. A row's checkbox rewrites the buffer line
  through `documents.setBuffer` + save; a row click opens the file at the
  line
- Assistant panel — `plugins/assistant/` (DOM dock widget, ADR-0012):
  the per-note "Automatic summary" switch, the card thread (Copy +
  **insert-into-note**), the question composer. Ask sends the prior
  thread as chat turns; the manual Actions live in the editor `⋯` menu as
  `editor-more` menu contributions
- `KeybindingService` (`src/app/keybindings/`) — one capture-phase
  `keydown` listener mapping chord strings onto `Command`s; features
  register from `App`. Commands: `search.open` (`Mod+Shift+F`),
  `note.new` (`Mod+N`), `note.save` (`Mod+S`), `note.saveAs`
  (`Mod+Shift+S`), `note.saveAll` (`Mod+Alt+S`),
  `editor.toggleLineNumbers` (`Mod+G`) — the titlebar menu invokes the
  same ids
- `PaneService` (`src/app/panes/`, ADR-0037) — the split-view editor
  layout: an arbitrary tree of row/column splits down to leaf panes, each
  a `{ tabs, active }` record. `PaneLayout` renders the tree recursively
  (draggable splitters between siblings); `PaneLeaf` renders one pane's
  own `TabBar` + `EditorComponent`/`ImageTab`. `EditorService` is a
  facade over the *focused* pane's document (`activePath`, `isDirty`,
  `save()`, word count, …). One pane per open path (not the same note
  live in two panes at once); a tab's own "Split right"/"Split down" (its
  context menu) creates a sibling pane. Dragging a tab is real DnD via
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
  (ADR-0027 / ADR-0028 amendment). Docking a pane into the docks is the
  next milestone (ADR-0038), not built yet.
- `EditorComponent` — one CodeMirror 6 view **per pane** (`[paneId]`
  input; `shownPath`/`shownDoc` resolve *that pane's* document via
  `PaneService`) with an inline Live Preview mode (decoration-based,
  ADR-0009) and a raw source mode, switched via a `⋯` mode menu
  (ADR-0008); the same `⋯` menu lists the manual Actions and "Save as…".
  A 34px meta bar carries the path, a **Lines** toggle (line-number
  gutter, `Ctrl+G`, an app-wide preference — not per-pane), Save/Saved and
  the `⋯` menu. The **fold gutter** is always live (Obsidian-style
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
- `EntryDrawerComponent` — the "Add entry" capture surface: an optional
  TOPIC field, **one** Tags chip row (+ an Autotag button), then the
  shared Markdown editor component in compact mode with inline
  spellcheck. An empty TOPIC is fine — no confirmation
  ([ADR-0013](docs/09_architecture_decisions/0013-inline-spellcheck.md)).
  It is the body of `EntryPanel`, a movable dock panel (default home: the
  bottom dock) — no self-toggle button; `PanelFrame`'s chevron collapses it
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
  detail pane), core categories "LLM", "Add entry", "Daily notes",
  "Spelling", "Appearance",
  [ADR-0020](docs/09_architecture_decisions/0020-app-wide-appearance-accent-and-ui-scale.md),
  "Panels & plugins" (`widgets.disabled` + `plugins.disabled` + each
  discovered plugin's live status), "Vault" (`vault.watch`, the opt-in
  external-change watcher, ADR-0045), and "MCP"; **plugin-contributed
  categories** append before "About" and render through
  `PluginSettingsHost`, saving immediately rather than via the footer bar
  (ADR-0044 rule 3). Opened from the status-bar entry.
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
- Overall layout ([ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)):
  a frameless window with a **custom titlebar** (accent square + "Drey" +
  an HTML File/Edit/Selection/View menu bar + window controls), then a row
  of **[left dock | centre column | right dock]** — the centre column
  being the editor area above a **bottom dock** band — then a **26px
  status bar** (word/char count · context hint · Settings entry).
  - **Docks**: three (`left`, `right`, `bottom`), each an ordered list of
    the eight panels — **Calendar, Files, Templates, Search, Tasks, Open
    windows, Assistant, Add entry** (the core ones registered by the base;
    Templates/Search/Tasks/Assistant are provided by plugins, ADR-0044). A
    panel is dragged between docks by its header, resized against its
    neighbour by a splitter, and collapsed to its 32px header. Every
    panel header is built the same way (chevron +
    mono-uppercase title + optional status value + drag grip). Default:
    Calendar/Files/Templates/Search/Tasks/Open windows left, Assistant
    right, Add entry in the bottom band, Templates + Search + Tasks + Add
    entry collapsed. Calendar takes its content height, not a flex share.
    `View → Reset layout` restores it.
    Layout state persists (`localStorage['drey.dock']`).
  - **Files panel**: a vault-switcher row (name + "Open other vault …",
    with the refresh button on the same row) above the vault file tree
    (clicking a file opens it; right-click → new file/folder/delete;
    dragging a row onto a folder / file row / the tree background moves
    it — req-23, no-drop on a same-dir no-op or a folder into itself).
  - **Centre column**: a 34px tab bar for open documents, a 34px meta bar
    (path · Lines toggle · Save/Saved · `⋯` — no assistant sparkle
    button any more), the editor (Live Preview ⇄ source via the `⋯` menu
    — no toggle buttons; see ADR-0008/0009), then the **bottom dock** band
    (default: the "Add entry" panel).
  - **Assistant panel**: auto-summary switch, card thread (each card has
    Copy + insert-into-note), composer. Ask sends the running thread as
    context. No bottom chat bar; capture lives in the Add entry panel.
  - **Settings**: a full-surface overlay opened from the status-bar entry
    — master-detail (category list on the left, detail pane on the
    right), core categories "LLM", "Add entry", "Daily notes",
    "Spelling", "Appearance" (app-wide base font size + highlight colour
    + editor typeface, ADR-0020), "Panels & plugins", "Vault"
    (ADR-0045) and "MCP"
    (ADR-0010; descriptor-driven list, ADR-0016); plugin-contributed
    categories (templates, assistant, actions) append before "About".
    The X sits top-right; Discard is always active and closes (with a
    dirty-state warning). The
    confirmation dialog (Actions / Ask edits / MCP writes) is a centred
    modal: inline line diff for small changes, side-by-side before/after
    for whole-document rewrites (ADR-0011).
- Editing model: true in-place Live Preview (Obsidian-style, ADR-0009) —
  the cursor sits in the rendered document, syntax markers reveal only
  around the selection, tables/images render as widgets that show their
  raw Markdown while the selection is inside them. Source mode stays in
  the `⋯` menu as the escape hatch, not a separate "edit mode".
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
  and `specs/`.

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
packaging verified — see `docs/07_deployment_view.md`). The milestone log
lives in [docs/milestones-done.md](docs/milestones-done.md).

**Next — milestone 20, editor panes in the docks** (ADR-0037's Phase 2,
designed in
[ADR-0038](docs/09_architecture_decisions/0038-editor-panes-in-docks.md)):
a `PaneService` *region* model (`center` + `dock-left/right/bottom`) and
a dock "editor slot", leaving the widget registry untouched. Not built.

Phase 2+ features from `specs/roadmap.md` (vector search, embeddings, a
dedicated FTS surface, RAG scope resolution) stay out of scope — ask
before pulling any of them in.

## Milestones

The completed milestone log (1–19c and 21, the runtime plugin program) is
archived in [docs/milestones-done.md](docs/milestones-done.md).

- **Last completed:** milestone 21 — the runtime plugin program
  ([ADR-0044](docs/09_architecture_decisions/0044-runtime-plugin-system.md)).
- **Next:** milestone 20 — see "Current State & Next Steps" above.

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
