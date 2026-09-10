# 34. Internal widget model: a registry, a capability context, per-widget visibility

## Status

Accepted. A scope addition at the project owner's request. **Refines**
[ADR-0016](0016-feature-module-convention.md) ("modular monolith — no plugin
runtime") and **amends** [ADR-0019](0019-movable-dock-panels-and-layout-state.md)
(closed `PanelId` union, no "hidden" state).

**Partly superseded by [ADR-0044](0044-runtime-plugin-system.md):** the
"explicitly not wanted: a runtime plugin loader" clause is reversed — the
registry becomes a runtime `WidgetRegistryService` plugins register into,
and `WidgetContext` is replaced by the plugin API (it never gained a
production consumer). The descriptor model, `DockState.hidden`, the
View-menu rows and the Settings enable/disable flow all stand.

## Context

The dock panels were wired three ways at once: a closed `PanelId` string
union in `dock.service.ts`, `Record<PanelId, …>` maps in
`panel-registry.ts` (`PANEL_TITLES` / `PANEL_COMPONENTS`), and hard-coded
lists inside `dock.service.ts` (`ALL_PANELS`, `CONTENT_HEIGHT_PANELS`, the
`defaultState()` dock/flex/open literals, the `merge()` re-home lookup).
Adding a panel meant touching all of them.

The owner asked for a "plugin structure" so panels can be **enabled /
disabled from Settings** and **more added later**, with a defined surface a
widget uses to reach *the active document, the file tree, and the standard
queries that run in the system (tags, tasks, search)*. Separately: the View
menu only **collapsed** a panel to its header (`toggleCollapse`); an "off"
panel still occupied a 32 px strip, and two panels (`tasks`, `entry`) had no
View row at all, so a collapsed one had no way back.

Explicitly **not** wanted (ADR-0016 stands): a runtime plugin loader,
third-party code, a sandbox, an IPC plugin host. This is an *internal*
modular seam.

## Decision

**A data-driven registry, a typed `WidgetContext` facade, and a real
hide/show on the dock.**

- **`src/app/dock/widget-registry.ts`** — `WIDGETS: WidgetDescriptor[]` is
  the single source of truth (`id`, `title`, `component`, `defaultDock`,
  `defaultOpen`, `defaultFlex`, `contentHeight?`, `flush?`, `removable`,
  `capabilities`). `WIDGET_MAP` / `ALL_WIDGET_IDS` derive from it. Replaces
  `panel-registry.ts` and every hard-coded list. Adding a widget later = one
  array entry. It lives under `dock/` (not `widgets/`) because it names the
  panel components, which are dock-internal; `dock/index.ts` re-exports it.
- **`PanelId` → `WidgetId` (open `string`)**. `PanelId` stays as a
  deprecated alias so existing imports keep compiling. `dock.service.ts`
  `defaultState()` / `merge()` / `contentHeight()` now read `WIDGETS`.
- **`DockState.hidden: WidgetId[]`** plus `DockService.hide(id)` /
  `show(id)` / `isHidden(id)`. `hide` pulls a widget out of every dock
  (keeping its flex + collapse state); `show` re-inserts it into its
  descriptor's `defaultDock` at the slot that preserves registry order,
  expanded. `move()` and `openAndExpand()` also clear `hidden` (dragging a
  hidden widget back, or a command that reveals one, un-hides it).
  Round-trips through `localStorage['drey.dock']`.
- **View menu** (`menu.service.ts`) — `panelRow` → `widgetRow`: the check
  mark tracks `!isHidden(id)`, a click calls `hide` / `show`. The rows are
  **generated** from `WIDGETS.filter(w => w.removable)`, so every widget
  (incl. `tasks` and `entry`) gets one, in registry order. Collapsing to
  the header stays the separate header-click gesture.
- **`src/app/widgets/` feature module** (`index.ts` barrel,
  `eslint.config.mjs` `MODULES`-style boundary) — **`WidgetContext`**
  (`providedIn: 'root'`), the one typed surface a widget uses instead of a
  handful of services. Thin delegation only:
  - active document — `activeDocumentPath/Name/Saved/Buffer/Dirty`,
    `openDocuments`, `selection()`, `openFile(path, line?)`
    (→ `EditorService` / `EditTargetService`);
  - file tree — `fileTree`, `activeVaultPath`, `refreshVault()`
    (→ `VaultService`);
  - standard queries — `tags` (→ `TagService`), `searchSections(query)` and
    `listTasks()` (→ the `tags:search` / `tasks:list` IPC);
  - `registerCommand(command)` (→ `KeybindingService`),
    `onVaultChanged(cb)`.
  - `WidgetCapability` (`active-document` | `file-tree` | `tag-queries` |
    `task-queries` | `search` | `commands`) on the descriptor is
    **descriptive** — shown in Settings, documented as the enforcement seam.
    No runtime gating: every registered widget can call all of
    `WidgetContext`.

Existing panels are **not** rewritten onto `WidgetContext` in this pass
(they keep their direct service injections). Porting is mechanical and
incremental; the facade exists and is the path for anything new.

### Enable / disable in Settings

- **`AppConfig.widgets.disabled: string[]`** — the *exception* list, not an
  allow-list: a widget is enabled unless its id appears here, so a widget
  added by an app update needs no migration and a downgrade keeps unknown
  ids verbatim. `normalizeWidgets` sanitises to a deduped string array;
  the id space is validated against the renderer registry, not `shared/`.
- **`SettingsService`** — `widgetsDisabled` / `widgetEnabled(id)` read the
  **persisted** config (not the draft), so a change lands on Save like
  every other category; `setWidgetEnabled(id, on)` is a draft mutator;
  `widgetsDisabledDraft` backs the pane's checkboxes.
- **`DockService.reconcileEnabled(disabled)`** runs from an `effect` on
  `SettingsService.widgetsDisabled`: it drops disabled ids from every dock
  **and** from `hidden`, and re-homes any id that is enabled again and now
  nowhere (registry-ordered slot). `DockService` gains a
  `SettingsService` dependency; there is no cycle (`SettingsService` does
  not import `../dock` — the "all ids" set it would need lives only in
  `reconcileEnabled`, which is in `DockService`).
- **`MenuService`** — the generated View rows also filter
  `settings.widgetEnabled(w.id)`, so a disabled widget has no toggle.
- **Settings pane** — `src/app/settings/dock-widgets/` (folder deliberately
  not named `widgets/`, which would collide with the `src/app/widgets/`
  module in `eslint.config.mjs`'s path patterns — same precedent as `llm`).
  Category id `widgets`, label "Widgets". A checkbox per `WIDGETS` entry
  with its capability labels as sub-text; a `removable: false` widget
  renders disabled.

### Alternatives considered

- **Keep the `PanelId` union, add only metadata + a toggle.** Rejected —
  "add another later" would still mean widening a union and editing several
  `Record<PanelId, …>` maps.
- **A frozen public `WidgetPlugin` contract now** (lifecycle, manifest,
  event bus). Rejected as speculative — nothing external consumes it; the
  registry + `WidgetContext` are enough for the internal seam.
- **Runtime capability enforcement.** Deferred — needs a sandbox to mean
  anything; the declaration is the forward-compatible marker.
- **View toggle = collapse (status quo).** Rejected — the owner asked for
  the *whole* widget to disappear.

## Consequences

- A new `src/app/widgets/` module (`WidgetContext`, `WidgetCapability`).
- `dock/index.ts` gains `WIDGETS` / `WIDGET_MAP` / `WidgetId` /
  `WidgetDescriptor`; `menu.service.ts` imports `WIDGETS`.
- `DockState` gains `hidden`; a stored blob without it reads as "nothing
  hidden".
- `panel-registry.ts` is deleted; `CONTENT_HEIGHT_PANELS` and the
  `defaultState()` literals are gone (derived from `WIDGETS`).
- `AppConfig` gains a `widgets` slice; `Settings` gains a "Widgets"
  category. `DockService` now depends on `SettingsService`.
- `dock.service.spec.ts` assertions derive expected ids from `WIDGETS`;
  new specs cover `hide` / `show` / persistence / `openAndExpand` /
  `move` un-hide / `reset` / `reconcileEnabled`.
