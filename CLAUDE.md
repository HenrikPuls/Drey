# Notiz-App — Project Context for Claude Code

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
- Content the user actually writes into vault files at runtime (notes, tags,
  master document text) stays **German** — that's user data, not a code
  artifact, and is out of scope for this convention.
- LLM prompt templates (system prompts sent to LM Studio) are a deliberate
  exception: they are written in German in `specs/classifier-spec.md`
  because they process German note text. Keep them German unless testing
  shows English performs better with the chosen local model — this is a
  judgment call to flag, not silently decide either way.

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
- Local LLM via LM Studio (OpenAI-compatible HTTP API). No cloud calls, no
  hardcoded model id — never assume a specific model is loaded.
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
- `LmStudioClient` — thin HTTP client for the local OpenAI-compatible endpoint
- `ClassifierService` — wraps the two prompts from `specs/classifier-spec.md`

Renderer (Angular):
- `SidebarComponent` — calendar, folder/tag tree, open windows, settings entry
- `EditorComponent` — CodeMirror 6 wrapper, source/rendered toggle
- `ChatInputComponent` — bottom input bar, document-scope vs. all-notes-scope toggle
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
    the editor below it (source/rendered toggle per the note in
    Architecture & Design Decisions), and a chat input bar pinned to the
    bottom with a scope toggle ("this document" / "all notes").
- Editing model: click directly into rendered content to start editing in
  place — no separate "edit mode" button or dialog, similar to how
  Obsidian's reading view behaves.
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
3. Editor (CodeMirror 6): open/save a file, source/rendered toggle
4. Quick-capture (global hotkey, popup window)
5. Tag parsing, autocomplete, registry index, deterministic routing
6. LM Studio client + task/note classification (Prompt 1)
7. Inbox + batch tag suggestion (Prompt 2)
8. Keyword search
9. Master document summary (manual button)

Pause after each milestone, show what works, don't push through several
milestones in one uninterrupted stretch.

## Working Style — important
This is meant to feel like pair programming, not a silent code generator:
- For every meaningful decision, briefly explain WHY this library/pattern/
  approach was chosen — especially where real trade-offs exist (which
  CodeMirror extension, how IPC messages are structured, why one package
  over another).
- Don't comment or explain every line of code — explanation belongs in the
  conversation, not in code comments.
- If something deviates from the `specs/` documents: say so explicitly and
  justify it, don't silently implement it differently.
- For genuine alternatives with different trade-offs: state the options and
  a recommendation, then wait for confirmation — don't just pick the most
  likely option and run with it unasked.
