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
    shared hover `✎` (reveal source); `render()` runs async and swaps in
    either a `.lp-mermaid-svg` holder (`mermaid.render(id, src)` output)
    or a compact `.lp-mermaid-error` `<pre>`. It never throws into the
    editor, checks `wrap.isConnected` before touching the DOM (the widget
    may have been replaced while mermaid worked), and removes mermaid's
    stray offscreen measuring node on error.
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
