import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { dreyEditorTheme } from '../editor-theme';

/**
 * The **Cyberpunk** editor look: the token-driven Drey surface (so the
 * editor follows `styles.css`'s `:root[data-theme='cyberpunk']` palette)
 * with its own highlight style -- neon pink, violet and cyan headings with
 * a soft glow, and a neon code palette. Colours only: per-level heading
 * typography stays in `headingTypographyStyle`, like for every theme.
 *
 * The neon values are fixed here rather than tokens because they are this
 * theme's signature and must not follow the user's highlight colour.
 */
const PINK = '#ff4fa8';
const VIOLET = '#b98cff';
const CYAN = '#4de8ff';
const GREEN = '#6dffb3';
const YELLOW = '#ffe066';

const glow = (hex: string): string => `0 0 12px ${hex}80`;

const cyberpunkHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, color: PINK, textShadow: glow(PINK) },
  { tag: t.heading2, color: VIOLET, textShadow: glow(VIOLET) },
  { tag: t.heading3, color: CYAN },
  { tag: t.heading4, color: PINK },
  { tag: t.heading5, color: VIOLET },
  { tag: t.heading6, color: 'var(--text-3)' },
  { tag: t.strong, fontWeight: '600', color: 'var(--text-heading)' },
  { tag: t.emphasis, fontStyle: 'italic', color: VIOLET },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: CYAN },
  { tag: t.url, color: 'var(--text-6)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em', color: GREEN },
  { tag: t.quote, fontFamily: 'var(--font-serif)', fontStyle: 'italic', color: 'var(--text-3)' },
  { tag: t.list, color: 'var(--text-2)' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-faint)' },
  { tag: t.meta, color: 'var(--text-6)' },

  // Tokens inside fenced code -- the set stays as complete as the Drey
  // one, so nothing falls through to the light-background fallback style.
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.self, t.bool, t.atom, t.null, t.tagName],
    color: PINK,
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.inserted, t.attributeValue],
    color: GREEN,
  },
  { tag: [t.number, t.integer, t.float, t.unit, t.color], color: YELLOW },
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
    color: CYAN,
  },
  { tag: [t.attributeName, t.propertyName], color: VIOLET },
  { tag: [t.variableName, t.operator, t.punctuation], color: 'var(--text-2)' },
  { tag: [t.angleBracket, t.separator, t.derefOperator, t.bracket], color: 'var(--text-5)' },
  { tag: [t.deleted, t.invalid], color: '#ff6b7a' },
]);

export const cyberpunkEditorLook: Extension = [
  dreyEditorTheme,
  syntaxHighlighting(cyberpunkHighlightStyle),
];
