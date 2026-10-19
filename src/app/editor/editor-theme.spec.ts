import { describe, expect, it } from 'vitest';
import { HighlightStyle, type TagStyle } from '@codemirror/language';
import { tags as t, type Tag } from '@lezer/highlight';
import { dreyFallbackStyle, dreyHighlightStyle } from './editor-theme';

/**
 * The coverage guard (T-0051): a tag the style leaves open falls through
 * to whatever a surface's fallback holds — on a dark surface that reads
 * as "not colored" at best. This pins the mandatory set: every tag the
 * common languages (js/ts/json/html/css/python, plus the Markdown
 * surface itself) emit must resolve to a class.
 */

/** The tags the common grammars emit, grouped by language family. */
const MANDATORY: ReadonlyArray<readonly [string, readonly Tag[]]> = [
  [
    'js/ts',
    [
      t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.modifier, t.self,
      t.bool, t.null, t.atom, t.operator, t.typeOperator, t.punctuation, t.bracket,
      t.separator, t.comment, t.variableName, t.definition(t.variableName), t.function(t.variableName),
      t.typeName, t.className, t.namespace, t.labelName,
    ],
  ],
  [
    'literals',
    [t.string, t.special(t.string), t.escape, t.character, t.regexp, t.number, t.integer, t.float, t.literal],
  ],
  [
    'json / css',
    [t.propertyName, t.function(t.propertyName), t.definition(t.propertyName), t.unit, t.color, t.tagName, t.className],
  ],
  [
    'html',
    [t.attributeName, t.attributeValue, t.angleBracket, t.meta, t.documentMeta, t.processingInstruction],
  ],
  [
    'python',
    [t.number, t.string, t.escape, t.self, t.bool, t.null, t.operator, t.keyword, t.variableName, t.typeName, t.meta],
  ],
  [
    'markdown',
    [
      t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6, t.link, t.url,
      t.monospace, t.quote, t.list, t.contentSeparator, t.strong, t.emphasis, t.strikethrough,
    ],
  ],
  ['diff / errors', [t.inserted, t.deleted, t.invalid]],
];

/** The `name` family's generic parent — a bare identifier still reads as one. */
const NAME_TAG: readonly Tag[] = [t.name];

const uncoveredIn = (style: HighlightStyle): string[] => {
  const missing: string[] = [];
  for (const [group, tagList] of [...MANDATORY, ['names', NAME_TAG] as const]) {
    for (const tag of tagList) {
      if (style.style([tag]) === null) {
        missing.push(`${group}: ${String(tag)}`);
      }
    }
  }
  return missing;
};

describe('dreyHighlightStyle coverage (T-0051)', () => {
  it('styles every tag the common languages emit', () => {
    expect(uncoveredIn(dreyHighlightStyle)).toEqual([]);
  });

  it('styles escape, literal and name — the tags that used to fall through', () => {
    for (const tag of [t.escape, t.literal, t.name]) {
      expect(dreyHighlightStyle.style([tag])).not.toBeNull();
    }
  });
});

describe('dreyFallbackStyle coverage (T-0051)', () => {
  it('as the only style on a surface, still colors the mandatory set dark-readably', () => {
    expect(uncoveredIn(dreyFallbackStyle)).toEqual([]);
  });

  it('is declared with the fallback-appropriate basics in one style', () => {
    // The fallback replaces basicSetup's light defaultHighlightStyle —
    // without a comment, keyword and string rule it would be useless.
    const flat = dreyFallbackStyle.specs.flatMap((spec: TagStyle): readonly Tag[] =>
      spec.tag instanceof Array ? spec.tag : [spec.tag as Tag],
    );
    for (const tag of [t.comment, t.keyword, t.string, t.number, t.variableName]) {
      expect(flat.includes(tag)).toBe(true);
    }
  });
});
