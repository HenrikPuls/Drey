# 8. Editor mode menu, shared typography, and the markdown-it rendered preview

## Status

Partially superseded by [ADR-0009](0009-live-preview-decorations.md): the
read-only markdown-it preview mode is replaced by an in-editor Live
Preview. The `⋯` mode menu and the shared source typography from this ADR
stand unchanged. Supersedes [ADR-0004](0004-auto-switch-editor-mode.md).
Implemented in the editor rework (milestones M1–M4 of the rework plan).

## Context

Milestone 3 shipped a hard **source ⇄ rendered** toggle: two segmented
buttons in the chrome, plus an opt-in "auto-switch" mode (ADR-0004) that
made the `[innerHTML]` render `contenteditable` and mapped its caret back
to a source offset.

The project owner found the toggle unpleasant to use and asked for an
Obsidian-style feel:

1. No top toggle buttons — a small `⋯` menu on the right of the chrome
   switches the view.
2. The everyday view should read like formatted prose, and editing should
   feel direct rather than like flipping a switch.

The first attempt at (2) was a true in-CodeMirror "Live Preview": a
`ViewPlugin` + `Decoration` layer that concealed the Markdown syntax for
everything except the line under the cursor. It worked for headings,
emphasis, lists, quotes, links, images, task boxes and rules, but tables,
footnotes and syntax-highlighted code are not practical to render as inline
CodeMirror decorations (block-replacing widgets force a `StateField` and
break in-place editing). The owner chose full fidelity over
edit-in-place, via an existing rendering library.

## Decision

### One `EditorViewMode`, two modes, a `⋯` menu

`EditorViewMode = 'source' | 'preview'` (renamed from `'source' | 'rendered'`;
the value no longer means "an HTML render is showing"). It stays a per-tab
field on `OpenDoc`. The last mode chosen via the menu is persisted to
`localStorage` (`drey.editor` → `{ defaultMode }`) and is the landing mode
for newly opened notes — Preview out of the box.

The chrome's segmented Source/Rendered buttons and the "Auto switch" button
are removed. A single `⋯` icon button opens a small menu (the sidebar
context-menu pattern: fixed backdrop + `.ctx-menu`) with **Preview** /
**Source** radio items, a check on the active one.

### `source` — CodeMirror with shared prose typography

The one `EditorView` (ADR-0003) is always mounted; it is `display:none` in
preview so its undo history and selection survive the switch. `oneDark` is
replaced by `dreyEditorLook` (`src/app/editor/editor-theme.ts`): an
`EditorView.theme` reading the app's design tokens plus a `HighlightStyle`
that styles the Markdown language's highlight tags — headings render large
and serif with the `#` visible and dim, code is monospace, links are the
accent colour. So the raw Markdown still reads well while editing.

### `preview` — a markdown-it render

`src/app/editor/editor.ts` builds one configured `MarkdownIt` instance
(`html: false`):

- **plugins**: `markdown-it-task-lists` (checkbox `<input>`s),
  `markdown-it-footnote`. GFM tables and fenced code are core.
- **syntax highlighting**: `highlight.js/lib/core` with a curated ~19
  languages registered explicitly (not the ~190-language bundle); the
  `highlight` option wraps output in `<pre class="hljs">`.
- **image `src`**: a renderer-rule override runs the URL through
  `resolveVaultImageUrl` (`src/app/editor/vault-image.ts`) →
  `http(s):`/`data:` pass through, a vault-relative path becomes
  `drey-asset://asset/<path>`, anything else / an escape attempt renders as
  the alt text. `drey-asset://` is a privileged scheme handled in
  `electron/main.ts`, served from inside the active vault via
  `VaultManager.resolveAssetPath` (same escape guard as the IPC read path).
- **click-to-edit**: a core rule stamps every top-level block with
  `data-line` (from markdown-it's `token.map`, 0-based in the
  frontmatter-stripped text). A click in the render finds the nearest
  `[data-line]`, switches to source, and drops the CM caret at that line
  (`+ lineShift` for the stripped frontmatter). Line granularity only —
  much smaller than ADR-0004's per-character `source-map.ts`.

The rendered HTML is bound with
`DomSanitizer.bypassSecurityTrustHtml`: markdown-it already escapes raw
HTML (`html: false`) and the content is the user's own local vault file,
but Angular's sanitizer would otherwise strip the task-list `<input>` and
the footnote markup.

### Auto-switch (ADR-0004) is removed

`OpenDoc.caretOffset`, `setCaretOffset`, `autoSwitch`, `setAutoSwitch`,
`src/app/editor/source-map.ts` and `src/app/editor/preview-caret.ts` are
deleted. `loadActiveDoc` reads `view.state.selection` directly.

## Consequences

- New: `editor-theme.ts`, `markdown-frontmatter.ts` (shared
  `stripFrontmatter` + `frontmatterEnd`), `vault-image.ts`. Deps added
  back: `markdown-it`, `markdown-it-task-lists`, `markdown-it-footnote`,
  `highlight.js` (`@codemirror/theme-one-dark` dropped). A one-line ambient
  `declare module` for `markdown-it-task-lists` (no `@types`).
- The preview is **read-only** — no `contenteditable`, no caret mapping. A
  click always drops to source; you cannot type "into" the render. This is
  the deliberate trade for rendering tables / footnotes / highlighted code
  correctly with a maintained library instead of hand-rolled decorations.
- Click-to-edit lands at the **start of the clicked block's line**, not the
  exact character — acceptable at Phase-1 scope; the per-character mapping
  from ADR-0004 is gone.
- True Obsidian-style inline "Live Preview" remains under **Future Scope**
  in `specs/roadmap.md` — this ADR does not deliver it, and the CodeMirror
  decoration prototype from milestone M3 was reverted.
- CodeMirror's per-tab undo history still does not survive a *tab* switch
  (ADR-0003); it does survive the mode switch (one mounted view).
- `highlight.js` core + ~19 languages adds ~100–150 kB raw to the renderer
  bundle; fine for a local Electron app. `markdown-it-task-lists` is
  CommonJS — listed in `allowedCommonJsDependencies`.
