# 44. Runtime plugin system: a base app with runtime-loadable, in-process plugins

## Status

Accepted. **Supersedes** the "modular
monolith — no plugin runtime" stance of
[ADR-0016](0016-feature-module-convention.md) and the "internal widget
model only, no runtime loading" clause of
[ADR-0034](0034-internal-widget-model.md). ADR-0016's barrel/boundary
convention itself survives for the *base* app's own code.

Shipped in the staged program this ADR planned: all six feature modules
(tags, tasks, meeting, templates, assistant+actions, browser) are runtime
plugins, plus a `sample` plugin exercising every surface. "As shipped"
below records where the conversions *reshaped* the frozen v1 SDK — the
frozen-contract stage did its job exactly there.

Packaging addendum: the `sample` plugin stays a dev-time artifact — built
into `dist-electron/` for `npm run dev` and the e2e suite (it is the
executable authoring reference, `plugins/AUTHORING.md`), but excluded from
the installer / portable exe by a `files` negation in
`electron-builder.yml` (see [docs/07](../07_deployment_view.md)).

## Context

ADR-0016 deliberately stopped short of a plugin runtime: feature modules
got ESLint-enforced barrels, ADR-0034 made the dock panels a data-driven
registry with a `WidgetContext` read-facade — but every feature is still
wired into the composition roots. `electron/main.ts` instantiates every
service and hands an 18-dependency bundle to `registerIpcHandlers`; the
`note:save` pipeline hardcodes the tag and task index re-indexing plus the
on-save Actions; the dock's `statusFor()` switch injects six feature
services; the editor bakes in tag autocomplete/pills, the meeting drop and
the template drag. A change to any feature ripples through base code, and
base changes risk every feature. The project owner wants the **blast
radius of changes limited** by separating the base application from
plugins — with plugins able to **access the document**.

The decisions below were made explicitly with the project owner:

| Question | Decision |
| --- | --- |
| Plugin model | **Runtime-loadable** (manifest + JS loaded at startup), not compile-time-only |
| Isolation | **In-process, trusted** (Obsidian's model) — no sandbox/utility process |
| Document access | read + observe, insert at cursor, confirmed rewrites, open/navigate |
| Settings | plugins contribute their own Settings pages |
| Plugin shape | **full stack** — main-process entry + renderer entry + own shared types |
| Discovery | **app-level** `<userData>/plugins/<id>/` (beside `app-config.json`, per ADR-0010) |
| Built-ins | **all six feature modules convert** (tags, tasks, browser, meeting, templates, assistant+actions), staged |

## Decision

### The split

**Base** = shell (titlebar/menu bar, docks, status bar, Settings
framework, confirmation dialog), editor + panes + tab bar, vault/note IO,
session restore, keybindings, spellcheck, the MCP vault server, the LLM
transport (`LmStudioClient`, debug log, task registry, the LLM Settings
category), and the plugin hosts.

**Plugins** = tags/search, tasks, browser tab, meeting import, template
library, assistant + Actions. Each owns renderer UI, main-process backend,
and its shared types. `templates.dir` **stays base config** (the app
imposes `templates/` and `daily/`; the tags/tasks exclusion logic reads it
via the config facade) while the template *library feature* is a plugin.

### SDK contract — `shared/plugin-api/`

`PluginManifest` (id `^[a-z][a-z0-9-]{1,63}$`, name, version,
`apiVersion`, optional `main`/`renderer` entries, `css`, descriptive
`permissions`), validated by a pure `validateManifest`. The gate is the
**major** of `PLUGIN_API_VERSION`: a mismatch loads nothing and reports
`incompatible` in Settings. The full renderer (`DreyPluginApi`) and main
(`MainPluginContext`) surfaces are frozen in code before any host exists —
types are the cheapest thing to review and the most expensive to break.

### Loading

- **No bundler.** Main entries are CommonJS emitted by `tsc` and loaded
  with `import(pathToFileURL(entry))`; renderer entries are ES2022 modules
  served file-per-file over a new privileged `plugin://` scheme (same
  `registerSchemesAsPrivileged` pattern as `app://`/`drey-asset://`), with
  explicit `Content-Type` and `Access-Control-Allow-Origin: *` headers and
  a `path.relative`-based escape guard (stricter than `app://`'s
  `startsWith`, Windows-safe). There is no CSP to relax — verified.
- **Discovery**: built-ins (bundled in `dist-plugins/` /
  `dist-electron/plugins/`) + `<userData>/plugins/*` + a
  `DREY_EXTRA_PLUGIN_DIR` dev/test override. Invalid manifests are skipped
  and logged; built-ins win id collisions.
- **IPC**: two **fixed** channels, not per-plugin names —
  `plugin:invoke` (`{pluginId, method, payload}`, routed to a per-plugin
  method allowlist; unknown method = rejection; ids validated against the
  pattern) and `plugin:event` (one main→renderer push, fanned out
  renderer-side). The preload gains exactly three methods. Errors cross as
  strings (structured clone cannot carry `Error`).

### Lifecycle

Main activates first (`await import` → `activate(ctx)`; a throw
quarantines the plugin as `failed`, logged, app continues), then the
renderer activates inside a `provideAppInitializer`, **gating Angular
bootstrap** so the widget/settings/doc-kind registries are complete before
`DockService`, menus, or session restore read them. Enable/disable is
`plugins.disabled` in `app-config.json` (exception list, same pattern as
`widgets.disabled`); a disabled plugin is never imported, and toggling
prompts **restart to apply** — renderer-side disposal (`deactivate()` +
every handed-out unsubscribe) is fully implemented, but main-side state is
only guaranteed cleaned by a restart, and v1 says so honestly.

### The five rules that make it safe

1. **Plugins never import `@codemirror/*` at runtime.** CM extensions
   only compose from the *same module instances* the host uses; a second
   copy breaks facets silently. Plugins get the host's instances as
   `api.editor.cm` and use `import type` for CM types. (With no bundler in
   the pipeline a stray runtime import becomes a loud bare-specifier
   failure anyway — this rule keeps it that way.)
2. **Plugin UI is DOM, not Angular.** Widgets, Settings pages, doc kinds
   and modals mount into host-provided elements and are cleaned up by a
   returned dispose function. Plugins don't take an Angular version
   dependency, and built-in plugins are loaded *identically* to external
   ones (no privileged path).
3. **Plugin settings save immediately** (`api.settings`, per-plugin
   `<userData>/plugins/<id>/config.json`); the Settings screen's
   draft/Save/Discard bar applies to base config only. A conscious UX
   divergence from the base categories.
4. **The save pipeline is a hook registry.** `NoteManager` keeps the
   frontmatter bump + write; feature work (index re-indexing, on-save
   Actions) moves behind an async `onNoteSaved` hook returning
   `{ content?, pendingActions? }` — the exact contract the editor already
   adopts today. Vault open/refresh/rename and the MCP `vault_search`
   backend get equivalent registries (`VaultHooks`,
   `SectionSearchProvider`); MCP degrades to a clear error when no
   provider is registered.
5. **Plugin widgets keep their ids.** Dock layout state and
   `widgets.disabled` key on widget ids; a converted plugin reusing a new
   id would reset every user's layout.

### `WidgetContext`

Deleted. It has zero production consumers and its signal-returning surface
is Angular-shaped; the plugin API replaces it. (ADR-0034's registry itself
becomes a runtime service — `WidgetRegistryService` — with core widgets
registering through the same API plugins use.)

### What was rejected

- **Sandboxed extension host** (VSCode-style): crash isolation at the
  cost of message-passing for every document access and a far larger API
  surface. Wrong for a single-user local tool whose plugins are
  self-installed. A future host process remains possible because the API
  is async/callback-shaped from day one.
- **Compile-time modules only** (the status quo): doesn't limit blast
  radius, which was the actual ask.
- **Per-plugin IPC channel names**: the preload is a hand-written typed
  object; arbitrary channel strings through `contextBridge` are a security
  smell for no benefit over two fixed, validated channels.
- **Bundling plugins** (esbuild): a second toolchain, and it invites the
  duplicate-`@codemirror` failure mode of rule 1.
- **Hybrid built-ins** (built-ins as Angular components, externals as
  DOM): ~30–40% less conversion work but forks the mount model and makes
  "identical treatment" false. The whole point is one code path.
- **Hot enable/disable**: postponed; restart-to-apply is the honest v1.

## As shipped — where the conversions reshaped the SDK

The v1 contract above was frozen before any host existed; building the six
plugins against it surfaced a handful of deliberate changes, each made at
the stage that needed it:

- **The LLM facade lost `ask` / `runAction` / `actionsForEvent`.** The
  assistant plugin took its Actions engine *into* the plugin (prompt
  templates, trigger resolution, the on-save hook) with the base
  transport injected as `{ getConfig, chat }`; a facade mirroring
  ActionRunner would only have re-created the old coupling one seam over.
  What remains: renderer `llm = { enabled, chat(+vaultTools option),
  cancelTask, onDebugEntry }`; main-side additionally `chat` +
  `suggestTags` (the vocabulary-carrying Autotag prompt — the Autotag
  button stays a base surface that joins the tags plugin's vocabulary with
  base transport).
- **`RewriteRequest.triggerId?`** — the confirmation dialog attributes an
  edit to its requesting surface (a plugin command, an on-save Action, an
  MCP write), which the base dialog renders as context.
- **Doc-kind contributions grew `icon` and `onFocused`** beyond the v1
  `serialize/restore/mount/favicon/statusText` shape: a plugin tab needs a
  tab-strip fallback glyph named from the host's icon set, and a
  keyboard-driven kind (the browser's Ctrl+F) must know when its host
  surface gains/loses focus without polling.
- **`documents.addDoc(kind, key, name)` and `documents.rename(path,
  name)`** — a plugin-contributed tab is not a file, so opening one (the
  browser's "New tab") and following a page title with the tab label
  needed first-class registry-doc calls. `OpenDoc.kind` widened from a
  closed union to `string` — the base cannot enumerate plugin kinds.
- **A new `editor-more` menu slot** (the per-pane meta-bar `⋯` menu):
  manual Actions moved there as contributions when the assistant plugin
  absorbed Actions.
- **Menu contribution rows append at the end of a menu, behind a
  separator.** There is no insertion-order API — the browser's "New
  browser tab" consequently moved from the File menu's second row to the
  bottom section (same command id, same keybinding). If a core-menu
  position ever matters, that is a small SDK addition, not a redesign.
- **Plugin main-process entries may import `electron` and the app's
  CJS-emitted `shared/` modules** (the meeting importer takes `dialog`,
  the browser takes `WebContentsView`/`session`/…); plugin *renderer*
  entries can import neither at runtime — they are browser-context ES
  modules served over `plugin://`, which is why small helpers get copied
  into a plugin's own `shared/` folder instead of imported from `shared/`.
- **A plugin main's push is a doc-kind refresh signal.** The doc-kind
  registry's re-read tick is fed from document events *and* from
  `plugin:event` dispatch — the browser's favicon/status ride its `event`
  pushes, and a plugin can update its own tab-strip slots from any backend
  state change.

## Consequences

- The six feature modules move to `plugins/<id>/` (manifest + `main/` +
  `renderer/` + `shared/`), built by the same toolchain into the two
  output roots; `eslint.config.mjs`'s module lists shrink to the base
  modules, with `shared/plugin-api` exempt like `ipc-api.ts`.
- The renderer API must stay out of the main process's compilation graph
  (it is DOM-typed; `shared/plugin-api/index.ts` stays DOM-free and is the
  main-side surface, while the DOM-typed contribution surface
  (`plugin-api.ts`, re-exported by `renderer.ts`) is excluded from
  `electron/tsconfig.json`'s no-DOM compile — an accidental main-side
  import of the renderer surface is a compile error, not silent leakage).
- Every base seam a plugin needs is a registry: widgets, Settings
  categories, commands, menu rows, editor extensions, drop decoders,
  context-menu items, doc kinds, save hooks, vault hooks, section-search
  provider, composer (entry-drawer) slot. Base knows the interfaces, not
  the features.
- Saves are now potentially plugin-extending (async hooks); the
  `runOnSaveActions: false` short-circuit survives so a rewrite-applying
  save can't recurse.
- `npm run dev` staleness now also covers `dist-plugins/` — plugin or
  `shared/plugin-api` changes require a plugin rebuild + restart, same
  class as the existing `shared/` gotcha.
- The Settings "Widgets" category became **"Panels & plugins"**: one page
  toggles dock panels (`widgets.disabled`) and whole plugins
  (`plugins.disabled`), and shows every discovered plugin's live status
  (active / failed / incompatible / disabled, plus the host's error).
  Plugin *pages* still append as their own categories, before "About".
- Milestone staging: ADR/SDK → hosts + `plugin://` spike + sample plugin
  → editor/save/vault/search seams (pure refactor) → templates → meeting
  → tags → tasks → assistant+actions → browser (base doc-kind
  genericization first, shippable alone) → cleanup/docs → packaging.
