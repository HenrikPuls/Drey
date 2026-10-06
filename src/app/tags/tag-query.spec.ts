import { splitQuery, tagQueryAtCaret } from './tag-query';

describe('splitQuery', () => {
  it('lifts complete tag words out of the text', () => {
    expect(splitQuery('#physik block ')).toEqual({ tags: ['physik'], text: 'block ' });
    expect(splitQuery('zeit #Physik und #projekt/2024 raum')).toEqual({
      tags: ['physik', 'projekt/2024'],
      text: 'zeit und raum',
    });
  });

  it('de-duplicates and lower-cases', () => {
    expect(splitQuery('#A #a x').tags).toEqual(['a']);
  });

  it('keeps the word that ends at the caret, so it can still complete', () => {
    expect(splitQuery('block #phy', 10)).toEqual({ tags: [], text: 'block #phy' });
    // Once a space follows, the word no longer ends at the caret.
    expect(splitQuery('block #phy ', 11)).toEqual({ tags: ['phy'], text: 'block ' });
  });

  it('never treats a mid-word hash or a bare hash as a tag', () => {
    expect(splitQuery('a#b c')).toEqual({ tags: [], text: 'a#b c' });
    expect(splitQuery('# heading')).toEqual({ tags: [], text: '# heading' });
    expect(splitQuery('#2026 x')).toEqual({ tags: [], text: '#2026 x' });
  });
});

describe('tagQueryAtCaret', () => {
  it('returns the partial tag right before the caret', () => {
    expect(tagQueryAtCaret('block #phy', 10)).toBe('phy');
    expect(tagQueryAtCaret('#', 1)).toBe('');
    expect(tagQueryAtCaret('#Projekt/', 9)).toBe('projekt/');
  });

  it('returns null outside a tag word', () => {
    expect(tagQueryAtCaret('block phy', 9)).toBeNull();
    expect(tagQueryAtCaret('a#b', 3)).toBeNull();
    expect(tagQueryAtCaret('#phy x', 6)).toBeNull();
  });
});
