# Tutorial: writing a Drey plugin

A step-by-step walkthrough of your first plugin, using the **sample
plugin** (`plugins/sample/` in the repository) as the running example. It
exercises every surface a plugin can contribute: a dock widget, a command,
a settings page, a document tab kind, and a main-process backend.

This is the *how to get started*; the reference for the rules once you are
underway is [AUTHORING.md](AUTHORING.md) (layout, manifest fields, styling
rules, the settings-page vocabulary, testing). The *why* of the design
lives in [ADR-0044](../docs/09_architecture_decisions/0044-runtime-plugin-system.md).

Since milestone 70 the sample plugin is **not part of the default build**
(ADR-0068): it exists as this tutorial's executable example and as an e2e
fixture. Section "Run the sample" shows how to load it anyway — and the
"Install" section is the same path your own plugin takes into a real Drey.

## What a plugin is

Drey is a **base application** (shell, editor, vault IO, LLM transport)
plus **runtime-loaded plugins** — in-process, trusted extensions that fill
base-owned registries: dock panels, settings pages, commands, editor
extensions, document tab kinds, save hooks. A plugin is a folder:

```
my-plugin/
  plugin.json     manifest — id, name, entries, permissions
  main/           CommonJS, runs in the main process (optional)
  renderer/       browser ES module + CSS, plain DOM (optional)
  shared/         types shared between the two sides (optional)
```

- The **main side** gets a `ctx` with Node access: vault read/write, LLM
  chat, its own config store, IPC handlers it registers under its own
  name.
- The **renderer side** gets an `api` for UI: widgets, commands, settings
  pages, the active document. It is plain DOM — no Angular, no Node — and
  loads over the `plugin://` protocol, which can only serve files from
  your plugin folder.
- **Trust model**: plugins run in-process with full rights. Permissions in
  the manifest are documentation shown to the user, not a sandbox.

## Step 1 — the manifest

`plugins/sample/plugin.json`:

```json
{
  "id": "sample",
  "name": "Sample plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Exercises every plugin-API surface: a dock widget, a command, a settings page, document access, and the backend roundtrip.",
  "author": "Drey",
  "main": "main/index.js",
  "renderer": "renderer/index.js",
  "permissions": ["documents", "vault", "commands", "settings", "llm", "main-process"]
}
```

The fields that matter:

- `id` — must match `^[a-z][a-z0-9-]{1,63}$` **and** the folder name. It is
  your IPC namespace, your config key and your CSS-class prefix.
- `apiVersion` — the plugin-SDK **major**. It must equal Drey's current
  major (`1`) or the plugin is reported `incompatible` and never loaded.
  Minor SDK additions are documented in AUTHORING.md.
- `main` / `renderer` — entry paths relative to the plugin root, POSIX
  style, never leaving it.
- `permissions` — free-form documentation of what you touch; Settings
  shows them.

## Step 2 — the main side

`plugins/sample/main/index.ts` (compiled to CommonJS). A main entry
default-exports `{ activate(ctx) }` (and optionally `deactivate()`):

```ts
import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';

const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    // An IPC method the renderer side can call: registered under this
    // plugin's name, unreachable for other plugins.
    ctx.ipc.handle('ping', (payload) => {
      ctx.log(`ping received: ${JSON.stringify(payload)}`);
      ctx.ipc.emit('pong', { echo: payload, at: Date.now() });
      return { ok: true, appVersion: ctx.app.appVersion };
    });

    // A save hook: fired by the base after every note save.
    ctx.save.onNoteSaved((event) => {
      ctx.log(`note saved: ${event.path} (${event.content.length} chars)`);
    });

    // This plugin's own key/value config (`<userData>/plugins/<id>/config.json`).
    const activations = ((await ctx.config.get<number>('activations')) ?? 0) + 1;
    await ctx.config.set('activations', activations);
  },
};

export default plugin;
```

Through `ctx` a main side reaches the vault (`ctx.vault.read`, `write`,
`writeAnnounced`, `delete`, …), the LLM (`ctx.llm.chat` — including tool
use and streaming), window lifecycle events and its own logger. The full
surface is typed in `shared/plugin-api/main-plugin-api.ts`.

Two conventions the sample demonstrates:

- Never name the top-level export `module` — it shadows the CommonJS
  binding and breaks Node's module detection in the compiled file.
- Everything you hand out is namespaced for you (your IPC methods, your
  config, your log prefix) — you only pick boring, unique names.

## Step 3 — the renderer side

`plugins/sample/renderer/index.ts` (compiled to an ES module). The entry
default-exports `{ activate(api) }` and registers what it contributes:

