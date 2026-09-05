# CyberNotes

Local, topic-based note-taking app (Electron + Angular). See
[`CLAUDE.md`](CLAUDE.md) for the full project context and
[`specs/`](specs/) for the binding concept/schema/classifier
specifications. Architecture documentation lives in [`docs/`](docs/)
(arc42).

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

## Tests

```powershell
npm test
```
