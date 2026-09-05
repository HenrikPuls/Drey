# 4. Auto-switch editor mode and source↔rendered caret sync

## Status

Accepted — implemented in milestone 3 (editor) as an opt-in extension of
the source/rendered toggle.

## Context

Milestone 3 shipped the plain toggle model from `specs/roadmap.md`
("source/rendered view via tab switch (no live preview), click-to-edit"):
the rendered view is a `[innerHTML]` render of the buffer, and a click
anywhere on it switches the whole pane to CodeMirror.

That has two frictions for a read-heavy notes app:

- Every stray click while reading throws you into the source view.
- When you *do* want to edit, you land wherever CodeMirror's cursor last
  was, not where you were looking — so you hunt for the spot.

The user asked for a mode where the preview is the resting state: clicks
only position a caret, typing is what commits to editing, and saving drops
you back into the preview where you were. This needs a position mapping
between rendered-HTML caret and Markdown source offset, in both directions.

`specs/roadmap.md` explicitly defers "true Obsidian-style inline rendering"
to Future Scope. This is deliberately *not* that: there is still one
CodeMirror view, one markdown-it render, and a hard switch between them —
only the *interaction* around the switch changes, and only when the mode is
enabled.

### Options considered for the position mapping

1. **Block-line only** — use markdown-it's block `token.map` (source line
   numbers) to jump to the start of the clicked block. Trivial, robust,
   but the caret can never sit mid-sentence.
2. **Block-line + per-block character alignment** (chosen) — narrow to one
   block via `token.map`, then walk that block's rendered plain text
   against its slice of source, treating Markdown syntax as extra source
   characters between the visible ones.
3. **Full document character mapping** — a parser (or fork) that tracks
   source offsets through every inline token. Precise everywhere, but a
   large dependency / maintenance surface for a Phase-1 editor.

### Options considered for the preview caret itself

1. Draw a custom caret element and handle arrow keys manually.
2. **Make the preview `contenteditable="plaintext-only"` and cancel every
   edit** (chosen) — the browser then renders a real caret, handles
   click-positioning and caret navigation natively, and every mutation
   surfaces as a cancellable `beforeinput` we translate into a CodeMirror
   dispatch.

## Decision

**Opt-in, persisted, per machine.** `EditorService.autoSwitch` is a signal
backed by `localStorage` (`drey.editor`), read synchronously at
construction — same pattern as `LayoutService`. It is a workflow
preference, not document state, so it is *not* part of `OpenDoc`. Turning
it on forces the active tab into the rendered view (the mode's landing
state).

**One shared caret offset.** `OpenDoc.caretOffset` is a character offset
into `bufferContent`. CodeMirror pushes its selection head there on every
change/selection; the rendered view reads it to place its DOM caret and
writes it back from clicks/navigation. It never affects dirty state.

**Position mapping — option 2.** `src/app/editor/source-map.ts`:

- `renderWithSourceMap()` replaces the bare `md.render()` call. It stamps
  every rendered block element with a `cm-src-<n>` class (kept by Angular's
  sanitizer, unlike a `data-` attribute) and returns a parallel
  `spans[]` of `{ start, end }` source offsets, derived from block
  `token.map` (the `inline` token and closers are skipped so indices line
  up with real elements).
- `alignRenderedToSource(sourceSlice, renderedText)` builds a
  non-decreasing `r2s` map: for each rendered character, scan the source
  slice forward to its next occurrence. Every visible character also
  appears, in order, in the source — emphasis / heading / list / link
  syntax is just extra source characters — so this is exact for plain
  prose, headings and fenced code (identity), and off by a few characters
  only inside pathological nested inline markup or where a source entity
  (`&lt;`) renders as a character it doesn't literally contain.
- `sourceToRenderedOffset()` is the binary-search inverse;
  `blockIndexForSourceOffset()` picks the tightest containing block.

`src/app/editor/preview-caret.ts` holds the DOM-side glue
(`domPointToTextOffset` via `Range`, its inverse via a `TreeWalker`,
`blockIndexForNode`), kept separate so it is unit-testable against
hand-built fragments.

**Preview caret — option 2.** In auto-switch mode the `.doc` element gets
`contenteditable="plaintext-only"`. `onPreviewBeforeInput` cancels the
event, maps `inputType` to an intent (`insertText`, Enter, Backspace,
Delete, paste), switches to source at the mapped offset and replays the
intent as a CodeMirror transaction so the triggering keystroke is not
lost. Clicks and caret-navigation keys only re-read the caret. Ctrl+S from
source, when the mode is on, switches back to rendered.

Both directions of the switch defer the DOM work by one macrotask
(`deferToDom` = `setTimeout(0)`): the `@if`-swapped view only exists after
the change-detection pass the `setViewMode` call triggers, and focusing or
scrolling a still-`display:none` editor is a no-op. So `enterSourceForEdit`
applies the CM change synchronously (the keystroke) but re-asserts
`view.focus()` + selection after the pass, and the rendered-view `effect`
places the preview caret after it.

When `autoSwitch` is off, the rendered view is a read-only preview: a
click on it does nothing (it never switches to source anymore), and none
of the mapping runs.

## Consequences

- New renderer-only modules `source-map.ts` and `preview-caret.ts` (pure /
  DOM-pure, both unit-tested). `Editor` grew the beforeinput/caret glue;
  `EditorService` grew `autoSwitch`, `caretOffset`, `setCaretOffset`,
  `setAutoSwitch`.
- The rendered view is now `contenteditable` **only** while the mode is on.
  It is never a real editing surface — all edits are intercepted — but
  screen readers will announce it as editable; acceptable for an opt-in
  power-user mode.
- The mapping is best-effort by design. Worst realistic case is a caret a
  few characters off inside dense inline markup; it never throws and never
  corrupts text (a bad offset is just a slightly wrong cursor position).
  Indented (four-space) code blocks aren't stamped by markdown-it's
  default renderer, so a caret there falls back to the nearest mapped
  ancestor.
- CodeMirror's per-tab undo history still doesn't survive a tab switch
  (ADR-0003); auto-switch doesn't change that.
- If this mapping proves too coarse in use, option 3 (offset-tracking
  parser) is the escalation, isolated behind the `source-map.ts` API.
