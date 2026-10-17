# Drey — your private AI knowledge vault

Local, topic-based note-taking app (Electron + Angular). See
[`AGENTS.md`](AGENTS.md) (the tool-neutral agent entry point) and
[`CLAUDE.md`](CLAUDE.md) for the full project context, and
[`specs/`](specs/) for the binding concept/schema/classifier
specifications. Architecture documentation lives in [`docs/`](docs/)
(arc42); the end-user manual is [`docs/manual/manual.md`](docs/manual/manual.md)
(with screenshots).

## Prerequisites

No system-wide Node.js install is required or assumed. A portable Node.js
runtime is vendored under `.tools/node/` (not checked into git) for this
project only. Before running any command below, from a new terminal:

```powershell
. .\env.ps1
```

This puts `node`/`npm` on PATH for the current session only.

## Setup

```powershell
npm install
```

Also downloads the Electron binary (see the `postinstall` script) since
npm's install-scripts allowlist blocks it from running automatically.

## Development

```powershell
npm run dev
```

Runs the Angular dev server (with live reload) and launches Electron
pointed at it.

## Production build + run

```powershell
npm run build     # builds the Angular renderer and the Electron main/preload process
npm run electron  # launches Electron against the built output
```

## Windows packaging

```powershell
npm run pack       # installer + portable .exe  -> release/
npm run pack:dir   # unpacked folder only       -> release/win-unpacked/
```

`npm run pack` cleans, runs `npm run build` (renderer + Electron
main/preload), then electron-builder for Windows. It writes into
`release/`:

- `drey-<version>-setup.exe` — NSIS installer (per-user, installation
  directory selectable)
- `drey-<version>-portable.exe` — single-file portable build

`npm run pack:dir` does the same build but stops at `--dir`: an unpacked
`release/win-unpacked/` with no installer — faster, for smoke-testing the
packaged app. Packaging config is in [`electron-builder.yml`](electron-builder.yml);
see [`docs/09_architecture_decisions/0023-windows-packaging-electron-builder.md`](docs/09_architecture_decisions/0023-windows-packaging-electron-builder.md)
for the rationale.

## Quick-capture

While the app is running, press **Ctrl+Alt+N** anywhere to jump into
today's daily note. It brings the window forward, opens
`daily/YYYY-MM-DD.md` in the active vault (creating it if needed), and
starts a fresh `## HH:mm` section — type, then save with **Ctrl+S** like
any file.

New daily notes are created from `templates/daily.md` in the vault. That
file is generated with a starter layout the first time you use the
hotkey; edit it to change how future daily notes look. Placeholders:
`{{date}}`, `{{time}}`, `{{datetime}}`, `{{title}}`.

The main window must stay open — there is no tray/background mode yet. If
the hotkey does nothing, another app already owns it (a warning is logged
to the main-process console); rebinding comes in a later milestone.

## Tests

```powershell
npm test
```

## Debugging in VS Code

Run and Debug panel → **Electron: Full App (dev)** and press start (or
F5). Builds `electron/` and starts the Angular dev server automatically,
then launches the app with breakpoints working on both sides of the IPC
boundary: `electron/*.ts` (main/preload) and `src/app/**/*.ts` (renderer).
See `.vscode/launch.json` for the individual pieces (main process only,
renderer only, against the production build instead of the dev server)
and their inline comments for the reasoning -- notably why
`ELECTRON_RUN_AS_NODE` is explicitly cleared in these configs (see
`docs/11_risks_and_technical_debt.md`, "Environment gotchas").

## License

Drey is licensed under the **GPL-3.0-only** — see [`LICENSE`](LICENSE).
The third-party licenses of everything bundled into a build are listed
in the app (Settings → About). The bundled draw.io diagram editor ships
under Apache-2.0; "draw.io" is a registered trademark of draw.io AG —
Drey is not affiliated with, endorsed by, or sponsored by draw.io.
