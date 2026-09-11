# 7. Deployment View

Windows-first, single machine, no server component — the app and the
vault folder both live on the user's PC (the vault optionally inside a
OneDrive-synced folder, out of the app's control). Packaging is
electron-builder ([ADR-0023](09_architecture_decisions/0023-windows-packaging-electron-builder.md)).

## Build inputs

`npm run pack` (or `pack:dir` for a fast unpacked build) runs, in order:

1. `clean` — wipes `dist/`, `dist-electron/`, `release/` (`tsc` never
   cleans its `outDir`, so a stale build could otherwise ship orphaned
   files).
2. `build` → `prebuild` regenerates `src/assets/build-info.json`
   (`scripts/stamp-build.mjs`: `buildNumber` = `git rev-list --count HEAD`,
   plus the short SHA and build timestamp — a unique, monotonic id the
   About pane shows so builds already in testing can be told apart; the
   file is gitignored, it is not byte-stable) and `src/assets/licenses.json`
   (`scripts/generate-licenses.mjs`, production deps only — a superset of
   Angular's `3rdpartylicenses.txt` because it also covers the
   main-process packages `yaml` / `nspell` / `dictionary-*`), then
   `ng build` (→ `dist/drey/browser/`), `tsc -p electron/tsconfig.json`
   (→ `dist-electron/`) and `build:plugins`
   (`scripts/build-plugins.mjs`, which compiles each plugin's `main/` and
   `renderer/` with its own tsconfig and merges everything into one tree
   per plugin, → `dist-electron/plugins/<id>/`).
3. `electron-builder --win` reads `electron-builder.yml`.

## Artifacts (`release/`)

| Target     | File                        | Notes |
|------------|-----------------------------|-------|
| `nsis`     | `drey-<version>-setup.exe`  | Installer. `oneClick: false`, per-user (`perMachine: false`), the user may change the install dir, `LICENSE` shown. |
| `portable` | `drey-<version>-portable.exe`| Single self-extracting exe, no install. |
| `dir`      | `release/win-unpacked/`     | `pack:dir` only — the app tree, for a quick smoke test. |

Both installed and portable builds use the **same** config directory,
`%APPDATA%\drey` (`productName` is lowercase on purpose) — `app-config.json`
(LLM / Actions / spellcheck / appearance / MCP / entry templates) and
`vault-config.json` (the active vault path).

## App layout & the `app://` renderer

`main` is `dist-electron/electron/main.js`. The production renderer is
`dist/drey/browser/`, resolved as `path.join(__dirname, '../../dist/drey/browser')`
and served through the privileged **`app://`** scheme
(`net.fetch(pathToFileURL(...))`, which is asar-aware). So `dist-electron/`
and `dist/drey/browser/` ship side by side under the app root with that
exact `../../` relationship; the `files` list in `electron-builder.yml`
keeps it.

## Plugins in the package ([ADR-0044](09_architecture_decisions/0044-runtime-plugin-system.md))

The **built-in plugins ship inside the app**: each is a complete tree —
`plugin.json` (manifest), `main/` (CommonJS, loaded by the main process
with a plain `import()`), `renderer/` (ES2022 modules + CSS) and `shared/`
(types erased at build) — merged into `dist-electron/plugins/<id>/` by
`scripts/build-plugins.mjs`. The `files` globs carry the `.js`/`.json`
entries plus an explicit `dist-electron/plugins/**/*.css`.

- **Serving**: the privileged **`plugin://<id>/<path>`** scheme resolves
  against the plugin's `renderer/` folder (the main process asks the
  plugin host which root belongs to an id). It is served through the same
  asar-aware `net.fetch(pathToFileURL(...))` pattern as `app://` — plugin
  files read fine out of the asar — with an explicit `Content-Type`
  (`.js` → `text/javascript`, `.css` → `text/css` — a wrong MIME breaks ES
  module loading) and `Access-Control-Allow-Origin: *` (the renderer
  fetches modules in CORS mode), and a `path.relative` escape guard that
  rejects any URL resolving outside the plugin root (stricter than
  `app://`'s prefix check, Windows-safe).
- **Verified packed** (stage 10): everything plugin-related works from
  **inside the asar** — no `asarUnpack` entry for plugins. Discovery
  reads the manifests through the asar-patched `fs`, the CommonJS mains
  load with a plain `import(pathToFileURL(...))` (Electron ≥ 28's ESM
  loader is asar-aware; verified on Electron 44), and `plugin://` serves
  renderer modules + CSS. `node scripts/verify-pack.mjs` (`npm run
  verify:pack`, run after `pack:dir`) checks the asar contents and boots
  the packed exe from a throwaway profile with every built-in enabled,
  asserting all plugins `active`, a `plugin://` renderer executing (the
  sample plugin's File-menu row) and `plugin:invoke` roundtrips, plus
  startup timings.
- **User-installed plugins** are *not* packaged: discovery also scans
  `%APPDATA%\drey\plugins\<id>\` (beside `app-config.json`, ADR-0010) and
  a `DREY_EXTRA_PLUGIN_DIR` override for dev/test. A user plugin shadows
  nothing — built-ins win id collisions. Disabling is
  `plugins.disabled` in `app-config.json` (Settings → Panels & plugins);
  an `apiVersion` mismatch marks the plugin `incompatible` and skips it.

## asar and `asarUnpack`

`asar: true`. Three paths are **unpacked** to `resources/app.asar.unpacked/`:

- `node_modules/dictionary-de` / `dictionary-en` — ESM packages that
  `fs.readFile(new URL('index.aff'/'index.dic', import.meta.url))` at
  load; they must be real files (`electron/spellcheck.ts` reaches them by
  a bare-specifier dynamic `import()`).
- `dist-electron/electron/mcp/stdio-bridge.js` — an **external** `node`
  (an MCP client such as Claude Desktop) runs it directly, and a plain
  Node process does not redirect `app.asar` → `app.asar.unpacked`. The
  `mcp:status` IPC reports the unpacked path (`stdioBridgePath()` in
  `main.ts`, guarded by `app.isPackaged`) so the Settings → MCP config
  snippet points at a file that exists.

No native modules anywhere (`nspell` and `yaml` are pure JS), so there is
**no `node-gyp` / electron-rebuild step**.

## First run / limitations

- The first `electron-builder` invocation downloads `winCodeSign` and the
  NSIS toolchain (~100 MB) into `%LOCALAPPDATA%\electron-builder\Cache` —
  needs network once; offline CI must pre-seed `ELECTRON_BUILDER_CACHE`.
- **No code signing yet.** The installer and portable exe are unsigned, so
  Windows SmartScreen shows an "unknown publisher" prompt. Acceptable for
  personal / small-team use; a real cert is a later step. No auto-update
  channel either.
- `build/icon.ico` / `build/icon.png` and `public/icon.png` /
  `public/favicon.ico` are generated from `build/logo-source.png` by
  `npm run make:icon` (`scripts/make-icon.mjs`, `sharp` + `png-to-ico`),
  all committed. The script trims the source art to its bounding box and
  recentres it near edge-to-edge in a transparent square — re-run after
  changing the source.
