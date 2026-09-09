# 29. Template library: a vault sub-folder, folder = category, insert at cursor

## Status

Accepted. Reuses the vault file APIs (`vault:list-files` / `vault:read-file`,
[ADR-0001](0001-electron-process-split-contextbridge.md)), the placeholder
substitution from [ADR-0022](0022-configurable-entry-templates.md)
(`shared/placeholders.ts`), the feature-module convention
([ADR-0016](0016-feature-module-convention.md)), and the drop pipeline of
[ADR-0028](0028-drag-drop-into-the-editor.md). Config lives in
`app-config.json` ([ADR-0010](0010-app-settings-storage.md)).

## Context

`templates/` was a main-process-only concept — `DailyNoteManager` reads
`templates/daily.md` to seed a daily note, and `TagIndex` skips the folder.
There was no way to browse or insert reusable Markdown (a meeting skeleton,
a decision block, a checklist). The project owner wanted:

- a **flat filesystem** library — plain `.md` files, no database, no
  creation flow;
- **whole notes and fragments** — insertable into the current note;
- the folder **configurable**;
- each **sub-folder a category**, nested sub-folders sub-categories, every
  `.md` shown, labelled by its filename;
- **drag-and-drop** into the editor (already most of the way there via
  ADR-0028), a **right-click** "insert template", and a **keyboard
  shortcut**.

## Decision

**A configurable vault-relative sub-folder, read through the existing vault
file APIs, rendered as a category tree, inserted at the cursor with
frontmatter stripped and placeholders substituted.**

- **Config.** `templates: { dir: string }` on `AppConfig`, default
  `templates`. `normalizeTemplatesConfig` trims, folds back-slashes, strips
  leading/trailing `/`, and rejects any `.`/`..` segment (so it can never
  escape the vault) — malformed → `templates`. A one-field "Templates"
  settings category edits it (draft/Save like every other category).
- **No new filesystem IPC.** The folder must live inside the vault, so
  `TemplateLibraryService` (`src/app/templates/`) builds its tree from
  `VaultService.fileTree()` (already loaded, and refreshed on every vault
  change) and reads a file with `VaultService.readTextFile()`. Pointing the
  library at an arbitrary directory outside the vault would have needed a
  new main-process FS surface with its own containment guard; it was not
  worth it for v1.
- **Category tree.** The directory node at `dir` → `TemplateCategory {
  name, path, templates: TemplateEntry[], children: TemplateCategory[] }`,
  recursively. `.md` files sitting directly in the root go under a
  synthetic **General** group. `TemplateEntry.name` is the filename minus
  `.md` — the label shown in the panel, the picker and the context menu.
- **Insert = at the cursor, frontmatter stripped.** `insert(path)` reads
  the file, runs `stripFrontmatter` (`src/app/editor/markdown-frontmatter.ts`)
  then `substitutePlaceholders` (`{{date}}` / `{{time}}` / `{{datetime}}` =
  now; `{{title}}` = the active note's base name), and calls
  `EditorService.requestInsertText` (replaces the selection, no-ops with no
  text tab). There is **no "new note from template"** flow — every template
  is treated as a fragment. Whole-note templates simply keep their body;
  their frontmatter is dropped rather than injected mid-document.
- **Four ways in**, all funnelling to `insert()`:
  - the **Templates dock panel** (`PanelId 'templates'`, left dock,
    collapsed by default) — collapsible category groups, click a row to
    insert, right-click for Insert / Edit template;
  - **drag** a row into the editor — the row's `dragstart` sets
    `application/x-drey-template` = the vault path; `image-paste.ts` gains a
    branch (before the generic `application/x-drey-vault-path` one) that
    reads + strips + substitutes and inserts at the **drop coordinate**.
    The row deliberately does not set the plain vault-path type, so it can
    never hit the raw-inline branch;
  - the **`Mod+T` picker** — an overlay with the last 5 used templates on
    top (tracked in `localStorage['drey.templates.recent']`), then a filter
    box + the full list; Arrow keys + Enter;
  - the **editor right-click menu** (ADR-0030) — its "Insert template"
    section lists the recent templates + "All templates…".
- **TagIndex.** `TagIndex` takes an optional `() => templatesDir` getter
  and excludes that folder on top of the always-excluded literal
  `templates/`, so snippet headings never leak into tag search /
  autocomplete. `configSet` rebuilds the index when `templates.dir`
  changes.

### Alternatives considered

- **Arbitrary directory outside the vault.** More flexible (a shared
  templates folder on OneDrive), but needs a whole new guarded FS IPC
  surface. Deferred; the config field can grow an absolute-path mode later.
- **Distinguish whole-note vs. fragment by frontmatter presence**, routing
  the former to a new "New note from template". Rejected as scope — "insert
  at the cursor, always" is one predictable behaviour, and stripping
  frontmatter makes a whole-note template a usable fragment.
- **A new DataTransfer type vs. reusing `application/x-drey-vault-path`.**
  A distinct type keeps template semantics (strip + substitute) separate
  from the Files-panel "inline raw" behaviour with no ambiguity.
- **Enforce the module boundary in `eslint.config.mjs`.** A plain
  `src/app/settings/templates/` folder already exists, so a `templates`
  path pattern would flag innocent imports — the same reason `llm` is left
  out. The barrel is followed by convention.

## Consequences

- `templates/daily.md` now also shows up in the library (under General) —
  harmless, and arguably useful.
- Changing `templates.dir` to a folder that already has `##` sections with
  tags removes those tags from search after the rebuild; changing it back
  restores them.
- The recent list is per-machine (`localStorage`), like the editor view-mode
  preference — it does not sync and can come back empty.
- No file watcher (ADR-0018): the panel reflects new template files after a
  vault refresh (its header has a refresh button) or the app's own
  post-write refreshes.
