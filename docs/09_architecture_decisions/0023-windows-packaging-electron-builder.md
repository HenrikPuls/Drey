# 23. Windows packaging with electron-builder

## Status

Accepted — first packaging setup. Builds on
[ADR-0010](0010-app-settings-storage.md) (`%APPDATA%` config),
[ADR-0021](0021-mcp-vault-server.md) (the stdio bridge) and
[ADR-0013](0013-inline-spellcheck.md) (the ESM dictionaries).

## Context

`electron-builder` was a devDependency but unconfigured — no `build`
key, no output config, no scripts, no icon, `version` still `0.0.0`. The
project owner wanted a Windows **NSIS installer and a portable exe**,
with proper identity and the supplied chipmunk logo as the icon.

Three things needed real decisions:

- **Where the output goes.** electron-builder's default
  `directories.output` is `dist/` — which Angular already owns
  (`dist/drey/`).
- **The ESM dictionaries and the stdio bridge inside `asar`.**
  `dictionary-de` / `dictionary-en` read their own `.aff`/`.dic` via
  `import.meta.url` + `fs.readFile`; and the MCP stdio bridge is executed
  by an **external** `node` that does not do the `app.asar` →
  `app.asar.unpacked` redirect Electron does.
- **Config in package.json vs. a separate file.** The project keeps
  `package.json` deliberately lean (no `build` key, minimal scripts), and
  the config is sizeable.

## Decision

**A dedicated `electron-builder.yml`, `directories.output: release`,
targeted `asarUnpack`, an explicit `files` allow-list, and a
`app.isPackaged`-guarded bridge path.**

- `electron-builder.yml` at the repo root (keeps `package.json` lean):
  `appId: de.lariscus.drey`, `productName: drey` (lowercase — packaged
  config stays in `%APPDATA%\drey`, matching dev), `copyright`,
  `directories.output: release` (+ `/release` gitignored),
  `directories.buildResources: build` (committed, holds `icon.ico` and
  the icon source).
- `win.target: [nsis, portable]`. NSIS: `oneClick: false`, per-user,
  changeable install dir, `LICENSE` shown.
- `asar: true` with `asarUnpack`:
  - `**/node_modules/dictionary-de/**`, `**/node_modules/dictionary-en/**`
    — no code change, they load as normal files from
    `app.asar.unpacked/`.
  - `dist-electron/electron/mcp/stdio-bridge.js` — plus `main.ts` now
    reports its real path: `stdioBridgePath()` returns
    `app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked') + <rel>`
    when `app.isPackaged`, else the `__dirname`-relative dev path. The
    `$`-anchored replace can't corrupt a path that merely contains
    "app.asar" earlier. This is the **one** place packaging changes
    observable behaviour (the Settings → MCP snippet).
- **Explicit `files` allow-list** — the default sweeps `src/`, `specs/`,
  `docs/` into the asar. We ship `dist-electron/**/*.{js,json}`,
  `dist/drey/browser/**`, `package.json`; exclude `**/*.map` and the
  three orphaned `tsc` outputs. Production `node_modules` are included by
  electron-builder regardless (devDeps auto-pruned); the renderer-only
  deps (`@angular/*`, `@codemirror/*`, …) ride along compressed rather
  than maintaining a fragile deny-list.
- `package.json`: `version` → `0.1.0` (so `app.getVersion()`, About and
  `licenses.json` agree), `author` / `homepage` / `description` set;
  scripts `clean` (wipe `dist` / `dist-electron` / `release` via a
  `node -e` one-liner, no `rimraf` dep), `pack` / `pack:dir`
  (`node node_modules/electron-builder/cli.js --win [--dir]`, PATH-
  independent per the no-global-node convention), `make:icon`.
- **Icon**: `scripts/make-icon.mjs` (`sharp` + `png-to-ico`, devDeps)
  crops `build/logo-source.png` (the supplied logo) tight to the mark,
  drops the wordmark, and writes `build/icon.ico` (16–256 px) +
  `build/icon.png`. All three committed; re-runnable.

## Consequences

- No `dist/` collision; `release/` is the one packaging output and is
  gitignored.
- The dictionaries and the stdio bridge work from a packaged app with no
  runtime code change beyond `stdioBridgePath()`.
- No native modules → no rebuild step. First `pack` run needs network
  (electron-builder downloads `winCodeSign` + NSIS to its cache).
- **Unsigned binaries** → SmartScreen "unknown publisher". Documented in
  `docs/07` / `docs/11`; a code-signing cert and an auto-update channel
  are deferred.
- `sharp` adds a ~10 MB prebuilt binary as a **devDependency** (build-time
  only, not shipped). `jimp` is a pure-JS fallback if that is ever
  unwanted.
