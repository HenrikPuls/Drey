# 25. Mermaid diagrams in Live Preview (lazy `mermaid`, Live-Preview-only)

## Status

Accepted. Extends [ADR-0009](0009-live-preview-decorations.md) (Live
Preview via CodeMirror decorations) with one more block widget.

## Context

The project owner asked for ` ```mermaid ` fenced blocks to render as
diagrams "in all editors". `mermaid` was not a dependency (it appeared
only in `docs/*.md`, rendered by VS Code / GitHub).

"All editors" needs no special work: the full-page editor, the "Add
entry" drawer and the assistant composer all mount the one shared
`MarkdownSurface`, so a CodeMirror extension covers them at once -- the
same reason `CLAUDE.md` calls CM's extension model the plugin system.

Two real decisions:

- **Where the diagram lives.** Rendered in place like tables/images
  (a block widget that the cursor entering the fence reveals), or a
  separate preview pane. In place matches the existing Live Preview model
  and ADR-0009.
- **How to carry `mermaid`.** It is a large renderer (d3, dagre,
  cytoscape, katex, dayjs, …) -- eagerly bundling it would inflate the
  initial renderer load for a feature most notes never use.

## Decision

**A `MermaidWidget` block decoration in `live-preview/`, rendered from a
dynamic `import('mermaid')` on first use; Live-Preview-only.**

- `live-preview/fenced-code.ts` -- pure `fenceLang(info)` (first
  whitespace token, lower-cased), unit-tested on its own.
- `block-render.ts` grows a `FencedCode` branch: when `fenceLang` of the
  `CodeInfo` child is `mermaid`, the fence is past the frontmatter, and
  the selection doesn't touch it, the whole block (line-aligned) is
  replaced by `Decoration.replace({ widget: new MermaidWidget(body),
  block: true })`. The cursor entering the fence drops the widget and the
  raw ` ```mermaid ` source is back -- the same reveal rule tables and
  images use. `conceal.ts` bails on a non-revealed `mermaid` fence so its
  line-background / fence-hiding decorations don't fight the block
  replacement.
- `MermaidWidget` (`widgets.ts`):
  - `loadMermaid()` -- `import('mermaid')` once, then `initialize` once
    with `startOnLoad: false`, `securityLevel: 'strict'` (output through
    DOMPurify, no click binding), `theme: 'dark'` + `darkMode: true`, the
    app sans `fontFamily`, and `suppressErrorRendering: true` so a parse
    error is thrown rather than drawn as mermaid's "bomb" diagram.
  - `toDOM()` returns immediately with a "rendering diagram…" note and the
    shared hover **View source** button (`</>`, in the `.lp-tools` corner
    cluster — see ADR-0009's Later change); `render()` runs async and swaps
    in either a `.lp-mermaid-svg` holder (`mermaid.render(id, src)` output)
    or a compact `.lp-mermaid-error` `<pre>`, inserting it *before*
    `.lp-tools`. It never throws into the editor, checks `wrap.isConnected`
    before touching the DOM (the widget may have been replaced while
    mermaid worked), and removes mermaid's stray offscreen measuring node
    on error.
  - `.lp-mermaid` is added to `block-render.ts`'s `clickToReveal` targets
    and to `theme.ts` (dark card, horizontal scroll for wide diagrams,
    error box styling).
- `mermaid` goes in `dependencies`; `ng build` code-splits it into lazy
  chunks (initial bundle unchanged). Its CJS-only transitive deps
  (`dayjs`, `cytoscape-*`, `@braintree/sanitize-url`, `fastdom`) are
  listed in `angular.json` `allowedCommonJsDependencies` to keep the
  build warning-free. No main-process / packaging impact.
- There is **no CSP** in the app (no `<meta>`, no `onHeadersReceived`), so
  mermaid's inline `<style>` injection is fine; `securityLevel: 'strict'`
  is kept as defence for note-authored diagram text regardless.

### Alternatives considered

- **Eager `import`.** Simpler, but ~1 MB+ of renderer bundle for a
  rarely-used feature; the lazy import costs only a one-off "rendering…"
  flash on the first diagram of a session.
- **Render in Source mode too.** Live Preview is where widgets belong
  (ADR-0009); Source mode stays the raw-text escape hatch. mermaid's own
  syntax highlighting via the nested-language path is a possible later
  nicety, not required.
- **A dedicated preview pane.** Rejected -- inconsistent with the in-place
  editing model, and a second surface to keep in sync.

## Consequences

- First lazy-loaded renderer dependency. The pattern (dynamic `import` +
  placeholder + `isConnected` guard) is there for any future heavy
  in-editor renderer.
- A malformed diagram is contained to its own error box; the editor and
  the rest of the document are unaffected.
- `node_modules` grows notably (mermaid + d3 + dagre + …); shipped only in
  lazy chunks, and `licenses.json` picks up the new transitive licenses.
- Diagrams render only in Live Preview; Source mode shows the raw fence.

## Later change — a zoom lens

With `LivePreviewConfig.onZoomDiagram` set (the full-page editor wires it),
`MermaidWidget` shows a hover lens button — same recipe as `ImageWidget`'s
`.lp-lens`. It serialises the rendered SVG to a `data:image/svg+xml` URL
(`svgToDataUrl` promotes the `viewBox` to explicit `width`/`height` so the
`<img>` reports a real natural size) and opens it in the shared image
lightbox (ADR-0026) — no lightbox change needed, the data URL loads in its
`<img>`. Text in the diagram is not selectable in the zoom view; that is
the accepted cost of reusing the raster viewer over generalising it.

## Later change — label font sync (non-sans editor typeface)

`loadMermaid()`'s config sets `fontFamily: 'var(--font-sans, …)'`. mermaid
resolves that against its own offscreen measuring node, where `--font-sans`
is the app default (sans) — not `.cm-content`, where Settings → Appearance
(ADR-0020) overrides `--font-sans` with the chosen editor typeface. So with
a **serif or monospace** editor font mermaid measured each label in a
narrower sans, sized the `<foreignObject>` and the node `<rect>` to that,
then painted the wider real font: every label spilled past its box (a few px
for serif, ~40% for monospace). The zoom lens was unaffected — the
serialised SVG has no `--font-sans` context, so it falls back to sans for
both measure and paint.

Fix: `MermaidWidget.render()` calls `syncMermaidFont()` first, which reads
the *resolved* `font-family` off `.cm-scroller` and, when it changed,
re-runs `mermaid.initialize({ ...MERMAID_BASE_CONFIG, fontFamily })` (the
whole base config is re-sent because `initialize` replaces rather than
merges). Measurement and paint then use the same concrete stack.
Regression-covered by `e2e/mermaid.spec.ts` ("non-sans editor typeface"),
which seeds `app-config.json` via the `appConfig` fixture option.

## Later change — `</>` view-source button + corner cluster (Req-1)

The hover pencil became a `</>` **View source** button and now shares a
`.lp-tools` flex cluster with the zoom lens, so the two no longer stack in
the same corner (they did on a mermaid diagram — the only widget with
both). A revealed fence's raw lines also gain the `.lp-reveal` rounded
container. Details in [ADR-0009](0009-live-preview-decorations.md)'s
"Later change" section.

## Later change — diagrams also render in the PDF export (milestone 32)

The export window gets its own mermaid: main inlines the UMD bundle
(`mermaid/dist/mermaid.min.js`, light paper theme, not this ADR's dark
editor config) into the generated page and a bootstrap renders each
` ```mermaid ` fence to an SVG figure before `printToPDF`, with the code
block as the bounded fallback. Details in
[ADR-0052](0052-pdf-embeds-and-viewer.md)'s "Later change" section.
