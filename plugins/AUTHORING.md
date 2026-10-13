# Writing a Drey plugin

The practical reference for `plugins/<id>/` authors. The *why* lives in
the architecture docs: [ADR-0044](../docs/09_architecture_decisions/0044-runtime-plugin-system.md)
(the plugin system: split, five safety rules, rejected alternatives),
[docs/05 §5.0](../docs/05_building_block_view.md) (the current base/plugin
structure and the full seam table), [docs/06 §6.25–§6.29](../docs/06_runtime_view.md)
(discovery, IPC, editor extensions, save hooks, doc kinds as runtime
sequences) and [docs/07](../docs/07_deployment_view.md) (packaging). This
file is the *how*: layout, manifest, UI rules, the settings-page
vocabulary, and how to test.

New to plugin writing? Start with [TUTORIAL.md](TUTORIAL.md) — a
step-by-step walkthrough built on the sample plugin, including packaging
and local installation (ADR-0068).

The `sample` plugin is the executable reference for everything below.
Since milestone 70 (ADR-0068) it is dev/test-only: not part of the default
build output, so no ordinary dev run or package discovers it. Build it
explicitly with `DREY_BUILD_SAMPLE_PLUGINS=1 npm run build:plugins` (the
`npm run e2e` script does the same) — or install it into a real Drey as a
package, exactly the way the tutorial ships your own plugin.

## Layout and build

```
plugins/<id>/
  plugin.json     manifest (validated at discovery; see below)
  main/           CommonJS, Node — the main-side backend (optional)
  renderer/       browser-context ESM + CSS over plugin:// (plain DOM);
                  index.ts is the entry and is bundled into one file
  shared/         types and pure code both sides use (optional)
```

`scripts/build-plugins.mjs` builds both sides into
`dist-electron/plugins/<id>/` — that directory is what actually loads,
built-in or not: `main/` and `shared/` as CommonJS from `tsc`,
`renderer/index.js` as one ES module from esbuild (not minified).
`npm run dev` does this by itself: a change under `plugins/**` (or a
`shared/**` file a plugin imports) rebuilds the plugins and restarts
Electron. Run any other way (`npm run app`, a VS Code debug config),
**rebuild and restart Electron yourself** — a stale `dist-electron`
leaves the app on the previous build. Verify with
`grep <new-symbol> dist-electron/plugins/<id> -r`.

## Manifest

```json
{
  "id": "templates",
  "name": "Templates",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "…",
  "renderer": "renderer/index.js",
  "css": ["renderer/templates.css"],
  "permissions": ["documents", "vault", "commands", "settings", "editor"]
}
```

