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
  attributes, native Electron dialog titles and text, and the *names* of
  built-in Action templates. No exceptions, including for features whose
  content is German — a German mockup or a German feature request is a
  description of the layout and behaviour, **not** an instruction to write
  German labels. Translate them.
- Content the user actually writes into vault files at runtime (notes, tags,
  master document text) stays **German** — that's user data, not a code
  artifact, and is out of scope for this convention.
- LLM prompt templates (system prompts sent to LM Studio) are the one
  deliberate exception on the *code* side: they are written in German in
  `specs/classifier-spec.md` and `shared/app-config.ts` because they
  process German note text. Keep them German unless testing shows English
  performs better with the chosen local model — this is a judgment call to
  flag, not silently decide either way. The prompt *text* is German; the
  template's display name is not.

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
- **`npm run dev` builds `dist-electron/` only once, at startup**, while
  `ng serve` hot-reloads the renderer forever. Since `shared/` compiles into
  both contexts, touching `shared/` or `electron/` leaves the two sides
  disagreeing about the IPC contract *at runtime* even though `tsc` is
  clean — fields the stale main process doesn't know get silently stripped
  from IPC payloads. After such a change, rebuild and restart Electron;
  verify with `grep <new-field> dist-electron/shared/*.js`.

## Architecture & Design Decisions
- Electron main/renderer split. No Node integration in the renderer — all
  filesystem and LLM access goes through a `contextBridge` IPC boundary.
- No server/backend process. A vault is just a folder on disk (can live on
  OneDrive); the app reads/writes files directly, no client-server split.
- Editor: CodeMirror 6 in the renderer. Chosen specifically because its
  extension model natively covers "plugin"-style features (spellcheck,
  syntax highlighting) — no custom plugin-loader framework needed or wanted.
- Storage format: plain Markdown + YAML frontmatter. No proprietary format,
  no database as source of truth (see `specs/frontmatter-schema.md`).
- Folder structure is not hardcoded — folders emerge dynamically per tag.
  See the `master` / `notiz` file types in `specs/frontmatter-schema.md`.
- Tag-first capture: a typed `#tag` deterministically routes a note to its
  target file/folder with no LLM call. The LLM is only a fallback for
  untagged input (see `specs/classifier-spec.md`).
- Local LLM over an OpenAI-compatible HTTP API — LM Studio is the default,
  but the client is generic (Unsloth Desktop, llama.cpp, vLLM, Ollama all
  work) with an optional `Authorization: Bearer` API key for servers that
  require auth. No cloud calls, no hardcoded model id — never assume a
  specific model is loaded, and never assume `/v1/models` is reachable
  (the model id must stay hand-enterable).
- sqlite-vec for vector search, transformers.js for embeddings (Phase 2,
  not part of the MVP).
- File watching via chokidar. Must distinguish frontmatter-only changes
  from body changes and from newly appeared untracked files (see roadmap,
  "Phase 1").

## Relevant Components (expected module boundaries)

Main process:
- `VaultManager` — vault registration, active vault, path resolution
- `FileWatcher` — chokidar wrapper, emits typed change events
  (frontmatter-change / body-change / untracked-new-file)
- `TagIndex` — in-memory registry of all tags and their master-document
  metadata; source for both autocomplete and the classifier registry
- `LmStudioClient` — thin HTTP client for the local OpenAI-compatible
  endpoint (`GET /models`, `POST /chat/completions`), with an optional
  bearer API key; name kept for continuity, but not LM-Studio-specific.
  **No timeout on generation** — a local model may think for minutes; the
  user cancels instead ([ADR-0014](docs/09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md))
- `LlmTaskRegistry` — one `AbortController` per in-flight generation, so
  `llm:cancel` can abort it
- `ClassifierService` — wraps the two prompts from `specs/classifier-spec.md`
- `AppConfigStore` — reads/persists `app-config.json` under the OS user-data
  dir (LLM connection + Actions config); app config, never in the vault
  ([ADR-0010](docs/09_architecture_decisions/0010-app-settings-storage.md))
- `ActionRunner` — runs an Action (trigger → prompt template) against the
  active document → an edit / no-op / error outcome; also hosts Ask and the
  note assistant's summary
- `ChatStore` — reads/writes the assistant's per-note sidecar thread
  (`.{name}.chat.json` beside the note, ADR-0012)
- `SpellcheckService` (main) — nspell + the bundled/added Hunspell
  dictionaries; answers `spell:check` with misspelled words + suggestions

Renderer (Angular):
- `SidebarComponent` — calendar, folder/tag tree, open windows, settings entry
- `EditorComponent` — one CodeMirror 6 view with an inline Live Preview
  mode (decoration-based, ADR-0009) and a raw source mode, switched via a
  `⋯` mode menu (ADR-0008); the same `⋯` menu lists the manual Actions
