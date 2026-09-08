# 9. Live Preview via CodeMirror decorations

## Status

Accepted — supersedes the preview half of
[ADR-0008](0008-editor-mode-menu-and-rendered-preview.md) (the `⋯` mode
menu and the shared source typography from that ADR stand unchanged).

## Context

ADR-0008 shipped a read-only markdown-it render as the everyday view: full
fidelity (tables, footnotes, highlighted code), but editing always meant
dropping out of the render into source mode. The project owner found that
indirection unacceptable in daily use and asked for true Obsidian-/Typora-
style Live Preview: the cursor sits in the rendered document, syntax
markers appear only around the cursor, formatting updates inline while
typing — no split view, no mode toggle needed for editing.

ADR-0008 had rejected exactly this because the milestone-M3 prototype
stalled on two constructs: syntax-highlighted code and tables. Both
blockers turned out to have narrower solutions than "abandon decorations":

- **Code**: no widget needed at all. `@codemirror/lang-markdown` accepts
  `codeLanguages`; with `@codemirror/language-data` the fence's info string
  (` ```cpp `) mounts a real nested parser and the existing
  `HighlightStyle` colors the tokens — the code stays plain, editable text.
- **Tables**: the only construct that genuinely needs a block-replacing
  widget, and block decorations merely require a `StateField` instead of a
  `ViewPlugin` — an isolated cost, not a rewrite of the whole layer.

## Decision

`EditorViewMode` becomes `'live' | 'source'` (a stored `'preview'` default
migrates to `'live'`). One always-mounted CodeMirror view runs both modes;
a `Compartment` swaps the Live Preview extensions in and out, so undo
history and selection survive the switch. The `⋯` menu offers **Live
Preview** (default) and **Source** — source stays as the escape hatch that
shows a note exactly as written.

The Live Preview layer lives in `src/app/editor/live-preview/`:

- **`conceal.ts` — a `ViewPlugin` over the visible ranges.** Walks the
  syntax tree and `Decoration.replace`s syntax markers: heading `#`s,
  emphasis/strikethrough marks, inline-code backticks, link punctuation +
  URL, quote `>`s, code fences. Small widgets stand in for markers that
  read better rendered: `•` bullets, real `<input type="checkbox">` task
  boxes (clicking one edits the `[ ]`/`[x]` text), `<hr>` rules. Line
  classes style quote bars, code-block backgrounds and dimmed frontmatter.
- **Reveal-on-touch instead of atomic ranges.** The document text is never
  modified — decorations vanish when the selection touches their construct:
  inline formatting reveals per *node*, line markers (headings, bullets,
  quotes, rules) per *line*, a fenced block reveals its fences while the
  selection is anywhere inside it. Because moving the cursor toward a
  concealed range reveals it before the cursor can enter, arrow-key
  navigation through rendered spans just works and no `atomicRanges`
  machinery is needed.
- **`block-render.ts` — a `StateField` for what a `ViewPlugin` may not
  provide.** GFM tables become `Decoration.replace({block: true})` widgets
  rendered by a minimal markdown-it instance (`html: false`, one block at a
  time — the same library the old preview used, so cell fidelity is kept);
  a click on the rendered table moves the cursor into it, which reveals the
  raw block. Images (`![alt](path)`) become `<img>` widgets — `src` resolved
  through the existing `resolveVaultImageUrl` / `drey-asset://` path, with
  a text placeholder when resolution fails or the file 404s. Tall/block
  widgets must be known before vertical layout, which is exactly why these
  two live in a field (whole-document walk per doc/selection change) rather
  than the viewport-scoped plugin.
- **`theme.ts` — an `EditorView.theme` for the `lp-*` classes**, not
  component CSS: CodeMirror creates the widget DOM, so Angular's emulated
  encapsulation would never match it.
- **Embedded HTML renders as sanitized region widgets** (Markdown allows
  raw HTML). CommonMark ends an HTML block at the first blank line, so one
  logical element (`<details>` + Markdown body + `</details>`) arrives as
  several `HTMLBlock` nodes; a block that leaves tags open
  (`htmlTagBalance > 0`) absorbs the following blocks — Markdown between
  included, stitched by a markdown-it instance with `html: true` — until
  the tags balance. The result runs through `sanitize-html.ts` before it
  touches the DOM: allowlisted tags/attributes, `on*` handlers and
  `javascript:`/`url(...)` stripped, `<img src>` routed through
  `resolveVaultImageUrl`. A vault file is normally the user's own, but it
  can arrive via OneDrive/import, and the renderer sits next to a
  privileged bridge — so no unsanitized `innerHTML`, ever. Inline HTML
  *within* a paragraph stays raw text for now. The HTML *tag autocomplete*
  that `lang-markdown` installs by default (a completion popup on `<`) is
  switched off (`completeHTMLTags: false`) — noise in a prose editor.
- **Widget content stays interactive; editing goes through a hover `✎`.**
  Table and HTML widgets keep their events (`ignoreEvent`): a `<details>`
  summary toggles, table text is selectable. The Obsidian-style `✎` button
  in the widget's corner is the one element whose click CodeMirror handles
  — it drops the cursor into the block, revealing the source.
- **Concealed code blocks show their language as a badge** on the block's
  right (the fence's info string via a `data-lang` line attribute +
  `::after`); the badge disappears while the fence is revealed. The token
  palette in `editor-theme.ts` must stay complete for common languages:
  any tag it misses falls back to `defaultHighlightStyle`, whose
  light-background colors are unreadable on the dark surface (this bit
  HTML/XML/CSS fences until `tagName`/`attributeValue` etc. were added).
- **One shared `MarkdownSurface` component**
  (`src/app/editor/markdown-surface/`) owns the CodeMirror view, the
  Markdown/`codeLanguages` setup, `#tag` autocomplete and the mode
  compartment. The full-page `Editor` and the bottom capture input are the
  same component (the input in `compact` mode: Enter submits, Shift+Enter
  breaks the line, slim theme), so Live Preview behaves identically in
  both places by construction.
- **Fenced-code highlighting via nested parsing** (both modes):
  `markdown({ codeLanguages: languages })` with `@codemirror/language-data`;
  parsers lazy-load as separate bundles chunks (C# via `legacy-modes`'
  clike). Token colors for dark surfaces were added to `dreyHighlightStyle`
  so `basicSetup`'s light-background `defaultHighlightStyle` fallback never
  applies.

- **Frontmatter folds behind a pill** (`src/app/editor/frontmatter-fold.ts`,
  a sibling of the Live Preview layer, **not** part of it). A note opens as
  prose: the leading YAML is replaced by a `Decoration.replace({ block: true })`
  pill — `▸ Frontmatter · N fields` — clicking which expands it to dim,
  editable raw YAML with a `⌄` chevron to fold it back. It lives *outside*
  the mode `Compartment` (mounted directly in `MarkdownSurface`, gated by a
  `foldFrontmatter` input only the full-page editor sets) so it applies in
  source mode too — where no other decoration runs — and so the fold state
  survives a Live Preview ⇄ source switch. State is one `StateField<boolean>`
  per `EditorView`, flipped by a `setFrontmatterExpanded` effect from the
  pill/chevron; `MarkdownSurface` mirrors it into a read-only signal, and the
  full-page `Editor` remembers it per document path across tab switches (the
  one reused view can't hold per-tab state itself). `conceal.ts` is
  unchanged — its `.lp-frontmatter` dimming and its "never conceal inside the
  header" guard still run; when the block is folded those line decorations
  simply fall under the pill widget and never render.

The markdown-it full-document preview, its `[innerHTML]` binding,
`bypassSecurityTrustHtml`, click-to-edit `data-line` mapping, highlight.js
and the task-lists/footnote plugins are removed. markdown-it itself stays
(table widget); `highlight.js`, `markdown-it-task-lists`,
`markdown-it-footnote` and the ambient `.d.ts` are dropped,
`allowedCommonJsDependencies` is empty again.

## Consequences

- Editing is direct: the cursor lives in the rendered document; no
  read-only view, no click-through to a different mode. "Editor live
  preview" moves out of `specs/roadmap.md`'s Future Scope.
- **Footnotes degrade to plain text** in Live Preview: `@lezer/markdown`
  has no footnote extension, and markdown-it no longer renders the
  document. Accepted for Phase 1 (rare in a note vault); a custom Lezer
  `MarkdownExtension` is the follow-up if it starts to matter.
- **Frontmatter folds behind a pill by default**, in both modes, expandable
  to dim editable YAML (see the Decision list). It stays inert for every
  other decoration. A structured Obsidian-style properties *editor* (typed
  fields, not raw YAML) would still be a separate decision.
- Reveal granularity is per node/line, not per character; revealing a
  construct reflows its line (markers gain width). This is inherent to the
  approach and matches Obsidian's behavior.
- The table `StateField` re-walks the whole tree on every doc/selection
  change, and `ensureSyntaxTree` runs with a small time budget — fine at
  note sizes; a very large document would parse the tail lazily and render
  far-away tables a beat late.
- Reference-style links (`[text][ref]`) and link titles keep their raw
  markup (only inline `[text](url)` conceals); `Ctrl`-click to open a
  concealed link target is not implemented yet.
- Inline HTML inside a paragraph (`text <b>bold</b> text`) does not render
  — only block-level HTML does. The sanitizer is deliberately conservative
  (no CSS functions, no forms/iframes/scripts); if a legitimate tag turns
  out to be missing, it is one allowlist entry away. The region merge uses
  a lexical tag balance, not a full HTML parse — a deliberately unclosed
  tag extends its region only to the last HTML block, never past it.
- Bundle: highlight.js (~150 kB) out; `@codemirror/language-data` adds a
  small registry up front and per-language lazy chunks on first use.

## Later change — interactive image widget (ADR-0026)

The Live Preview `ImageWidget` gained two hover affordances:

- **Lens button** — opens the image in the full-app viewer
  (`ImageLightboxService`). Handled by a direct DOM `click` listener on
  the button that `stopPropagation`s + `preventDefault`s, so CodeMirror
  never sees it; no `EditorView` reference and no `ignoreEvent` override
  needed for the lens. `LivePreviewConfig` carries an optional
  `onOpenImage(src)` that `MarkdownSurface` wires to the lightbox.
- **Resize handle** — a corner grip; dragging it rewrites the note's
  `![alt|W](url)` in place. Delegated `EditorView.domEventHandlers`
  `pointerdown` (in `livePreviewBlocks`) locates the `Image` node via
  `view.posAtDOM(span)` + the syntax tree, live-sizes `img.style.width`
  during the drag (no transaction), and dispatches **one** `changes`
  transaction on `pointerup` (no `selection`, so the widget swaps rather
  than the raw text revealing). `ImageWidget.ignoreEvent` returns `false`
  only for a `.lp-resize` target so that handler receives the event; the
  `touches()` reveal is suppressed because the `pointerdown` handler
  returns `true`.
