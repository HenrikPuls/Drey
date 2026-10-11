# 1. Electron main/renderer process split via contextBridge

## Status
Accepted

## Context
The app needs filesystem access (vault files), a local LLM HTTP client
(LM Studio), and native OS integration (global hotkey, tray, popup
windows) — none of which a sandboxed web renderer can do on its own.
Electron's classic shortcut is enabling `nodeIntegration` in the renderer
so it can call Node/Electron APIs directly. That's simpler to wire up, but
it means every renderer bug (or, later, any pasted/rendered third-party
content) runs with full filesystem and process access — no security
boundary between "display notes" and "read/write arbitrary files".

## Decision
Keep the standard Electron security posture: `nodeIntegration: false`,
`contextIsolation: true` in the renderer. All filesystem and LLM access
lives in the main process. The renderer talks to it only through a
`contextBridge`-exposed API defined in `electron/preload.ts`, backed by
typed request/response interfaces shared between main and renderer
(`shared/`) rather than passing `any`-typed payloads over raw
`ipcRenderer.send`/`on`.

## Consequences
- Every new capability (read a file, call LM Studio, register a hotkey)
  needs an explicit IPC channel + handler + preload exposure + shared
  type, instead of the renderer just calling Node APIs inline. More
  boilerplate per feature.
- In return, the renderer process has no ambient filesystem/process
  access at all — a bug or, later, any injected/pasted HTML content in
  the note view can't reach outside the exposed API surface.
- The shared-types module becomes the single source of truth for what
  crosses the boundary, which keeps main and renderer from drifting out
  of sync on request/response shapes (enforced by `tsc`, not by
  convention).

## Later change — sandbox and Content-Security-Policy (2026-10-11)

The decision above left two things open that the 2026-10-11 architecture
review named as urgent, because the renderer by now draws a lot it did
not write (notes of a cloned Git vault, fetched web pages, MCP tool
results, model output) next to a bridge that has grown to file writes
outside the vault (`external:write`) and plugin backends that start
programs (`plugin:invoke` → git).

**The main window is sandboxed.** It ran with `sandbox: false` since
milestone 1 because a sandboxed preload cannot `require` a sibling file
and `preload.ts` imports the channel names from `shared/ipc-api`. The
preload is now bundled: `scripts/bundle-preload.mjs` (esbuild) runs after
`tsc` and writes one file with no `require` besides `electron` over tsc's
output. `tsc` stays the typecheck; esbuild only inlines. esbuild was
already in `node_modules` through Angular and is now a declared dev
dependency. Considered and not done: moving the channel names into the
preload by hand (two copies of the IPC contract), and switching the whole
main process to a bundler (a much larger change for no gain here).

**The page carries a Content-Security-Policy**
(`electron/content-security-policy.ts`): `default-src 'none'`, scripts
only from `'self'` and `plugin:`, no inline script, no `eval`, no network
connection, frames only from `plugin:` and `drey-asset:`. It is sent as a
response header by the `app://` handler; a dev run adds the same policy
to `ng serve`'s page through the session. A header was chosen over a
`<meta>` tag so one function is the single source for both runs and the
dev socket can be added without a second `index.html`.

Consequences:

- The HTML sanitizer is no longer the only layer: markup that slips
  through it cannot run script.
- `style-src` keeps `'unsafe-inline'` — Angular and CodeMirror inject
  styles and the UI sets `style` attributes. `img-src` keeps `http(s)`
  because notes may show remote pictures. Both are recorded in `docs/11`.
- The production build no longer inlines critical CSS
  (`inlineCritical: false`): that feature adds an inline script to
  `index.html`.
- A plugin's renderer may not use inline scripts, `eval` or `fetch` to
  the network; it reaches the network through its main side
  (`plugins/AUTHORING.md`).
- `drey-asset:` is now CORS-enabled, answering with the page's origin as
  the only allowed one, so the page can probe a vault file with `fetch`.
- The e2e fixture fails a test on any policy violation in the console.
