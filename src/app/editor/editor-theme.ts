import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Typography for the **source** editor. The rendered "preview" view is a
 * separate markdown-it render (see `Editor.renderedHtml`) styled by
 * `editor.css`; this styles the CodeMirror surface so editing the raw
 * Markdown still reads well -- headings large (with the `#` visible), code
 * monospace, links in the accent colour, syntax marks dim. The heading
 * typeface is `--drey-heading-font`, which `Editor` sets on its host from
 * the Settings -> Appearance choice (default: the body sans font).
 *
 * Values are migrated from the old `.doc` rules; `oneDark` is dropped.
 * `basicSetup` still installs `defaultHighlightStyle` as a `{ fallback: true }`
 * layer, which only fills tags this style does not define.
 */
export const dreyHighlightStyle = HighlightStyle.define([
  // Heading COLORS only: the typography (per-level size/weight, one source
  // of truth) lives in `headingTypographyStyle` below, which survives
  // theme swaps — a published @uiw theme styles all heading levels
  // identically or not at all, which made h1-h6 indistinguishable (the
  // beta feedback). Sizes are `em`, relative to the `.cm-scroller` base in
  // `editorStructure`, so the editor content zoom (Ctrl +/-/0) scales
  // them along with body text.
  { tag: t.heading1, color: 'var(--text-heading)' },
  { tag: t.heading2, color: 'var(--text-primary)' },
  { tag: t.heading3, color: 'var(--text-heading)' },
  { tag: t.heading4, color: 'var(--text-heading)' },
  { tag: t.heading5, color: 'var(--text-3)' },
  { tag: t.heading6, color: 'var(--text-3)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--text-6)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
  { tag: t.quote, fontFamily: 'var(--font-serif)', fontStyle: 'italic', color: 'var(--text-3)' },
  { tag: t.list, color: 'var(--text-5)' },
  // The raw syntax marks (`#`, `**`, `>`, `---`, `` ` ``): dim but legible.
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-faint)' },
  // Fenced-code info string (` ```ts `).
  { tag: t.meta, color: 'var(--text-6)' },

  // Tokens inside fenced code (nested parsing via `codeLanguages`,
  // ADR-0009). This set must stay COMPLETE for the tags the common
  // languages emit: any tag it misses falls through to `basicSetup`'s
  // `defaultHighlightStyle` fallback, whose light-background colors
  // (#170-greens, #a11-reds) are unreadable on the dark surface -- HTML/
  // XML/CSS fences looked "uncolored" until tagName & friends were added.
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.self, t.bool, t.atom, t.null, t.tagName],
    color: 'var(--accent-hover)',
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.inserted, t.attributeValue],
    color: '#8fae7d',
  },
  { tag: [t.number, t.integer, t.float, t.unit, t.color], color: '#c99a6a' },
  {
    tag: [
      t.typeName,
      t.className,
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.variableName),
      t.labelName,
      t.macroName,
      t.namespace,
    ],
    color: 'var(--text-heading)',
  },
  {
    tag: [t.variableName, t.propertyName, t.attributeName, t.operator, t.punctuation],
    color: 'var(--text-2)',
  },
  { tag: [t.angleBracket, t.separator, t.derefOperator, t.bracket], color: 'var(--text-5)' },
  { tag: [t.deleted, t.invalid], color: '#e0776d' },
]);

/**
 * Per-level heading typography for BOTH source mode and Live Preview —
 * deliberately its own HighlightStyle, mounted OUTSIDE the theme
 * compartment with `Prec.high` (`markdown-surface.ts`): a published
 * `@uiw` theme styles all heading levels identically (bold + one colour)
 * or not at all, which flattened h1-h6 to body text. Declaring
 * typography ONLY -- no `color` -- keeps the cascade per-property, so the
 * active theme's heading colours still apply on top. Sizes are `em` off
 * the `.cm-scroller` base (`editorStructure`), and every level keys off
 * the same `--drey-heading-font` as the Drey theme always did.
 *
 * The steps make all six levels distinguishable: size drops per level,
 * weight steps down after h3, and h6 adds tracking to read as a label.
 */
export const headingTypographyStyle = HighlightStyle.define([
  {
    tag: t.heading1,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '500',
    fontSize: '2.14em',
    lineHeight: '1.25',
    letterSpacing: '-0.01em',
  },
  {
    tag: t.heading2,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '500',
    fontSize: '1.31em',
    lineHeight: '1.3',
  },
  {
    tag: t.heading3,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '500',
    fontSize: '1.14em',
    lineHeight: '1.35',
  },
  {
    tag: t.heading4,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '600',
    fontSize: '1em',
  },
  {
    tag: t.heading5,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '600',
    fontSize: '0.95em',
  },
  {
    tag: t.heading6,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '600',
    fontSize: '0.86em',
    letterSpacing: '0.04em',
  },
]);

