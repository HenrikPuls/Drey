import { describe, expect, it } from 'vitest';
import { CALLOUT_TYPES, parseCalloutMarker } from './callouts';
import { hasMathSyntax } from './math';
import { emojiFor, EMOJI_NAMES, searchEmojiNames } from './emoji';

describe('parseCalloutMarker', () => {
  it('parses the GitHub five', () => {
    expect(parseCalloutMarker('[!NOTE]')).toMatchObject({ kind: 'note', title: null, fold: null });
    expect(parseCalloutMarker('[!TIP] Tip here')).toMatchObject({ kind: 'tip', title: 'Tip here' });
    expect(parseCalloutMarker('[!IMPORTANT]')).toMatchObject({ kind: 'important' });
    expect(parseCalloutMarker('[!WARNING]')).toMatchObject({ kind: 'warning' });
    expect(parseCalloutMarker('[!CAUTION]')).toMatchObject({ kind: 'caution' });
  });

  it('parses Obsidian aliases and fold suffixes, case-insensitively', () => {
    expect(parseCalloutMarker('[!bug]-')).toMatchObject({ kind: 'caution', fold: '-', title: null });
    expect(parseCalloutMarker('[!TLDR]+ The short version')).toMatchObject({
      kind: 'note',
      fold: '+',
      title: 'The short version',
    });
    expect(parseCalloutMarker('[!Check] done')).toMatchObject({ kind: 'tip' });
  });

  it('rejects plain quote lines and unknown keywords', () => {
    expect(parseCalloutMarker('Just a quote')).toBeNull();
    expect(parseCalloutMarker('[!NOSUCH] x')).toBeNull();
    expect(parseCalloutMarker('text [!NOTE] mid-line')).toBeNull();
  });

  it('covers every keyword with palette, label and icon', () => {
    for (const info of Object.values(CALLOUT_TYPES)) {
      expect(info.kind).toMatch(/^(note|tip|important|warning|caution)$/);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('hasMathSyntax', () => {
  it('finds inline and display math in prose', () => {
    expect(hasMathSyntax('$x^2$')).toBe(true);
    expect(hasMathSyntax('text\n$$\nx\n$$\n')).toBe(true);
    expect(hasMathSyntax('a $$b$$ c')).toBe(true);
  });

  it('ignores dollars in code fences and plain currency', () => {
    expect(hasMathSyntax('```\n$x$\n```')).toBe(false);
    expect(hasMathSyntax('costs 5$ and 6 $')).toBe(false);
    expect(hasMathSyntax('no math here')).toBe(false);
  });
});

describe('emojiFor', () => {
  it('resolves canonical names and aliases, rejects unknowns', () => {
    expect(emojiFor('joy')).toBe('😂');
    expect(emojiFor('+1')).toBe('👍');
    expect(emojiFor('03')).toBeNull();
    expect(emojiFor('not_a_thing')).toBeNull();
  });
});

describe('searchEmojiNames', () => {
  it('ranks prefix matches before substring matches, capped at the limit', () => {
    const results = searchEmojiNames('fire', 8);
    expect(results.length).toBeLessThanOrEqual(8);
    expect(results).toContain('fire');
    const firstSubstring = results.findIndex((n) => !n.startsWith('fire'));
    if (firstSubstring !== -1) {
      // everything from the first substring match on only contains the query
      expect(results.slice(firstSubstring).every((n) => n.includes('fire'))).toBe(true);
      expect(results.slice(0, firstSubstring).every((n) => n.startsWith('fire'))).toBe(true);
    }
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(searchEmojiNames('  JOY ', 5)).toContain('joy');
  });

  it('returns nothing for an empty query (callers own the blank state)', () => {
    expect(searchEmojiNames('', 10)).toEqual([]);
    expect(searchEmojiNames('   ', 10)).toEqual([]);
  });

  it('covers the whole curated table (the picker browses it all)', () => {
    expect(EMOJI_NAMES.length).toBeGreaterThan(1800);
    expect(searchEmojiNames('a', 0)).toEqual([]);
    expect(searchEmojiNames('a', 5)).toHaveLength(5);
  });
});
