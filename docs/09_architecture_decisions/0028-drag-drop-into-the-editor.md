# 28. Drag-and-drop into the editor: linked images, inlined text, downloaded web images

## Status

Accepted. Extends the paste/drop image capture
([ADR-0024](0024-binary-vault-asset-write.md)) and depends on the window
drag guard ([ADR-0027](0027-window-dnd-navigation-guard.md)); crosses the
IPC boundary ([ADR-0001](0001-electron-process-split-contextbridge.md))
for the download path.

## Context

Paste already saved an image into `attachments/` and inserted
`![](attachments/…)`. The project owner wanted the same by **dragging**,
from three sources, each with a different desired result:

- **An OS file** (Explorer, Finder) — same as paste: copy the bytes in,
  insert `![](attachments/…)`.
- **A file already in the vault**, dragged from the Files panel — it is
  already stored and foldered by the user, so **link it in place** with a
  relative path, no second copy. And a **text file** dragged the same way
  should have its **contents inlined** at the drop point, not linked.
- **A picture on a web page**, dragged straight from a browser —
  **download it into the vault** so the note renders offline, and record
  the **source URL visibly under the image**.

## Decision

**One `image-paste.ts` drop handler that branches on what the
`DataTransfer` carries; a private `application/x-drey-vault-path` type for
the Files-panel source; a new `vault:save-asset-from-url` IPC for the
download.**

- **OS image file** — unchanged (`config.save` → `VaultManager.saveAsset`,
  ADR-0024). `imageFiles()` now also accepts a file by **extension** when
  the OS left `File.type` blank (a Windows Explorer drag).
- **Files-panel drag** — the file `<button>` gets `draggable="true"` and a
  `dragstart` that puts `entry.relativePath` on
  `application/x-drey-vault-path` (and `text/plain`). The editor's `drop`:
  - image extension → `insertRelativeLink`: `noteRelativeLink(openPath,
    vaultPath)` (`shared/note-link.ts`) → `![](../assets/logo.png)`,
    synchronous, no save, no placeholder. A path with a space/paren is
    emitted in CommonMark angle form `![](<…>)`; `parseImage` in
    `live-preview/block-render.ts` now strips a `<>` wrapper off the
    sliced URL so it still resolves.
  - text extension (`shared/text-extension.ts` allowlist) → read via
    `VaultService.readTextFile` and insert the **contents raw** at the
    drop point (no link, no wrapping), capped at 2 MB.
  - anything else → nothing (the drop is still `preventDefault`ed).
  Carried on a private DataTransfer type and consumed in the CM handler so
  the **drop coordinate** (`posAtCoords`) is honoured — deliberately not
  routed through `EditorService.requestInsertText`, which inserts at the
  caret and no-ops off a text tab.
- **Web image** — `imageUrlFromTransfer` pulls an `http(s)` image URL from
  `text/uri-list` / an `<img src>` in `text/html` / `text/plain` (a plain
  dragged link with no image is ignored). New IPC
  `vault:save-asset-from-url(url, noteRelPath)` →
  `VaultManager.saveAssetFromUrl`: `fetch` in the **main process**
  (renderer has no Node, and CORS would block a renderer fetch),
  http(s)-only, follow redirects then re-check the final protocol, 15 s
  timeout, 25 MB cap (Content-Length pre-check + post-read), require an
  `image/*` content-type or an image extension on the final URL; then
  reuse `saveAsset(bytes, ext, noteRelPath)`. The insert is
  `![](attachments/…)` **followed on the next line by `[Source](<url>)`**
  (a soft break, so it renders as a visible caption directly under the
  image).

### Alternatives considered

- **Copy the vault file into `attachments/` on drop.** Rejected — the
  bytes are already in the vault; a copy duplicates and detaches the
  reference from the user's own foldering.
- **Route the Files-panel drag through `EditorService.requestInsertText`.**
  Loses the drop coordinate; no-ops when the active tab isn't a text
  document; the panel would still need `dragstart` and the editor would
  still need to `preventDefault` the drop.
- **Renderer-side `fetch` for the download.** `nodeIntegration:false`,
  and cross-origin image hosts have no permissive CORS; the write still
  needs an IPC. Main-process fetch is one hop and already precedented
  (`electron/llm/lm-studio-client.ts`).
- **Store the source URL as the image `title` (`![](p "url")`).** The
  owner wanted it *visible in the rendered note*, which a title tooltip
  is not — hence the caption line.
- **A heuristic "is this text?" instead of an allowlist.** An allowlist is
  predictable and never tries to inline a binary as text.

## Consequences

- The Files panel is now a drag source. A drop that misses `.cm-content`
  but lands **inside an editor pane** (its tab strip, meta bar, empty
  state, or the padding / gutter around the text) now **opens the file as
  a tab in that pane** — `PaneDropService` (`src/app/panes/`), wired from
  `PaneLeaf`'s host `dragover` / `drop`. Scope: a Files-panel / calendar
  drag (`application/x-drey-vault-path`) or an OS file drag whose absolute
  path resolves inside the active vault root; an out-of-vault OS file, a
  directory, or a URL-only / web-image drag is left to the ADR-0027 guard
  (`Doc` is vault-relative throughout, so an arbitrary absolute path is a
  separate capability — a follow-up, not built). A drop that misses every
  pane too (titlebar, docks, status bar) is still the ADR-0027 no-op.
- The download path makes an **outbound network request from
  `VaultManager`** — the first. Threat model: http(s) only, final-protocol
  re-check after redirects (the fetch spec already refuses `file:`/`data:`
  redirect targets), 15 s timeout, 25 MB cap, image content-type/extension
  gate. **Residual, accepted:** no private-IP / DNS-rebinding block — a
  local-first single-user notes app, and the URL comes from the user's own
  drag.
- `![](<path with spaces>)` now renders in Live Preview (previously the
  `<>` leaked into the resolver). Percent-encoding was avoided — the
  resolver already `encodeURIComponent`s each segment and would
  double-encode.
- Text-file drop is a plain document edit: `Ctrl+Z` / `Ctrl+S` as usual.
