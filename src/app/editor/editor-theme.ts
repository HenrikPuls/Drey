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
  // Heading sizes are `em`, relative to the `.cm-scroller` base below, so
  // the editor content zoom (Ctrl +/-/0) scales them along with body text.
  // The `em` values are the old fixed px over the 14.5px base.
  {
    tag: t.heading1,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '500',
    color: 'var(--text-heading)',
    fontSize: '2.14em',
    lineHeight: '1.25',
    letterSpacing: '-0.01em',
  },
  {
    tag: t.heading2,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '500',
    color: '#e6e2db',
    fontSize: '1.31em',
    lineHeight: '1.3',
  },
  {
    tag: t.heading3,
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '500',
    color: 'var(--text-heading)',
    fontSize: '1.14em',
    lineHeight: '1.35',
  },
  {
    tag: [t.heading4, t.heading5, t.heading6],
    fontFamily: 'var(--drey-heading-font)',
    fontWeight: '500',
    color: 'var(--text-3)',
    fontSize: '1em',
  },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--text-6)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
  { tag: t.quote, fontFamily: 'var(--font-serif)', fontStyle: 'italic', color: '#a9a49c' },
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
 * Chrome + layout for the CodeMirror surface, reading the app's design
 * tokens (`src/styles.css`).
 */
export const dreyEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--text-2)',
      backgroundColor: 'var(--bg-main)',
    },
    // `--drey-editor-scale` is set on the editor host by `Editor` from the
    // persisted `editor.fontScale` (Ctrl +/-/0). It is the ONE size the
    // whole surface keys off -- headings and code are `em` from here, and
    // the fallback `1` keeps every other CodeMirror surface (the entry
    // drawer) at its normal size.
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-sans)',
      fontSize: 'calc(14.5px * var(--drey-editor-scale, 1))',
      lineHeight: '1.72',
    },
    // Fluid width: the prose column fills the pane, leaving only a small
    // symmetric side margin (no readable-measure cap).
    '.cm-content': {
      padding: '40px 24px 56px',
      caretColor: 'var(--accent)',
    },
    // `basicSetup` mounts line-number + fold gutters; this editor is prose.
    '.cm-gutters': { display: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(201, 100, 66, 0.28)',
    },
    // The document look wants no active-line wash.
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  },
  { dark: true },
);

/** Theme + highlight as one extension, added after `basicSetup` so it wins. */
export const dreyEditorLook = [dreyEditorTheme, syntaxHighlighting(dreyHighlightStyle)];