/**
 * Layout skeleton for the CodeMirror surface -- the rules that must hold
 * whatever colour theme is active (ADR-0035: the palette lives in a
 * swappable compartment; a published `@uiw` theme sets colours only and
 * never `display` / `height` / `overflow`). Kept OUT of the compartment and
 * mounted always-on so a published theme can't drop it. Its rules mostly
 * don't collide with a `@uiw` theme (which only sets colours), so ordering
 * is moot; where one *does* collide -- the `.cm-scroller` typeface -- the
 * selector is made specificity-heavier on purpose, because at equal
 * specificity the compartment's style module wins regardless of declaration
 * order (the same quirk `Prec.high` `gutterTheme` / `compactTheme` in
 * `markdown-surface.ts` work around).
 */
export const editorStructure = EditorView.theme({
  '&': { height: '100%' },
  // `--drey-editor-scale` is set on the editor host by `Editor` from the
  // persisted `editor.fontScale` (Ctrl +/-/0). It is the ONE size the whole
  // surface keys off -- headings and code are `em` from here, and the
  // fallback `1` keeps every other CodeMirror surface (the entry drawer) at
  // its normal size.
  '.cm-scroller': {
    overflow: 'auto',
    fontSize: 'calc(14.5px * var(--drey-editor-scale, 1))',
    lineHeight: '1.72',
  },
  // The editor typeface (Settings -> Appearance, via `--font-sans` on the
  // `Editor` host). A published `@uiw` theme emits its own
  // `&.cm-editor .cm-scroller { font-family: <mono> }` (see `createTheme`),
  // and its style module -- living in the theme compartment, which sits
  // *earlier* in the extension list -- wins the cascade at equal specificity
  // (the same ordering quirk `compactTheme` works around with `Prec.high`).
  // So this selector is deliberately one class heavier (`.cm-editor` twice)
  // to outrank it outright -- a theme is picked for its colours, not to turn
  // prose into code.
  '&.cm-editor.cm-editor .cm-scroller': { fontFamily: 'var(--font-sans)' },
  // Full-width, left-aligned text column: no centred max-width -- the editor
  // uses the whole area, only side padding keeps the text off the edges.
  // (Was a 680px centred reading column; the project owner asked for the
  // full width -- see DESIGN.md.)
  '.cm-content': { padding: '26px 32px 32px' },
  // `basicSetup` mounts a line-number gutter and a fold gutter. The fold
  // column is always live (Obsidian-style collapsible headings); the
  // line-number column follows the meta bar's "Lines" toggle -- hidden here,
  // re-shown by the `Prec.high` `gutterTheme` compartment
  // (`markdown-surface.ts`) when the toggle is on.
  '.cm-gutters': {
    display: 'flex',
    backgroundColor: 'transparent',
    borderRight: 'none',
  },
  // `!important` beats the CM base `.cm-gutter { display: flex !important }`
  // (`.cm-lineNumbers` carries `.cm-gutter`). `gutterTheme` re-shows it, also
  // `!important`, `Prec.high` so it wins the toggle-on cascade.
  '.cm-lineNumbers': { display: 'none !important' },
  // The fold chevron column. The `.cm-gutterElement` box gets the same
  // vertical metrics as the line-number element (`gutterTheme`) so the
  // marker sits on the heading's first visual row and never reintroduces
  // the milestone-19a gutter drift. 18px + 15px glyph: the default marker
  // is nearly invisible at inherited size.
  '.cm-foldGutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    width: '18px',
    padding: '0',
    lineHeight: 'calc(14.5px * 1.72 * var(--drey-editor-scale, 1))',
    fontSize: '15px',
  },
  // Obsidian-ish reveal: the `⌄` marker (CM's default `foldGutter` renders a
  // `<span>` only on foldable lines) is invisible until the gutter is
  // hovered, except a *folded* section (`title` "Unfold line") keeps a
  // visible accent chevron so it stays discoverable.
  '.cm-foldGutter span': {
    color: 'var(--gutter)',
    cursor: 'pointer',
    opacity: '0',
    transition: 'opacity 80ms ease',
    fontSize: '15px',
    lineHeight: 1,
  },
  '.cm-gutters:hover .cm-foldGutter span': { opacity: '1' },
  '.cm-foldGutter span[title="Unfold line"]': {
    opacity: '1',
    color: 'var(--accent)',
  },
  // The folded-content pill: CM's default is a light `#eee` chip, which
  // glares in the dark theme. Keep it a quiet "…" that still clicks to
  // unfold (the handler sits on the element, not the styling).
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    margin: '0 0 0 6px',
    padding: '0 4px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
});

/**
 * The **Drey** colour palette for the CodeMirror surface, reading the app's
 * design tokens (`src/styles.css`). Palette only -- the layout skeleton is
 * `editorStructure`. This is what the theme compartment swaps out for a
 * published theme.
 */
export const dreyEditorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text-2)',
      backgroundColor: 'var(--bg-main)',
    },
    // The caret is neutral text colour, decoupled from the highlight colour
    // (which can be any user hex): it must stay visible on every accent. The
    // drop cursor is drag chrome, not the caret -- it stays accent.
    '.cm-content': { caretColor: 'var(--text-primary)' },
    '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
    '.cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
    },
    // The Drey document look wants no active-line wash (a published theme
    // keeps its own, from `lineHighlight`).
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  },
  { dark: true },
);

/** Drey palette + highlight as one extension, added after `basicSetup` so it wins. */
export const dreyEditorLook = [dreyEditorTheme, syntaxHighlighting(dreyHighlightStyle)];
