# 26. Image viewer: one zoom/pan component, a fullscreen lightbox, and `kind: 'image'` tabs

## Status

Accepted. Builds on the existing image *rendering* path (`drey-asset://`
scheme, `resolveVaultImageUrl`, the Live Preview `ImageWidget`) and on
[ADR-0009](0009-live-preview-decorations.md) (Live Preview widgets),
[ADR-0003](0003-multi-document-editor-tab-model.md) (the tab model) and
[ADR-0015](0015-editor-content-zoom.md) (content zoom, whose global
Ctrl+wheel guard this reuses).

## Context

Images could be pasted, dropped and rendered inline, but there was no way
to **view** one: no size control, no enlarge, and opening an image file
from the Files panel fell through `EditorService.openFile` into a text
tab full of mojibake (with `Ctrl+S` set to overwrite the file). The
project owner asked for Obsidian's model — a drag handle on a hovered
image, a hover "lens" that opens a whole-app zoom/pan viewer, and image
files opening as a real "document" tab with the same viewer.

## Decision

**One shared `ImageViewer` component, reused by a fullscreen
`ImageLightbox` overlay and a new `kind: 'image'` editor tab; inline
`![alt|W]` sizing driven by a drag handle that rewrites the note.**

- **`src/app/image-viewer/`** feature module (thin `index.ts` barrel,
  ADR-0016):
  - `ImageViewer` — `OnPush`, `src` input, `scale` / `natural` /
    `zoomPercent` readonly signals. **Plain mouse wheel zooms toward the
    cursor** (`shared/image-zoom.ts` `zoomToward`), drag pans (the
    `DockService.beginPointerGesture` recipe: `setPointerCapture` + `window`
    pointer listeners + body `cursor: grabbing`), `+`/`-`/`0` and an
    on-screen cluster call the same methods, `fit()` never upscales past
    100%. The wheel listener is attached by hand with `{ passive: false }`
    (Angular host `(wheel)` is passive); it coexists with
    `EditorZoomService`'s capture-phase global guard, which only
    `preventDefault`s Ctrl+wheel and never `stopPropagation`s.
  - `ImageLightbox` + `ImageLightboxService` — the service holds a
    `src = signal<string | null>`; the component is always mounted and
    self-gates on it (the `ConfirmationDialog` lifecycle, not Settings'
    `@if`), covers `inset: 0` at `z-index: var(--z-lightbox)`, closes on
    Escape / backdrop click. Opened from the Live Preview lens button and
    from the image tab's "Fullscreen" button — one viewer, one behaviour.
  - `ImageTab` — the centre-column sibling of `Editor`, chosen by
    `editor.activeKind()`; a 34px meta bar (path · zoom % · Fullscreen)
    over an `<app-image-viewer>`.
- **`--z-lightbox: 60`** added to `src/styles.css` `:root`. The rest of
  the z-ladder stays hardcoded (dock 6, content 5, menu-bar 30/40,
  Settings 30/31, confirmation dialog / menus 40/41); the lightbox gets a
  token because it is the new ceiling and anything future above it should
  compare against a name.
- **`OpenDoc.kind: 'text' | 'image'`** — an image tab carries no buffer
  (`savedContent === bufferContent === ''`, never dirty), skips `save` /
  `saveAs` / `setViewMode` / `updateBuffer`, and is otherwise an ordinary
  tab (tab bar, open-windows, dedupe on reopen, `closeTabsUnder` on
  delete). `EditorService.openFile` routes an `imageExtension()` path
  (`shared/asset-name.ts`) to a `makeImageDoc` with **no `readVaultFile`**;
  the URL is `resolveVaultImageUrl(null, relativePath)` (already resolves
  a vault-root-relative path). No new IPC — `drey-asset://` serves any
  file under the vault.
- **Inline sizing** — `parseImageEmbed` (`shared/image-embed.ts`) reads a
  trailing `|W` / `|WxH` off the Markdown image's alt text; the drag
  handle rewrites that span (`setEmbedWidth`, **width only** — the height
  is dropped, aspect ratio comes from the image). The note text stays the
  single source of truth; the resize is one ordinary `changes`
  transaction, so `Ctrl+Z` / `Ctrl+S` work on it.

### Alternatives considered

- **Render images through `MarkdownSurface` / `Editor`.** It is a
  CodeMirror host; zoom/pan/fullscreen are unrelated and every `Editor`
  effect assumes a live CM view.
- **"Swap a component when the active path looks like an image" without a
  tab-model change.** `openDocs` / `activePath` back the tab bar, the
  open-windows panel, dedupe, `closeTabsUnder`, the Files-tree active
  highlight and the save commands — an image viewer needs a real tab, so
  it needs to be an `OpenDoc`.
- **Native `element.requestFullscreen()` for the tab's fullscreen.**
  Rejected — reusing the lightbox is one viewer with one set of controls.
- **A z-index token scale.** Deferred; only the new ceiling needs a name.

## Consequences

- Two `ImageViewer` instances can be live at once (an image tab with the
  lightbox open over it); the tab's key handler early-returns while the
  lightbox is open, and wheel events only reach the hovered element.
- Switching between a text tab and an image tab destroys/recreates
  `Editor` (and its CM view). Undo already resets on any tab switch
  (ADR-0003), so this is consistent; the cost is one CM init per switch.
- Image tabs are **not** persisted across restart (nothing is — ADR-0003).
- v1 caveats: Markdown `![]()` only (HTML `<img>` keeps its sanitizer
  `width`/`height` but gets no lens/handle — a follow-up); an SVG whose
  `naturalWidth` is 0 shows `—` for dimensions and `fit()` returns 1; a
  very large image is transformed as one element with no tiling.
