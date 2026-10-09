# 16. Feature-module convention (thin barrels + ESLint-enforced boundaries)

## Status

Accepted — introduced with the path-based-tags restructure (milestones
M0.1–M0.3), extended with the keybinding module, then with the
`dock` / `titlebar` / `widgets` modules, then with the renderer service
reorg (see "Later change: renderer feature modules" below).

**Amended by [ADR-0044](0044-runtime-plugin-system.md):** the "explicitly
a modular monolith — no runtime loading" stance is superseded by the
runtime plugin system; the barrel/boundary convention itself survives for
the base app's own code, and the converted feature modules live on as
plugins under `plugins/`.

## Context

The process split of [ADR-0001](0001-electron-process-split-contextbridge.md)
(main / renderer / `shared/`) is the only structural seam the codebase
had. Inside each layer, files that belong to one feature sat scattered
among unrelated ones, and any file could import any other. As the LLM /
Actions code and then the tag rewrite grew, this got in the way:
refactors touched files all over a layer, and there was no declared
"public surface" for a feature — every internal helper was fair game for
an outside import.

The project owner also wants the tag and LLM features to eventually be
the seed of a **plugin system**. That argues for drawing internal module
boundaries now, with that end state in mind — but _not_ for building a
plugin runtime yet.

## Decision

### One feature folder per layer, with a thin `index.ts` barrel

The barrel is the module's **only** public surface: the one service /
class, the types that cross into other modules, and a small number of
genuinely public pure functions. Internal helpers are not re-exported. A
module's own files import their siblings directly, not through the barrel.

Current modules:

| Layer    | Folder                                  |
| -------- | --------------------------------------- |
| main     | `electron/llm/`, `electron/tags/`       |
| shared   | `shared/llm/`, `shared/tags/`           |
| renderer | `src/app/tags/`, `src/app/keybindings/` |

`shared/ipc-api.ts` stays the cross-layer contract and is **not** moved
into a module — both sides import it directly.

### The boundary is CI-enforced, narrowly

`eslint.config.mjs` (flat config, `typescript-eslint`, run via
`npm run lint`) is deliberately not a full lint pass — it exists only for
this. `no-restricted-imports` patterns make a deep import into
`**/llm/**` or `**/tags/**` (and the relative `keybindings/`) from
outside the module a CI error; the module's own files opt out. Renderer
Angular components are still imported by path where Angular needs the
class, but a cross-module component import goes through the barrel (e.g.
`SearchPanel` is re-exported from `src/app/tags/index.ts` so `Sidebar`
can import it from `../tags`).

### Feature-owns-settings — the form now, the runtime later

A settings category is a descriptor `{ id, label, hint, component }`, and
the settings screen renders its category list from a **data array** via
`*ngComponentOutlet` instead of a fixed `@switch`
([ADR-0010](0010-app-settings-storage.md)). The fuller idea — each
feature module also exporting `defaultConfig` / `normalize` slices that
`normalizeAppConfig` composes — is scaffolded but deferred; `AppConfig`
stays **one statically-typed interface** (union of all feature slices),
so "explicit typing, no `any`" holds.

### Explicitly a modular monolith

No dynamic loading, no third-party modules, no runtime config extension.
The boundaries are for maintainability and to make a future plugin
runtime a smaller step — that runtime is a named future, not this
decision.

## Consequences

- New feature code has an obvious home and a declared surface; "what may
  the rest of the app use" is the barrel, checked by CI.
- Moving a file into or out of a module is now a visible change (the
  barrel plus the ESLint file lists), not a silent one.
- The ESLint config carries no style/quality rules — that is intentional;
  a broader pass can be added later without disturbing the boundary rule.
- A little duplication at the barrel (re-exporting a component for one
  outside importer) is accepted as the price of the seam.

## Later change: renderer feature modules (service reorg)

`src/app/services/` had become a 21-file flat folder mixing genuinely
app-wide singletons with feature clusters. The convention above is now
applied to the renderer for those clusters:

| Module               | Holds                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `src/app/llm/`       | `ActionsService`, `LlmTaskService`, `LlmDebugService`, `ConfirmationService` (renderer half of the LLM / Actions feature, mirrors `electron/llm/` + `shared/llm/`) |
| `src/app/assistant/` | `AssistantService` + the `NoteAssistant` panel body (ADR-0012)       |
| `src/app/entry/`     | `EntryDraftService` + the `EntryDrawer` capture surface (ADR-0013)   |
| `src/app/calendar/`  | `CalendarService` + the `Calendar` grid                             |
| `src/app/vault/`     | `VaultService`, `DailyNoteService`                                  |

`src/app/sidebar/` — orphaned when `SidebarComponent` was removed
([ADR-0019](0019-movable-dock-panels-and-layout-state.md)) — is deleted:
its `calendar/` folded into `src/app/calendar/`, its `open-windows/` moved
to a plain `src/app/windows/` folder.

What **stays** in `src/app/services/` is the app-wide infrastructure that
belongs to no one feature: `settings`, `log`, `drop-guard`,
`theme`, `appearance`, `about`, `layout`, `mcp-bridge`,
`editor-zoom`, `edit-target`, `spellcheck`, `tag`, and the `editor`
facade itself.

Two deviations from the "barrel is the only public surface" rule, both
forced by the string-matching nature of the ESLint check:

- **Barrels are service-only.** A panel component (`NoteAssistant`,
  `Calendar`, `EntryDrawer`, `OpenWindows`) is deep-imported by its one
  dock-panel wrapper in `src/app/dock/panels/` (which is already
  boundary-exempt) rather than re-exported. Re-exporting the component
  pulls its whole import chain (`MarkdownSurface`, `AutotagButton`, …)
  into every service-only consumer of the barrel and creates an Angular
  `NG0919` runtime cycle. `TagService` similarly stays in
  `src/app/services/` rather than moving into the component-bearing
  `src/app/tags/` module, so leaf editor code can use it without dragging
  the tag panels in.
- **`llm` / `assistant` / `entry` are guarded "deep-only".**
  `src/app/settings/` has a plain sub-folder of each of those names
  (`settings/llm/`, …), so a `./llm/settings-llm` import from
  `settings.ts` is that folder, not the feature module. The ESLint
  `no-restricted-imports` group for these three drops the `./<mod>/*`
  form and keeps only `../<mod>/*` / `../../<mod>/*`
  (`relativeModulePatternsDeepOnly` in `eslint.config.mjs`).
