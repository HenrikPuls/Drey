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
  to plugins (ADR-0044): touching `plugins/**` or `shared/plugin-api/**`
  leaves the running app on the previously built
  `dist-electron/plugins/<id>/` — a changed renderer module 404s or
  misbehaves until rebuilt. After any such change, rebuild and restart
  Electron; verify with
  `grep <new-symbol> dist-electron/plugins/<id> -r` (and
  `grep <new-field> dist-electron/shared/*.js` for base IPC).

## Architecture & Design Decisions

- Electron main/renderer split. No Node integration in the renderer — all
  filesystem and LLM access goes through a `contextBridge` IPC boundary.
- No server/backend process. A vault is just a folder on disk (can live on
  OneDrive); the app reads/writes files directly, no client-server split.
- Editor: CodeMirror 6 in the renderer, extended via Compartments. Plugins
  build editor extensions from the **host's** CM module instances
  (`api.editor.cm`) — never their own runtime copy (a second CM instance
  breaks facets silently; lint-banned under `plugins/**`, ADR-0044 rule 1).
- Storage format: plain Markdown + YAML frontmatter. No proprietary format,
  no database as source of truth (see `specs/frontmatter-schema.md`).
- Folder structure is the user's own — the app imposes only `templates/`
  and `daily/`. Topics are free inline `#tag` labels, never directories
  ([ADR-0017](docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md);
  supersedes the old master-document / routing design).
