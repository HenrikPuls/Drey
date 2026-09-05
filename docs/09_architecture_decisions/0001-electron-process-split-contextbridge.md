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