- `apiVersion` is a **major gate**: a manifest whose major differs from
  `PLUGIN_API_VERSION.major` (`shared/plugin-api/versions.ts`, currently
  `{ major: 1, minor: 18 }`) is never imported — the plugin shows up in
  Settings → Panels & plugins as incompatible. Minor bumps are additive;
  1.9 added `commands.run(id, payload?)`, `ui.createTagField` (the shared
  tag chip field — prefer it over a hand-rolled chip row), the main-side
  `ctx.search.notifyChanged()` push and the section-search provider's
  optional `styles()` (tag prefix colors). 1.10 added `ui.icon(name, size)`
  (a glyph from the host's icon set as a plain SVG element — use it for
  icon-only controls and always give the button a `title` and an
  `aria-label`) and the `freeText` mode of `ui.createTagField` (one input
  for a text query and `#tag` chips, plus `setText`);
  `ui.registerComposerContribution` is a deprecated no-op since the
  "Add entry" drawer was removed (ADR-0057). 1.11 added the task-index
  seam (`ctx.tasks.registerTaskQuery` / `queryProvider` — the `TaskQueryProvider`
  contract the assistant's `tasks_list` tool and MCP `tasks_list` read)
  and `api.links` (`parseInline` / `resolve` / `open` — base-owned
  wikilink grammar + navigation for plugin-rendered text). 1.12 gave
  `TaskQueryOptions` the deterministic view fields (`sort` incl.
  `importance`, `text`, `tag`, `overdue`) — the provider filters and
  orders, consumers never re-sort. 1.13 added the completion view:
  `SdkTaskRecord.completed` (optional — records persisted earlier lack
  it), `TaskQueryOptions.status` (`open` | `done` | `all`, wins over
  `includeDone`), `completedSince` and the `completed` sort.
- **Shared chrome classes.** Panel controls use the shell's global
  `.icon-btn` (24px icon button, `.on` / `aria-pressed` = accent tint,
  `.glyph` for a short text glyph) and `.seg` (segmented switch of icon
  buttons) instead of per-plugin button styles; panel labels are sentence
  case.
- `main` is optional (a renderer-only plugin needs none); `css` is a list
  of stylesheets injected next to the renderer module.
- Discovery: built-in `plugins/` + `<userData>/plugins/<id>/` +
  `DREY_EXTRA_PLUGIN_DIR` (dev) — all identical to the hosts
  (ADR-0044: built-ins have no privileged path). A plugin is disabled via
  `plugins.disabled` (Settings → Panels & plugins), applied on restart.
- A user-installed plugin arrives as a **local package**: a `.zip` of the
  built plugin folder, installed (and upgraded, config preserved) or
  removed through Settings → Panels & plugins → "Install from file…" /
  "Remove" — see [TUTORIAL.md](TUTORIAL.md) and
  [ADR-0068](../docs/09_architecture_decisions/0068-local-plugin-packages.md).

## Renderer rules

Plugin UI is **plain DOM over the host-provided element** — no Angular,
no Node (ADR-0044 rule 2). `mount(el)` fills the element and
returns a dispose function; the base calls it on page switch, panel
removal and quarantine.

What your renderer may import at runtime: files in your own plugin
folder and files in the repo's top-level `shared/` — the build bundles
them into your one `renderer/index.js` (ADR-0044, later change). Use a
`shared/` function directly; do not copy it. Everything else is refused
**by the build**, with the importing file named:

- a package (`@codemirror/*`, `yaml`, …) — take CodeMirror from
  `api.editor.cm` and import package *types* with `import type`; a second
  copy of a CodeMirror module breaks the editor silently (rule 1);
- a `shared/` module that itself needs a package (`shared/frontmatter.ts`)
  — do that work in your `main/` and return data over `ctx.ipc.handle`;
- `src/`, `electron/` or another plugin's folder — what two plugins both
  need belongs in `shared/`.

Styling rules, in order of enforcement:

1. **Prefix every class** with your plugin id (`tpl-list`,
   `assistant-thread`, `sample-settings`). Your stylesheet is global once
   injected; the prefix is the only namespace you have.
2. **Use the design tokens from `src/styles.css`** (`--text-*`, `--bg-*`,
   `--border*`, `--radius*`, `--accent*`, `--font-*`) — never literal
   colors. The app is dark-theme-first and Settings → Appearance can
   change type size and accent; token-based pages follow along, hardcoded
   ones don't.
3. **No `px` font sizes.** Type is rem-based (`0.74rem` hints,
   `0.8–0.88rem` body — see `src/app/settings/settings-forms.css` for the
   scale) so the app-wide type-size setting applies to your UI too.
4. **No native dialogs.** `window.alert()` / `confirm()` break Windows
    keyboard focus after dismissal (electron#41602). Use
    `api.ui.showMessage(message, title?)` for acknowledgements — the app's
    own OK-only dialog, queuing like the native calls did — and
    `api.ui.showModal` for anything interactive. A `showModal` overlay comes
    with base chrome (`src/styles.css`, `.plugin-modal-backdrop` /
    `.plugin-modal`): a dimmed backdrop and a padded raised box. Style only
    your content; add a host class (`mount.classList.add('my-host')`) and a
    compound rule `.plugin-modal.my-host` when you need a fixed width or
    flush edges (`padding: 0`).

### The page's Content-Security-Policy

The main window's page runs under a policy (ADR-0001, later change) and
your renderer module runs inside that page:

- no inline `<script>`, no `eval` / `new Function`, no string passed to
  `setTimeout`;
- no `fetch` / `XMLHttpRequest` / `WebSocket` to the network — do network
  work in your `main/` entry and call it through `backend.invoke`;
- scripts, styles, fonts and pictures load from your own plugin directory
  (`plugin://<id>/…`); a frame may show a page from there too;
- inline styles and `style` attributes are fine.

The e2e fixture fails a test on any policy violation in the console.

## Settings pages

Register with
`api.ui.registerSettingsPage({ id, label, hint, description, mount })`.
The category appears in Settings before "About"; `label`/`hint` are shown
in the category list. **The host draws the page header** — `label` as the
title and the optional `description` (SDK 1.20, one sentence) below it —
so `mount(el)` builds only the fields; do not repeat the title as a
heading.

Pages **save immediately** through their own API (ADR-0044 rule 3) —
like every Settings page: the screen has no Save or Discard, and its
footer says "Changes are saved automatically" — don't repeat that in a
hint. Store a typed value on `change` (blur / Enter), not per keystroke.
Use `api.settings` for the
plugin's own `config.json`, `api.appConfig` only when a setting belongs
to app-level config (read-modify-write one section per patch).

### The shared form vocabulary

Core panes and plugin pages are styled by **one** base stylesheet,
`src/app/settings/settings-ui.css`, scoped under the Settings dialog —
build your page from it instead of re-declaring look and feel. `el` is a
flex column with the standard gap, so top-level fields and sections
space themselves:

| Class / element | For |
| --- | --- |
| `<section>` + `h3` | a group; sections after the first get a divider |
| `.section-head` | an `h3` with an action at its right |
| `.section-hint` | a free-standing hint under an `h3` |
| `.field` (+ `label`, control, `.field-hint`) | one labeled setting |
| `.field.sub` | an option that depends on the switch above it |
| `.switch-row` / `.switch-label` / `.switch-hint` | a checkbox with its explanation |
| `.row` | controls on one line; `.row.compact` for 28px controls |
| `.rows` / `.row > .name` / `.check` | dense editable row lists |
| `.list` | divided rows |
| `.cards` / `.card` | items with several fields each |
| `.chips` / `.chip` | removable words |
| `button.ghost` (`.small`) / `button.primary` | actions |
| `button.link` / `button.link-danger` | quiet in-row actions ("Edit", "Remove") |
| `.badge`, `.empty`, `.callout` (`.warn`) | state chips, empty states, notes that need attention |
| `.status-ok` / `.status-error` / `.status-pending` | result text |
| `.mono`, `.mono-input`, `pre` | code text, code-like inputs, code blocks |
| `.narrow` | a select or input that should not span the column |

Every `input` (text, number, password, or none), `select` and `textarea`
is styled by the base sheet at one height; checkboxes and radios take the
accent colour; buttons, links and inputs get the keyboard focus ring.
Anything beyond this vocabulary (trees, pickers, swatches) goes in **your
own stylesheet under your prefix** — the base rules weigh no more than
one class, so yours win without `!important`. A modal you open with
`api.ui.showModal` is outside the dialog and gets none of this. See the
assistant plugin's Actions page for the mixed case, the git page for the
pure-field case.

## Testing convention

- **Pure logic** (parsing, library scans, state machines): `*.spec.ts`
  next to the source file — `plugins/**/*.spec.ts` is in the unit-suite
  include (`tsconfig.spec.json`), run with
  `node node_modules/@angular/cli/bin/ng.js test --watch=false`.
- **DOM pages and wiring**: e2e. `e2e/plugins.spec.ts` is the pattern —
  it covers the built-in list (via `appConfig` fixture) and a plugin
  discovered from `<userData>/plugins` / `DREY_EXTRA_PLUGIN_DIR`,
  including that its Settings page mounts. Give test-visible elements a
  `data-*` attribute rather than styling hooks.
- No plugin tests import from `src/` — the plugin is a consumer of the
  SDK, not of the app's internals (same boundary the loader enforces).

## SDK 1.15 — external tools and the confirmation question

- `ctx.llm.chat(messages, { externalTools: true })` adds the user's
  external tool set to ONE call: the built-in `web_fetch` and the tools
  of their MCP servers (`mcp__<serverId>__<tool>`), as far as Settings →
  Assistant tools enables them. The host runs each call and asks the
  user first when the source is set to "ask" — a plugin never sees the
  servers or their keys. Your own `tools` and the vault set win a name
  collision. Leave it off for calls that must not reach outside the
  machine (ADR-0063).
- `ctx.vault.confirmWrite({ path, before, after })` shows a change in the
  shared confirmation diff and resolves whether the user approved it.
  It writes nothing; write after a `true`. Use it when your tool group's
  write rule is "confirm".

## SDK 1.16 — file openers, binary files, announced writes

- `api.documents.registerFileOpener({ extensions, open })` lets your
  plugin open vault files with certain name suffixes instead of the base
  text / image / PDF routing. `extensions` are lower-case suffixes with
  the dot (`['.drawio.svg', '.drawio']`); across all plugins the longest
  match wins, so a compound suffix beats the base's `.svg`. In `open(path,
  vaultId)` add a tab of your own doc kind (`documents.addDoc`) under a
  scheme key that encodes vault and path. If `open` throws, the file
  opens the base way. With your plugin disabled the files simply open as
  before — choose formats that degrade well (ADR-0064).
- `api.vault.readBinary(path)` / `api.vault.writeBinary(path, bytes)`
  read and overwrite a binary file at an exact path. Use them for a file
  your plugin owns and saves in place; `saveAsset` stays the way to stage
  a new attachment under a name the host picks.
- `api.vault.writeFile(path, content, { announce: true })` (and the same
  option on `writeBinary`) also runs the change round for that path: the
  file tree shows a new file and pictures of the file reload. Without it
  a write is silent towards the renderer. Do not announce high-frequency
  writes — each one reloads the vault's tree.
- `api.editor.registerToolbarButtons([{ icon, title, run | commandId }])`
  appends icon buttons to the formatting bar of every document editor.
  `icon` is a name from the host's set (as for `api.ui.icon`), `title` is
  both tooltip and accessible name. A button acts on the focused
  document: use `api.documents.insertAtCursor`. That insert lands on the
  editor's next render — wait for it (the buffer contains your text)
  before you open a tab that may replace the editor.
- A doc kind has no dirty state. A plugin tab that edits a file saves on
  its own (debounced, and when it unmounts); see the diagrams plugin's
  `embed-session.ts` for the pattern.
## SDK 1.17 — file decorations, the diff dialog, announcing changes

- `api.ui.setFileDecorations(vaultId, decorations | null)` replaces your
  plugin's Files-panel decorations for one vault: `{ path, badge, tone,
  tooltip? }` per file, `tone` one of `modified | added | untracked |
  conflict | deleted`. The base colours the row, shows the badge on the
  file and lets each folder inherit the strongest tone below it — also
  for a path that no longer exists. Send the full list each time; `null`
  clears it. Your set is dropped when the plugin is deactivated.
- `api.ui.showDiff({ title, path, before, after, beforeLabel?,
  afterLabel? })` opens the app's read-only split diff and resolves when
  it is closed. Use it instead of drawing a diff yourself.
- `ctx.vault.announceChanges({ vaultId, changedPaths?, deletedPaths? })`
  (main): call it after your plugin ran something that rewrote vault
  files behind the app's back. With paths, exactly those files are
  re-indexed and clean open tabs of them reload; without, the vault is
  re-read (open tabs are then left alone). The git plugin
  (`plugins/git/`) is the reference for all three.

## SDK 1.18 — the semantic search seam

- `ctx.search.registerSemanticSearch(provider)` (main) is a second,
  parallel single slot next to the section-search one: the provider's
  `search(question, scope?, limit?)` returns similarity-ranked
  `SemanticSectionHit[]` (path/heading/line/snippet/text/vaultId/score,
  hydrated fresh from the vault). Register only while your feature is
  actually on — "no provider" is what base surfaces degrade on. The
  renderer side is `api.search.searchSemantic(question, scope?, limit?)`
  (limit clamped 1..20, default 12); it rejects with a clear message
  when no provider is registered. The assistant plugin
  (`plugins/assistant/`, ADR-0055) is the reference implementation;
  the tags plugin's Search panel and MCP `vault_search` mode `semantic`
  are the reference consumers.

## SDK 1.19 — a strip icon for your panel

- A dock panel is either open or closed to an icon in the strip at the
  top of its dock (ADR-0019 later change) — the 32px collapsed header is
  gone. Give `api.ui.registerWidget` an `icon`: a name from the host's
  vendored set, the same vocabulary `api.ui.icon(name)` draws from.
  Without one (or with a name the host does not know) the strip shows the
  first letter of your `title`.
- `status()` still receives `{ collapsed }`; `true` now means "closed".
  The value shows in the panel header while open and in the strip icon's
  tooltip while closed — keep it short.
- `defaultOpen: false` means the panel starts as an icon only.
  `api.ui.revealWidget(id)` opens it.

## SDK 1.20 — a header for your Settings page

- `PluginSettingsPageContrib.description` (optional): one sentence the
  host shows under the page title. The title itself is your `label` —
  the host draws both, in the same frame the built-in categories use, so
  a page no longer opens with its own heading.
- The page column is a flex column with the standard field gap; core
  panes and plugin pages share one stylesheet (see "The shared form
  vocabulary" above).

## SDK 1.21 — reading the section-search provider

- `ctx.search.sectionSearchProvider()` returns the registered
  `SectionSearchProvider` or `null` — the read side of the seam, like
  `ctx.tasks.queryProvider()`. Use it for the vault's tag vocabulary
  (`vocabulary()`) or a section search from your main entry; always
  handle `null` (the tags plugin may be disabled) and ask at call time,
  not once at activation — providers register in activation order.