- `EntryDrawerComponent` — the "Add entry" drawer at the bottom of
  the main area (replaced the old chat bar's Input mode): TOPIC field
  first, then Tags / People / Meetings chip rows, then the shared
  Markdown editor component in compact mode with inline spellcheck. An
  empty TOPIC raises an inline confirmation before appending
  ([ADR-0013](docs/09_architecture_decisions/0013-inline-spellcheck.md))
- `NoteAssistantComponent` — the right-hand panel (replaced the old chat
  bar's Ask mode): the per-note "Automatic summary" switch, the
  summary/question/answer card thread, and the question composer
  ([ADR-0012](docs/09_architecture_decisions/0012-note-assistant-sidecar-thread.md))
- `SettingsComponent` — master-detail settings screen (category list +
  detail pane), categories "LLM", "Assistant" (auto-summary default),
  "Spelling" (dictionaries + language) and "Actions"; opened from
  the sidebar entry
- `ConfirmationDialogComponent` — the one confirmation dialog shared by
  Actions and chat Ask-mode edits (inline diff vs. side-by-side, "don't
  ask again")
  ([ADR-0011](docs/09_architecture_decisions/0011-unified-confirmation-flow.md))
- `TagsOverviewComponent` — browsable tag list, opens the matching master document
- `InboxComponent` — review queue for untagged captures, new-folder proposals,
  and untracked external files

This is a starting point, not a fixed contract — but any deviation should
be called out explicitly (see Working Style below), not introduced silently.

## UI / UX Design
- Visual style: dark theme by default, minimal and unobtrusive — visual
  language similar to claude.ai (flat surfaces, no heavy borders or
  shadows, generous whitespace, sentence-case labels, no visual clutter).
- Overall layout: two columns, sidebar on the left, main area on the right.
  - **Sidebar**, top to bottom: a small calendar → a browsable folder/tag
    tree (clicking an item opens the corresponding file or master
    document) → a list of currently open windows/tabs → a settings entry
    pinned at the very bottom.
  - **Main area**: a tab bar across the top for currently open documents,
    the editor below it (Live Preview ⇄ source via a `⋯` menu on the
    chrome — no toggle buttons; see ADR-0008/0009), and the "Eintrag
    hinzufügen" drawer pinned to the bottom.
  - **Right column**: the note assistant panel for the open note —
    auto-summary switch, card thread, composer. There is no bottom chat
    bar any more; capture lives in the drawer, Ask in this panel.
  - **Settings**: a full-surface overlay opened from the sidebar entry —
    master-detail (category list on the left, detail pane on the right),
    categories "LLM" and "Actions" (ADR-0010). The confirmation dialog
    (Actions / Ask edits) is a centred modal: inline line diff for small
    changes, side-by-side before/after for whole-document rewrites (ADR-0011).
- Editing model: true in-place Live Preview (Obsidian-style, ADR-0009) —
  the cursor sits in the rendered document, syntax markers reveal only
  around the selection, tables/images render as widgets that show their
  raw Markdown while the selection is inside them. Source mode stays in
  the `⋯` menu as the escape hatch, not a separate "edit mode".
- A visual reference mockup for this layout was discussed and shown inline
  during planning, but it was never saved as a file — treat this section
  (plus the component list above) as the source of truth for layout intent,
  not an assumed saved mockup.

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
  diagrams for the key flows (quick-capture → routing, batch tag
  suggestion, file-watcher reaction, chat/RAG scope resolution) — add one
  as each flow gets implemented, not all up front before they exist.

Use Mermaid diagrams embedded directly in the Markdown files for both views
(renders in VS Code preview and GitHub, no extra tooling needed), unless a
specific diagram genuinely doesn't fit Mermaid's syntax.

Architecture Decision Records are part of arc42 section 9
("Architecture Decisions") per the arc42 template itself — not a separate
top-level folder. Store them under `docs/09_architecture_decisions/`, one
file per decision (`0001-short-title.md`, sequential numbering, MADR-style:
Title, Status, Context, Decision, Consequences). Write an ADR for
structural/lasting decisions with real trade-offs (e.g. the Electron
process split, tag-first classification vs. LLM-per-capture, the storage
format, the master-document/tag mechanism) — not for routine implementation
choices (a specific npm package, a minor naming convention). When in doubt
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
5. Tag parsing, autocomplete, registry index, deterministic routing
6. LM Studio client + task/note classification (Prompt 1)
7. Inbox + batch tag suggestion (Prompt 2)
8. Keyword search
9. Master document summary — now the built-in "Update summary" Action (see 10)
10. Settings screen (LLM connection + Actions engine) + one shared
    confirmation flow + chat Input/Ask toggle. Built in a single pass on
    top of milestone 6, pulling forward the LM Studio client (6), batch
    tag suggestion / Prompt 2 as the "Autotagging" built-in (7), and the
    master-document summary (9). ADR-0010 (settings storage), ADR-0011
    (unified confirmation flow).

Pause after each milestone, show what works, don't push through several
milestones in one uninterrupted stretch. (Milestone 10 was an explicit
exception — built in one stretch at the project owner's request.)

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
