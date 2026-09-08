# 32. Field logging + a manual input-recovery escape hatch

## Status

Accepted. A pragmatic response to a bug that could not be reproduced on
the dev machine; not a root-cause fix.

## Context

The project owner hits an intermittent state in the **packaged** build:
suddenly **no** input field (native `<input>` in Settings, the entry
drawer, the editor) accepts typed text. Mouse selection and copy still
work. Only restarting the app clears it — Alt-Tab away and back does not.
Not correlated with drag-and-drop; happens during ordinary use.

Two problems: (1) the packaged build runs with no DevTools, so an
occurrence leaves **no trace** — `console.error` goes nowhere; (2) even if
we knew the cause, the user is stuck until a restart.

## Decision

### A log file, written by the main process

`electron/logger.ts` appends to `<userData>/logs/drey.log` (ISO-timestamped
lines, rotated once past ~1 MB). It is fed from:

- **main**: `process` `uncaughtException` / `unhandledRejection`, and each
  window's `webContents` `render-process-gone` / `unresponsive` /
  `preload-error`.
- **renderer** → main over a new `app:log` IPC channel: `LogService`
  mirrors `console.error/warn`, `window.onerror`, `unhandledrejection`,
  and a `LoggingErrorHandler` registered as Angular's `ErrorHandler`.

Best-effort throughout — a logging failure never propagates.

### A "Recover input" command

`InputRecoveryService.recover(reason)` (View menu → *Recover input focus*,
or `Ctrl+Alt+Shift+R`): logs a state snapshot, then dispatches a document
`Escape` (dismisses every menu / dialog / the lightbox), clears
`document.body` `user-select` / `cursor`, removes any orphaned
`.ctx-backdrop`, and moves focus back into the editor (or `<body>`).

### A watchdog

The same service runs a 4 s interval (only while the window is focused)
that auto-recovers on an unambiguous leftover: a lightbox flagged open
with no overlay painted, a `.ctx-backdrop` with no `.ctx-menu`, or
`<body>` left `user-select:none` with no gesture in progress. Gestures
(dock drag, image pan) now set a `data-drey-gesture` body attribute so the
watchdog can tell a legitimate `user-select:none` from a stuck one.

### Defensive hardening of the plausible culprits

- `ImageLightbox` focus-restore only targets a still-connected, non-`body`
  element; the close button is focused only if it is actually in the DOM.
- The editor context menu closes its full-screen backdrop **before**
  running the action (`try`-order), so a throwing action can't strand it.
- `DockService` and `ImageViewer` gestures now also end on `window` `blur`
  (a `pointerup` lost outside the window no longer strands the body
  styles + listeners), and clear the `data-drey-gesture` marker.

## Consequences

- If the lock recurs, the owner presses `Ctrl+Alt+Shift+R` (or restarts as
  before) and sends `drey.log` — which should finally show what threw or
  what state was left behind.
- The watchdog is conservative: it only acts on states that are always
  wrong, so it cannot fight a legitimately open overlay.
- New IPC surface: `app:log` (one-way, fire-and-forget). `AppInfo` is
  unchanged.
