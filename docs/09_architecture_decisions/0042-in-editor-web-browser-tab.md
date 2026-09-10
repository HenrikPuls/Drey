# 0042 — In-editor web browser tab

## Status

Accepted

## Context

The project owner asked for a web browser that opens as a tab in the
editor area — an address bar plus a page view for arbitrary websites,
alongside Markdown and image tabs. It is a stepping stone toward the
roadmap's inline-document (Req-2), Copilot-web (Req-3) and Jira/Atlassian
(Req-4/17) directions, all of which want web content shown inside the app
rather than kicked out to the OS browser.

Two ways to embed a live page in an Electron 44 renderer:

1. **`<webview>` tag** — a DOM element inside `PaneLeaf`, exactly like the
   existing `ImageTab`. Clips / hides / z-orders naturally with the split
   panes, docks, menus and dialogs; needs almost no geometry code and no
   new IPC surface (navigation and events are DOM methods / events on the
   element). Requires `webviewTag: true` in `webPreferences`. Chromium
   officially discourages `<webview>`, it is heavier per instance, and its
   process model is a second-class citizen.
2. **`WebContentsView` (main process)** — the current, supported API. Real
   process + session isolation, better performance. But the main process
   must position the view over the Angular layout on every splitter drag /
   dock resize / window resize / tab switch, hide it under every modal,
   and expose a full IPC surface for navigate / back / forward / reload /
   events.

## Decision

Use **one main-process `WebContentsView` per browser tab**, owned by
`BrowserViewManager` and added to `mainWindow.contentView`.

- A browser tab is a **fileless `OpenDoc`** keyed `browser://<n>` — the
  same precedent as `kind: 'image'` tabs and `openScratch` drafts. `://`
  guarantees the key never collides with a vault path nor matches the
  `startsWith(prefix)` logic in `retargetTabs` / `closeTabsUnder`.
  `OpenDoc.kind` gains `'browser'`; the seven text-only short-circuits in
  `EditorService` (`save`, `saveAll`, `saveAs`, `setViewMode`,
  `updateBuffer`, `requestInsertText`, `setTaskDone`) widen from
  `=== 'image'` to `!== 'text'`.
- `BrowserTab` (renderer) renders **only** the chrome — back / forward /
  reload-stop / address bar / find bar — plus an empty `.viewport`
  placeholder whose client rect it streams to the manager (rAF-coalesced)
  as the view's bounds. The page itself never enters the renderer DOM.
- **Session:** a persistent, isolated partition `persist:webtab`. Logins
  survive a restart (useful for the M365 / Jira direction) but are
  quarantined from the app's own origin and never touch the vault. No
  clear-data UI in v1.
- **Security:** each view's `webContents` gets its own (looser than the
  main window's dev-server / `app://` allowlist) handlers —
  `will-navigate` allows only `http(s):` / `about:`; `setWindowOpenHandler`
  routes an http(s) popup back to the renderer as a new browser tab and
  denies everything else; the partition session denies every permission
  request by default. `sandbox: true`, no preload, no Node.
- **Address bar:** `normalizeAddress` — an existing scheme or host-shaped
  input (`example.com`, `localhost:3000`, `127.0.0.1:8080/x`) gets
  `https://`; anything else becomes a DuckDuckGo search. Hard-coded engine
  for v1.
- **Find-in-page:** `webContents.findInPage` / `stopFindInPage`, results
  on the `found-in-page` event; `Ctrl/Cmd+F` in a focused browser tab
  opens the find bar.
- **Right-click menu:** Electron shows none of its own for a
  `WebContentsView`, so `BrowserViewManager` builds one on the
  `context-menu` event — back / forward / reload, the standard clipboard
  verbs (gated on `params.editFlags`), open-link / open-image in a new
  tab + copy-address, "search the web for <selection>", and inspect
  element. Link / search actions reuse the `browser:open-tab` push.

### The occlusion problem

A `WebContentsView` paints **above the entire renderer DOM**, regardless
of `z-index`. Mitigation is one central mechanism:

- `OverlayGuardService` ref-counts "an Angular overlay is on screen".
- The `[appOverlayGuard]` attribute directive holds a guard for as long as
  its (already `@if`-gated) host element is mounted. It sits on the root of
  the confirmation dialog, the Settings overlay, the image lightbox, the
  template picker, the editor `⋯` menu, the editor right-click menu, the
  titlebar menu dropdowns and the tab-bar context menu.
- While `suppressed()` is true (or a splitter / dock drag is running, via
  `BrowserViewService.layoutGesture`), every browser view is forced
  hidden; each `BrowserTab` re-asserts visibility when it clears.
- `BrowserViewManager` also hides all views on window `blur` / `minimize`
  / `hide` (a renderer `blur` also fires when focus enters the view
  itself, so this half lives in main).

A future overlay added without the directive would paint behind a visible
browser view — the directive placement is a checklist item for any new
`position: fixed`, high-`z-index` surface.

## Consequences

- **Positive:** real process + session isolation for untrusted pages; no
  deprecated `<webview>`; the split-view / dock geometry "just works"
  because bounds are recomputed from the placeholder rect every frame, so
  moving a browser tab between panes needs no special handling.
- **Bounds lag.** `setBounds` trails the DOM by ~1 frame, so the view is
  hidden for the duration of a splitter / dock / window-resize gesture and
  re-measured on release rather than trailing it.
- **App keybindings are dead while the view is focused.**
  `KeybindingService`'s capture-phase listener is on the renderer
  `webContents`; keystrokes inside the `WebContentsView` never reach it.
  Acceptable — it matches a real browser pane; find is handled inside the
  chrome.
- **Split-view focus.** Clicking inside the page does not bubble to
  `PaneLeaf`'s `mousedown`, so it does not focus the pane; the tab or the
  chrome toolbar does. Browser-view visibility is therefore *not* gated on
  pane focus (unlike `ImageTab`'s keyboard handling) — every mounted
  browser tab shows its page.
- **Lifecycle.** `BrowserViewService` diffs `editor.openDocs()` and
  destroys the native view for any `browser://` key that vanished, so
  every close route (`closeTab` / `closeAll` / `closeOthers` /
  `closeTabsUnder`) needs zero browser-specific code. `destroyAll()` runs
  on `window 'closed'` and `app 'will-quit'`.
- **Privacy.** `persist:webtab` stores cookies + storage under the OS
  user-data dir indefinitely, with no in-app "clear browsing data" yet.
- **New IPC surface:** eleven request channels + `browser:event` /
  `browser:open-tab` pushes (`shared/browser`, `electron/ipc/
  browser-handlers.ts`).
- **New feature modules:** `electron/browser/`, `shared/browser/`,
  `src/app/browser/` (ADR-0016 barrels, registered in `eslint.config.mjs`).
