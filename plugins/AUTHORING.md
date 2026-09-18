# Writing a Drey plugin

The practical guide for `plugins/<id>/` authors. The *why* lives in the
architecture docs: [ADR-0044](../docs/09_architecture_decisions/0044-runtime-plugin-system.md)
(the plugin system: split, five safety rules, rejected alternatives),
[docs/05 §5.0](../docs/05_building_block_view.md) (the current base/plugin
structure and the full seam table), [docs/06 §6.25–§6.29](../docs/06_runtime_view.md)
(discovery, IPC, editor extensions, save hooks, doc kinds as runtime
sequences) and [docs/07](../docs/07_deployment_view.md) (packaging). This
file is the *how*: layout, manifest, UI rules, the settings-page
vocabulary, and how to test.

The `sample` plugin is the executable reference for everything below.

## Layout and build

```
plugins/<id>/
  plugin.json     manifest (validated at discovery; see below)
  main/           CommonJS, Node — the main-side backend (optional)
  renderer/       browser-context ESM + CSS over plugin:// (plain DOM)
  shared/         types shared between the two sides (optional)
```

`scripts/build-plugins.mjs` compiles both sides into
`dist-electron/plugins/<id>/` — that directory is what actually loads,
built-in or not. **After touching `plugins/**` or `shared/plugin-api/**`,
rebuild and restart Electron**; a stale `dist-electron` leaves the app
running the previous build (a changed renderer module 404s). Verify with
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
  `{ major: 1, minor: 8 }`) is never imported — the plugin shows up in
  Settings → Panels & plugins as incompatible. Minor bumps are additive.
- `main` is optional (a renderer-only plugin needs none); `css` is a list
  of stylesheets injected next to the renderer module.
- Discovery: built-in `plugins/` + `<userData>/plugins/<id>/` +
  `DREY_EXTRA_PLUGIN_DIR` (dev) — all identical to the hosts
  (ADR-0044: built-ins have no privileged path). A plugin is disabled via
  `plugins.disabled` (Settings → Panels & plugins), applied on restart.

## Renderer rules

Plugin UI is **plain DOM over the host-provided element** — no Angular,
no Node, no bundler (ADR-0044 rule 2). `mount(el)` fills the element and
returns a dispose function; the base calls it on page switch, panel
removal and quarantine.

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
   `api.ui.showModal` for anything interactive.

## Settings pages

Register with `api.ui.registerSettingsPage({ id, label, hint, mount })`.
The category appears in Settings before "About"; `label`/`hint` are shown
in the category list. Pages **save immediately** through their own API —
the Settings screen's draft/Save/Discard bar does not apply to them
(ADR-0044 rule 3): use `api.settings` for the plugin's own
`config.json`, `api.appConfig` only when a setting belongs to app-level
config (read-modify-write one section per patch).

### The shared form vocabulary

`PluginSettingsHost` loads a base stylesheet scoped under
`.plugin-settings-body` (`src/app/plugin-host/plugin-settings.css`) —
build your page from it instead of re-declaring look and feel. The names
and values mirror the core Settings panes' `settings-forms.css`, so a
page made of these reads like a built-in category:

| Class | For |
| --- | --- |
| `.field` (+ `label`, control, `.field-hint`) | one labeled setting |
| `.section-hint` | a free-standing hint under an `h3` |
| `.rows` / `.row` / `.row > .name` / `.check` | dense editable row lists |
| `.switch-row` / `.switch-label` / `.switch-hint` | checkbox toggles |
| `button.ghost` / `button.link` / `button.link-danger` | quiet actions |
| `.badge`, `.empty`, `.mono` | chips, empty states, code text |
| `h3` (in a `<section>`) | your page's own group headings |

`input[type=text/password]`, `select` and `textarea` are styled by the
base sheet; inside a `.field` they stretch, inside `.rows`/`.row` selects
render compact. Anything beyond this vocabulary (cards, trees, pickers)
goes in **your own stylesheet under your prefix** — the base sheet styles
the shared primitives only. See the assistant plugin's Actions page for
the mixed case, the templates page for the pure-field case.

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