```ts
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    // A dock panel: header, status callback, and a mount function that
    // fills the panel body with plain DOM and returns a cleanup.
    api.ui.registerWidget({
      id: 'sample',
      title: 'Sample',
      defaultDock: 'right',
      defaultOpen: true,
      status: () => `evt ${bufferEvents}`,
      mount: (body) => {
        body.appendChild(buildWidget(api));
        return () => undefined;
      },
    });

    // A command with a keybinding, appearing in the command palette.
    api.commands.register({
      id: 'sample.stamp',
      label: 'Sample: insert timestamp',
      keybinding: 'Mod+Alt+J',
      run: () => {
        api.documents.insertAtCursor(`\n${new Date().toISOString()} — sample command\n`);
      },
    });

    // … a settings page (api.ui.registerSettingsPage), a document tab kind
    // (api.ui.registerDocKind), a File-menu row (api.ui.registerMenuContributions).
  },
};
```

The widget body is built with `document.createElement` — no framework, no
bundler. The rules that bite every newcomer:

1. **Prefix every CSS class** with your plugin id; your stylesheet is
   global once injected.
2. **Design tokens only** (`--text-*`, `--bg-*`, `--accent*`, … from
   `src/styles.css`) — never literal colors, never `px` font sizes.
3. **No `alert()`/`confirm()`** — they break Windows keyboard focus; use
   `api.ui.showMessage` / `api.ui.showModal`.
4. The `plugin://` protocol serves **only your folder** — import types
   from anywhere, but runtime values must live under `plugins/<id>/`.

The settings page in the sample is built from the shared form vocabulary
(`.field`, `.switch-row`, `button.ghost`, …) so it reads like a built-in
Settings category; the host draws its title and `description`, the page
only its fields — see AUTHORING.md for the full table.

## Step 4 — build and run (in a checkout)

Plugins are compiled by the repository's build script — TypeScript on both
sides, no bundler:

```
npm run build:plugins
```

Output lands in `dist-electron/plugins/<id>/` — one folder mixing a
CommonJS `main/` with an ES-module `renderer/`, marked by small
`package.json` type markers the script writes. A plugin discovered there
is built-in; drop your folder into the running app via the install flow
below instead when you want to test as a user would.

**After touching `plugins/**` or `shared/plugin-api/**`, rebuild and
restart Electron** — the running app keeps the previously built plugin
code.

To develop comfortably, keep `npm run dev` running and re-run
`npm run build:plugins` + restart after changes; e2e-style smoke tests are
described in AUTHORING.md ("Testing convention").

### Run the sample

The sample plugin is built (and thereby discovered) only when you ask for
it (ADR-0068):

- PowerShell: `$env:DREY_BUILD_SAMPLE_PLUGINS = '1'; npm run build:plugins`
- or once for a whole e2e round: `npm run e2e` (the script sets the flag)

Restart the app afterwards — plugin discovery runs at startup.

## Step 5 — package it

The built folder **is** the package. Zip the *contents* of
`dist-electron/plugins/my-plugin/` so that `plugin.json` sits at the
archive root:

```powershell
Compress-Archive -Path dist-electron\plugins\my-plugin\* -DestinationPath my-plugin.zip
```

or with Windows' bundled tar (bsdtar):

```powershell
tar -a -c -f my-plugin.zip -C dist-electron\plugins\my-plugin plugin.json main renderer
```

Rules the installer enforces (it refuses everything that could not load
anyway — see ADR-0068):

- `plugin.json` at the archive root, valid, with `apiVersion` matching
  Drey's major;
- the entry files the manifest references (`main`, `renderer`, `css`)
  must be in the archive;
- no path may leave the plugin folder (zip-slip is refused);
- the id must not collide with a built-in plugin of the Drey that
  installs it.

Standalone note: you do not need Drey's build script to produce this
layout, but you must replicate its two rules — the `main/` side is
CommonJS, the `renderer/` side is an ES module — and mark them with
`package.json` type files in the package (`{"type":"commonjs"}` in
`main/`, `{"type":"module"}` at the root), exactly as the build script
does. Authoring inside a checkout is the well-trodden path: you get the
type checking against the real SDK for free.

## Step 6 — install, upgrade, remove

In Drey: **Settings → Panels & plugins → Install from file…**, pick the
`.zip`, restart when offered. That is the whole flow — first steps are
deliberately local (no marketplace, no auto-update):

- **Install** extracts to `<userData>/plugins/<id>/` (the app-level
  discovery root) and activates on the next start.
- **Upgrade** = install again. The plugin's files are replaced, its
  `config.json` (everything it saved through `ctx.config` /
  `api.settings`) is kept.
- **Remove** (the Remove action on installed rows in the same settings
  page) deletes the folder — recycle bin first — and takes effect on the
  next start.

That is also how you ship updates to your own machines: build, zip,
install.

## Where to go next

- [AUTHORING.md](AUTHORING.md) — the reference: manifest details, SDK
  minor-version additions, styling rules, settings vocabulary, testing.
- [ADR-0044](../docs/09_architecture_decisions/0044-runtime-plugin-system.md)
  — the plugin system's design and its five safety rules.
- [ADR-0068](../docs/09_architecture_decisions/0068-local-plugin-packages.md)
  — the package format and install flow you just used.
- `plugins/sample/` — this tutorial as running code; `e2e/plugins.spec.ts`
  shows the manifest + module shapes as a self-contained plain-JS plugin.