- Tags are free inline `#tag`s in the note body. No creation flow, no
  routing, no frontmatter `tags[]`. The **tags plugin** (`plugins/tags/`)
  holds the vocabulary (autocomplete + the search panel's tag picker) and
  an inverted index of tagged `##`/`###` sections in its main-process
  `TagIndex`, kept fresh through the save/vault hook registries; its
  **search** panel (AND over tags, AND over free-text terms) returns
  section-level hits with clickable links and a Markdown Export. The MCP
  server's `vault_search` reads the section index through the registered
  `SectionSearchProvider` and degrades with a clear error when the tags
  plugin is disabled. `#task` is reserved; the LLM only _suggests_ tags
  (the drawer's Autotag button — base transport `suggestTags` joined with
  the tags plugin's vocabulary). See `specs/classifier-spec.md`.
- Local LLM over an OpenAI-compatible HTTP API — LM Studio is the default,
  but the client is generic (Unsloth Desktop, llama.cpp, vLLM, Ollama all
  work) with an optional `Authorization: Bearer` API key for servers that
  require auth. No cloud calls, no hardcoded model id — never assume a
  specific model is loaded, and never assume `/v1/models` is reachable
  (the model id must stay hand-enterable).
- sqlite-vec for vector search, transformers.js for embeddings (Phase 2,
  not part of the MVP).
- **No file watcher.** A manual refresh button re-reads the vault; the
  base fires a vault-change event and the plugins re-index from it
  (vault-hook registry). The app also refreshes after its own writes
  (save, first daily-draft save, create/delete). chokidar stays a
  purely additive future option
  ([ADR-0018](docs/09_architecture_decisions/0018-manual-refresh-no-file-watcher.md)).
- **Runtime plugin system**
  ([ADR-0044](docs/09_architecture_decisions/0044-runtime-plugin-system.md),
  supersedes the "modular monolith — no plugin runtime" stance of
  ADR-0016/0034): a **base application** (shell, editor + panes, vault/note
  IO, session restore, keybindings, spellcheck, MCP server, LLM
  *transport*, and the two plugin hosts) plus **runtime-loadable,
  in-process, trusted plugins** under `plugins/<id>/` — templates,
  meeting, tags, tasks, assistant (Assistant + Actions), browser, plus a
  `sample` plugin exercising every surface. Each plugin is a full stack:
  `plugin.json` manifest + `main/` (CommonJS, Node) + `renderer/`
  (browser-context ESM + CSS served over `plugin://`, **plain DOM — no
  Angular**) + `shared/` types, built by `scripts/build-plugins.mjs` into
  `dist-electron/plugins/<id>/`. Discovery: built-in root +
  `<userData>/plugins/<id>/` + `DREY_EXTRA_PLUGIN_DIR` (dev). Every
  extension point is a base-owned registry — dock panels, doc kinds,
  Settings pages, menu rows, commands, editor extensions, drop decoders,
  context-menu items, composer slot, save hooks, vault hooks, section
  search — and the SDK in `shared/plugin-api/` is the frozen contract
  (major `apiVersion` gate). IPC is two fixed channels
  (`plugin:invoke` / `plugin:event`); toggling a plugin is
  `plugins.disabled` in app-config (Settings → Panels & plugins) and
  applies on restart. ADR-0016's barrel convention survives for the base
  app's own modules (`eslint.config.mjs` deep-import ban).
  `shared/ipc-api.ts` stays the base cross-layer contract.

## Relevant Components (expected module boundaries)

Base components below; the feature *panels and backends* (tags/search,
tasks, templates, assistant + Actions, meeting import, browser tab) are
**runtime plugins** now — `plugins/<id>/` owns them and
[docs/05 §5.0](docs/05_building_block_view.md) has the seam table. Where
a component moved into a plugin, the entry here says so and stays for the
behavioural contract, not the location.

Main process:

- `VaultManager` — vault registration, active vault, path resolution,
  `deleteEntry()` and `pickSavePath()` (native save dialog rooted at the
  vault)
- ~~`FileWatcher`~~ — not built; manual refresh instead (ADR-0018)
- `electron/plugin-host/` — discovery (built-ins +
  `<userData>/plugins/*` + `DREY_EXTRA_PLUGIN_DIR`; manifest validation;
  `plugins.disabled` + `apiVersion` gating), main-side activation
  (quarantine on throw), per-plugin config store, and the registries the
  plugins fill: **save hooks** (`onNoteSaved → {content?,
  pendingActions?}`; skipped when the save applies a confirmed rewrite),
  **vault hooks** (open/refresh/write/delete/rename) and the
  **section-search provider** (the MCP `vault_search` backend)
- `TagIndex`, `TaskIndex`, `ActionRunner`/`ChatStore` — **moved into the
  tags / tasks / assistant plugins** (same shapes and lifecycles:
  `rebuild` on vault open/refresh via vault hooks, `reindexFile` on save
  via save hooks; the assistant's engine keeps trigger→prompt-template
  Actions, Ask and the per-note sidecar thread). `suggestTags` (the
  Autotag prompt) stayed base in `electron/llm/tag-suggest.ts`
- `LmStudioClient` — thin HTTP client for the local OpenAI-compatible
  endpoint (`GET /models`, `POST /chat/completions`), with an optional
  bearer API key; name kept for continuity, but not LM-Studio-specific.
  **No timeout on generation** — a local model may think for minutes; the
  user cancels instead ([ADR-0014](docs/09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md)).
  Its optional tool loop (`vaultTools` chat option) still backs the
  assistant plugin's vault tool use when `mcp.enabled`
- `LlmTaskRegistry` — one `AbortController` per in-flight generation, so
  `llm:cancel` can abort it
- `AppConfigStore` — reads/persists `app-config.json` under the OS user-data
  dir (LLM connection + spellcheck + appearance + MCP + `widgets` +
  `plugins` slices); app config, never in the vault
  ([ADR-0010](docs/09_architecture_decisions/0010-app-settings-storage.md))
- `electron/mcp/` ([ADR-0021](docs/09_architecture_decisions/0021-mcp-vault-server.md)) —
  the vault MCP server. `VaultTools` (`vault_search` with a regex filter /
  `vault_read` / `vault_write`), `McpServer` (hand-rolled JSON-RPC 2.0),
  `McpHttpTransport` (opt-in localhost `POST /mcp`) and a standalone
  `stdio-bridge.ts` script. `vault_write` routes through the ADR-0011
  confirmation dialog (main→renderer bridge) unless "YOLO mode" is on.
  `vault_search` degrades to a clear "tags plugin disabled" error when no
  section-search provider is registered
- `SpellcheckService` (main) — nspell + the bundled/added Hunspell
  dictionaries; answers `spell:check` with misspelled words + suggestions

Renderer (Angular):

- ~~`SidebarComponent`~~ — removed with the v3 dock rebuild
  ([ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)).
  `App` composes a **titlebar / [left dock | main | right dock] / status
  bar** shell directly.
- `DockService` + `Dock` + `PanelFrame` (`src/app/dock/`) — the dock
  system: `DockService` holds the whole `LayoutState` (which panel in
  which dock, order, `flexes`, collapse, `leftW`/`rightW`, `bottomH`;
  `localStorage['drey.dock']`) and runs the header-drag / splitter /
  dock-edge-resize gestures. Three docks — `left | right | bottom` (the
  bottom one a resizable band under the editor). Panels come from the
  runtime **`WidgetRegistryService`** (ADR-0044): core panels register via
  `registerCoreWidgets()` — `CalendarPanel`, `FilesPanel` (the old
  sidebar's vault switcher + file tree + right-click new/delete + inline
  create), `WindowsPanel`, `SearchPanelHost`, and `EntryPanel` (the
  "Add entry" drawer — default home: the bottom dock) — while the
  templates / search / tasks / assistant panels are **plugin widgets**
  mounting plain DOM into `PluginWidgetHost`. Same ids as before (the
  persisted layout keys on them).
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
- _Search panel_ — **moved into `plugins/tags/`** (a DOM dock widget):
  tag chips + free text → section hits (click opens the file at the line
  through the document API), and an **Export** button that dumps the hits
  into an unsaved `search-results.md` scratch tab
- _Tasks panel_ — **moved into `plugins/tasks/`** (a DOM dock widget,
  ADR-0033): checkbox / `#task` lines in the open document or the whole
  vault, a scope toggle · "hide done" · a kind filter (all persisted to
  `localStorage['drey.tasks']`). Document scope scans the live editor
  buffer through the document API; vault scope calls the plugin's own
  `backend.invoke('list', …)` (its `TaskIndex`, refreshed via save/vault
  hooks). A row's checkbox rewrites the buffer line through
  `documents.setBuffer` + save; a row click opens the file at the line
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
  own `TabBar` + `EditorComponent`/`ImageTab`. `EditorService` no longer
  owns tab membership/order itself — it is a facade over the *focused*
  pane's document (`activePath`, `isDirty`, `save()`, word count, …), so
  every other "current document" consumer (Assistant, Tasks, Actions, the
  status bar, MCP tools, keybindings, the calendar, tag search's "open at
  line") needed no change. One pane per open path (not the same note live
  in two panes at once); a tab's own "Split right"/"Split down" (its
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
  (ADR-0027 / ADR-0028 amendment). Docking a pane into the
  left/right/bottom dock is a separate follow-up (ADR-0038), not built yet.
- `EditorComponent` — one CodeMirror 6 view **per pane** (`[paneId]`
  input; `shownPath`/`shownDoc` resolve *that pane's* document via
  `PaneService`) with an inline Live Preview mode (decoration-based,
  ADR-0009) and a raw source mode, switched via a `⋯` mode menu
  (ADR-0008); the same `⋯` menu lists the manual Actions and "Save as…".
  A 34px meta bar carries the path, a **Lines** toggle (line-number
  gutter, `Ctrl+G`, an app-wide preference — not per-pane), Save/Saved and
  the `⋯` menu (no assistant toggle — the panel is shown/collapsed from
  its own dock header). The **fold gutter** is always live (Obsidian-style
  collapsible headings, hover-revealed chevron); only the line-number
  column follows the Lines toggle (`editorStructure` / `gutterTheme`). Inline `#tag`s render as pills; `Ctrl`/`Cmd`-click
  runs a tag search. Global per-id requests (quick-capture, the
  assistant's insert-into-note) are gated on `PaneService.focusedId()`, so
  only the focused pane's instance acts on one. `EditorService.requestInsertText` (consumed here) backs the
  assistant's insert-into-note arrow
- `EntryDrawerComponent` — the "Add entry" capture surface: an optional
  TOPIC field, **one** Tags chip row (+ an Autotag button), then the
  shared Markdown editor component in compact mode with inline
  spellcheck. An empty TOPIC is fine — no confirmation
  ([ADR-0013](docs/09_architecture_decisions/0013-inline-spellcheck.md)).
  It is now the body of `EntryPanel`, a movable dock panel (default
  home: the bottom dock) — no self-toggle button; `PanelFrame`'s chevron
  collapses it
- _Assistant panel_ — **moved into `plugins/assistant/`** (a DOM dock
  widget, ADR-0012): the per-note "Automatic summary" switch, the
  summary/question/answer card thread, and the question composer. Ask
  sends the prior thread as chat turns, each card has Copy +
  **insert-into-note**, and the manual Actions live in the editor `⋯`
  menu as `editor-more` menu contributions
- `McpBridgeService` — renderer side of the vault MCP server: shows an
  MCP client's `vault_write` in the shared confirmation diff and replies;
  refreshes the file tree on the vault-change push (the plugins re-index
  from the same push)
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
  discovered plugin's live status), and "MCP"; **plugin-contributed
  categories** (templates, assistant, actions) append before "About" and
  render through `PluginSettingsHost`, saving immediately rather than via
  the footer bar (ADR-0044 rule 3). Opened from the status-bar entry.
  Category list is descriptor-driven (`*ngComponentOutlet`, ADR-0016). The
  close (X) is top-right; the footer Discard is always enabled and closes,
  warning first when the draft is dirty
- `ConfirmationDialogComponent` — the one confirmation dialog shared by
  Actions, Ask-mode edits and MCP `vault_write` (inline line diff for a
  localized change; an **aligned split diff** — equal-size halves — for a
  whole-document rewrite; "don't ask again")
  ([ADR-0011](docs/09_architecture_decisions/0011-unified-confirmation-flow.md))
- ~~`TagsOverviewComponent`~~, ~~`InboxComponent`~~ — not built; tag
  search replaces the overview, and there is no untagged-capture inbox
  (ADR-0017)

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
    (clicking a file opens it; right-click → new file/folder/delete).
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
    + editor typeface, ADR-0020), "Panels & plugins" and "MCP"
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

## Current Scope: Phase 1 (MVP)

Only implement what `roadmap.md` lists under "Phase 1 — MVP". Everything
under Phase 2/3/4 and "Future Scope" is intentionally out of scope for now.
If unsure whether a feature already belongs in this phase: ask, don't
assume.

## Build Order (Milestones)

1. Electron shell + Angular scaffold, IPC bridge, docs/ skeleton (including the 09_architecture_decisions/ subfolder)
2. Vault selection + file listing
3. Editor: CodeMirror 6 with decoration-based Live Preview + source mode, `⋯` mode menu (ADR-0008/0009)
4. Quick-capture (global hotkey, popup window)
5. Implement multi tab support (x to close tab, only prompts to safe if program is closed not by switching editors )
6. Tag parsing, autocomplete, registry index, deterministic routing
7. LM Studio client + task/note classification (Prompt 1)
8. Inbox + batch tag suggestion (Prompt 2)
9. Keyword search
10. Master document summary — now the built-in "Update summary" Action (see 10)
11. Settings screen (LLM connection + Actions engine) + one shared
    confirmation flow + chat Input/Ask toggle. Built in a single pass on
    top of milestone 6, pulling forward the LM Studio client (6), batch
    tag suggestion / Prompt 2 as the "Autotagging" built-in (7), and the
    master-document summary (9). ADR-0010 (settings storage), ADR-0011
    (unified confirmation flow).
12. **Tag rebuild** — milestones 5, 7, 8 and 9 above are **superseded**
    ([ADR-0017](docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md)):
    free `#tag`s, a vocabulary + inverted section index, a sidebar tag
    search (tags AND + free text) with open-at-line and Markdown Export,
    and the vocabulary-based Autotag button. Also: feature modules
    (ADR-0016), manual refresh instead of a watcher (ADR-0018), file
    delete, nested daily-note paths, scratch tabs + Save-as.
13. Prompt sweep to English + docs/specs/ADR reconciliation.
14. **v3 visual system + dock layout** — the `handoff/` design system
    ([ADR-0019](docs/09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)):
    central design tokens, a frameless titlebar with an HTML menu bar,
    two docks of movable/resizable/collapsible panels (calendar, files,
    search, open windows, assistant) replacing `SidebarComponent`, a
    status bar, line numbers in the editor, and the tab/meta-bar + drawer
    reskin. Built in five steps (tokens → shell → dock mechanics → the
    five panels → editor chrome), pausing after each.
15. **MCP + shell follow-ups** — built in one pass at the project owner's
    request: the vault MCP server + assistant vault tool use
    ([ADR-0021](docs/09_architecture_decisions/0021-mcp-vault-server.md)),
    a **bottom dock** with "Add entry" as a panel (ADR-0019 later change),
    the assistant carrying its thread on Ask + an insert-into-note arrow,
    the split-diff confirmation preview (ADR-0011 update), and the
    content-height calendar panel.
16. **Named themes** — a theme picker in Settings → Appearance
    ([ADR-0035](docs/09_architecture_decisions/0035-named-ui-themes.md)): the
    **Drey** built-in look plus the published CodeMirror 6 themes
    (`@uiw/codemirror-themes-all`), the editor swapping its CM theme in a
    compartment and the app shell re-tinting from a per-theme seed
    (`src/styles.css` `:root[data-theme]`, `ThemeService`).
17. **Widget registry + View visibility** — the dock panels become a
    data-driven `src/app/widgets/` registry with a typed `WidgetContext`
    read-facade (active document, file tree, tag/task queries); the View
    menu hides/shows a whole widget rather than only collapsing it
    ([ADR-0034](docs/09_architecture_decisions/0034-internal-widget-model.md);
    refines ADR-0016, amends ADR-0019). Internal structure only — no
    runtime/third-party plugin loading.
18. **Settings → Widgets enable/disable** — a `widgets` config slice + a
    Settings category to turn a widget off entirely (ADR-0034).
19. **Editor polish + split-view panes** — five owner-requested fixes/
    features built in one pass: the frontmatter-fold block widget's height
    measurement (`margin` → `padding`) and its `inline-flex` baseline
    leading (`vertical-align: top`), both of which drifted the gutter and
    click hit-testing below the fold; per-file syntax highlighting for
    non-Markdown files via a language `Compartment` on `MarkdownSurface`,
    forcing source mode and dropping the Markdown-only chrome
    ([ADR-0036](docs/09_architecture_decisions/0036-code-file-editor-mode.md));
    the Tasks panel's vault-scope rows/headers sized to content instead of
    clipping; drag-to-reorder tabs in the tab bar; and split-view editor
    panes — an arbitrary row/column split tree (`PaneService`,
    `PaneLayout`/`PaneLeaf`), `EditorService` reframed as a facade over the
    *focused* pane so every other "current document" consumer needed no
    change ([ADR-0037](docs/09_architecture_decisions/0037-split-view-editor-panes.md)).
    Docking a pane into the left/right/bottom dock is its own follow-up
    (ADR-0037's Phase 2), not built here.
19a. **Gutter alignment + split-view entry points** — a follow-up after the
    milestone-19 gutter fixes proved insufficient: the real cause was the
    line-number element inheriting the unitless `1.72` line-height from
    `.cm-scroller` (re-multiplied against its 10.5px font) plus an
    un-hidden markdown fold-arrow column (base theme `.cm-gutter { display:
    flex !important }` beat a plain `display:none`). Fixed in `gutterTheme`
    (explicit px `line-height` + `flex-start` top-alignment; `display: none
    !important` on `.cm-foldGutter`). Same pass: `pane.splitRight/splitDown/
    focusNext/focusPrev` `KeybindingService` commands + View-menu rows
    (the split tree already existed, only the tab context menu reached it),
    and `Editor` pulls the caret into a pane on focus-gain.
19b. **Drag-and-drop chrome** ([ADR-0039](docs/09_architecture_decisions/0039-drag-and-drop-chrome.md))
    — the tab drag was a fake drag (committed live on every mousemove). A
    shared `src/app/dnd/` overlay (kills hover/selection leak, owns the
    cursor) + ghost, a new `TabDragService` owning the gesture (deferred
    commit, drop-line, `no-drop` on invalid targets, tab-strip *or*
    pane-body drop, ESC / blur cancel, the `data-drey-gesture` watchdog
    marker), and `DockService`'s header drag moved onto the same overlay.
19c. **Editor fold gutter + drop-to-open** — two owner-flagged follow-ups.
    (1) Milestone 19a hid `.cm-foldGutter` outright; the Obsidian-style
    collapsible headings that killed are back — the fold column is now
    always-on in `editorStructure` (chevron styled + hover-revealed, same
    vertical metrics as the line-number element so no drift returns), and
    only the line-number column follows the "Lines" toggle
    (`gutterTheme`). (2) A vault file dropped on a pane but not on
    `.cm-content` opens as a tab there — `PaneDropService`, from
    `PaneLeaf`'s `dragover`/`drop` (ADR-0027 / ADR-0028 amendment).
20. **Editor panes in the docks** — ADR-0037's Phase 2, designed in
    [ADR-0038](docs/09_architecture_decisions/0038-editor-panes-in-docks.md):
    a `PaneService` *region* model (`center` + `dock-left/right/bottom`) and
    a dock "editor slot", leaving the `WidgetDescriptor` registry (ADR-0034)
    untouched. Not built.
21. **The runtime plugin program**
    ([ADR-0044](docs/09_architecture_decisions/0044-runtime-plugin-system.md)) —
    the modular monolith became a base application plus runtime-loadable,
    in-process plugins. SDK freeze → hosts + `plugin://` + sample plugin →
    base seams (editor extensions, drop decoders, save/vault hooks,
    section search) → the six feature modules converted one by one
    (templates, meeting, tags, tasks, assistant+Actions, browser — the
    browser's doc-kind registry shipped first, shippable alone) → cleanup
    + docs. `eslint.config.mjs` shrank to the base modules and gained the
    plugin authoring rules (no `@codemirror/*` / `@angular/*` runtime
    imports, no Node in plugin renderers); Settings → "Panels & plugins"
    manages both panels and plugins.

Pause after each milestone, show what works, don't push through several
milestones in one uninterrupted stretch. (Milestones 10, 11, 15 and 19 were
explicit exceptions — built in one stretch at the project owner's request.)

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
