import {
  collectWords,
  distinctWords,
  issueSpans,
  personalDictionaryFor,
} from '../../../shared/spellcheck';
import type { SpellcheckConfig } from '../../../shared/app-config';

const words = (text: string): string[] => collectWords(text).map((span) => span.word);

describe('collectWords', () => {
  it('returns words with their offsets in the source text', () => {
    expect(collectWords('Kurzes Sync')).toEqual([
      { word: 'Kurzes', from: 0, to: 6 },
      { word: 'Sync', from: 7, to: 11 },
    ]);
  });

  it('splits hyphenated compounds so only the wrong half can be flagged', () => {
    expect(words('Rollot-Plan')).toEqual(['Rollot', 'Plan']);
  });

  it('skips markdown syntax rather than prose', () => {
    expect(words('#daily und [[Markus]] und `code` und https://x.de/pfad')).toEqual([
      'und',
      'und',
      'und',
    ]);
    expect(words('---\ntitle: Nixwort\n---\n\nEcht')).toEqual(['Echt']);
    expect(words('```\nnixwort\n```\n\nEcht')).toEqual(['Echt']);
    expect(words('[Text](./nixwort.md)')).toEqual(['Text']);
    expect(words('<!-- drey:src nixwort -->\nEcht')).toEqual(['Echt']);
    expect(words('mail an puls@newgraphic.de heute')).toEqual(['mail', 'an', 'heute']);
  });

  it('skips acronyms and single letters', () => {
    expect(words('DB Migration a b Ok')).toEqual(['Migration', 'Ok']);
  });

  it('keeps umlauts and apostrophes inside a word', () => {
    expect(words("Größe geht's")).toEqual(['Größe', "geht's"]);
  });
});

describe('distinctWords / issueSpans', () => {
  it('deduplicates for the dictionary and re-expands to every occurrence', () => {
    const spans = collectWords('besprchen und besprchen');
    expect(distinctWords(spans)).toEqual(['besprchen', 'und']);

    const flagged = issueSpans(spans, new Map([['besprchen', ['besprochen']]]));
    expect(flagged.map((span) => span.from)).toEqual([0, 14]);
    expect(flagged[0].suggestions).toEqual(['besprochen']);
  });
});

describe('personalDictionaryFor', () => {
  const config = (patch: Partial<SpellcheckConfig>): SpellcheckConfig => ({
    enabled: true,
    language: 'de',
    dictionaries: [],
    personalWords: [],
    languageWords: {},
    ...patch,
  });

  it('merges the personal list with the words pinned to the active dictionary', () => {
    const out = personalDictionaryFor(
      config({ personalWords: ['Lariscus', 'Drey'], languageWords: { de: ['Montag'], en: ['x'] } }),
      'de',
    );
    expect(out.split('\n')).toEqual(['Lariscus', 'Drey', 'Montag']);
  });

  it('de-duplicates across the two lists and is empty when both are', () => {
    expect(
      personalDictionaryFor(
        config({ personalWords: ['Drey'], languageWords: { de: ['Drey', 'Montag'] } }),
        'de',
      ),
    ).toBe('Drey\nMontag');
    expect(personalDictionaryFor(config({ languageWords: { en: ['x'] } }), 'de')).toBe('');
  });
});
