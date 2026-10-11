import {
  collectWords,
  compoundAcceptable,
  compoundSuggestions,
  distinctWords,
  editDistance,
  issueSpans,
  personalDictionaryFor,
} from '../../../shared/spellcheck';
import type { SpellcheckConfig } from '../../../shared/app-config';

const words = (text: string): string[] => collectWords(text).map((span) => span.word);

/** A stand-in dictionary verdict: case-insensitive set membership. */
const fakeHas =
  (dictionary: string[]) =>
  (word: string): boolean =>
    dictionary.includes(word.toLowerCase());

/** The verdict as main wires it: set membership plus compound tolerance. */
const compoundHas =
  (dictionary: string[]) =>
  (word: string): boolean => {
    const plain = fakeHas(dictionary);
    return plain(word) || compoundAcceptable(plain, word);
  };

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

  it('skips extended-dialect syntax, not the prose around it (milestone 72)', () => {
    // Math (inline + display), footnote refs and definitions, callout
    // markers, emoji shortcodes.
    expect(words('rechnung $x^2 nixwort$ weiter')).toEqual(['rechnung', 'weiter']);
    expect(words('$$\nnixwort\n$$\n\nEcht')).toEqual(['Echt']);
    expect(words('behauptung[^nixwort] und')).toEqual(['behauptung', 'und']);
    expect(words('> [!NOTE] Nixwort')).toEqual(['Nixwort']);
    expect(words('gut :nixwort: gut')).toEqual(['gut', 'gut']);
    // The currency guard: words BETWEEN two prices stay checkable prose.
    expect(words('kostet funf und sechs')).toEqual(['kostet', 'funf', 'und', 'sechs']);
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

    const flagged = issueSpans(spans, new Set(['besprchen']));
    expect(flagged.map((span) => span.from)).toEqual([0, 14]);
    expect(flagged.every((span) => span.word === 'besprchen')).toBe(true);
  });
});

describe('compoundAcceptable', () => {
  const dictionary = ['test', 'fall', 'arbeit', 'speicher', 'tag', 'ordnung', 'haus', 'tuer'];

  it('accepts a closed compound of two listed words ("Testfall")', () => {
    expect(compoundAcceptable(fakeHas(dictionary), 'Testfall')).toBe(true);
  });

  it('consumes a Fugenelement between the parts ("Arbeitsspeicher")', () => {
    expect(compoundAcceptable(fakeHas(dictionary), 'Arbeitsspeicher')).toBe(true);
    expect(compoundAcceptable(fakeHas(dictionary), 'Tagesordnung')).toBe(true);
  });

  it('still rejects words that do not decompose', () => {
    expect(compoundAcceptable(fakeHas(dictionary), 'Testfapl')).toBe(false);
    expect(compoundAcceptable(fakeHas(dictionary), 'besprchen')).toBe(false);
  });

  it('gives up on words too short to split', () => {
    expect(compoundAcceptable(fakeHas(dictionary), 'Testfe')).toBe(false);
  });
});

describe('editDistance', () => {
  it('measures substitutions, insertions and deletions', () => {
    expect(editDistance('Testfall', 'Testfall')).toBe(0);
    expect(editDistance('Testfhal', 'Testfall')).toBe(2);
    // A single deletion: drop the stray "h" and the word is fixed.
    expect(editDistance('Krankehnhaus', 'Krankenhaus')).toBe(1);
    // A single insertion: the missing "o".
    expect(editDistance('besprchen', 'besprochen')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('puts the true fix ahead of recombination noise', () => {
    // The ranking key the main process sorts suggestions by: the real
    // correction ("hn" -> "nh") must outrank plausible-but-wrong joins.
    const original = 'Krankehnhaus';
    const rank = (w: string): number => editDistance(w, original);
    expect(rank('Krankenhaus')).toBeLessThan(rank('Krankeinbaus'));
    expect(rank('Krankenhaus')).toBeLessThan(rank('Krankeinhaue'));
  });
});

describe('compoundSuggestions', () => {
  const dictionary = ['test', 'fall', 'fahl', 'arbeit', 'speicher', 'kranken', 'haus'];
  const has = compoundHas(dictionary);
  /** Fragment suggestions, as nspell would answer them. */
  const suggest = (word: string): string[] =>
    (
      {
        fhal: ['Fall', 'Fahl'],
        fapl: ['fall', 'fapl'],
        krankehn: ['Kranken'],
        speicehr: ['Speicher'],
      } as Record<string, string[]>
    )[word.toLowerCase()] ?? [];

  it('rebuilds a compound from the broken half\'s suggestions', () => {
    expect(compoundSuggestions(suggest, has, 'Testfhal')).toEqual(['Testfall', 'Testfahl']);
    expect(compoundSuggestions(suggest, has, 'Krankehnhaus')).toContain('Krankenhaus');
  });

  it('consumes a Fuge of the broken half before asking the dictionary', () => {
    expect(compoundSuggestions(suggest, has, 'Arbeitsspeicehr')).toContain('Arbeitsspeicher');
  });

  it('never proposes the flagged word itself', () => {
    // "fapl" also suggests "fapl" -- "Test" + "fapl" would rebuild the
    // input verbatim.
    expect(compoundSuggestions(suggest, has, 'Testfapl')).not.toContain('Testfapl');
    expect(compoundSuggestions(suggest, has, 'Testfapl')).toContain('Testfall');
  });

  it('matches the original\'s leading case, and works fully lowercase', () => {
    expect(compoundSuggestions(suggest, has, 'krankehnhaus')).toContain('krankenhaus');
    const upper = compoundSuggestions(suggest, has, 'KRANKEHNHAUS');
    // All-caps input is skipped by the scanner in practice, but the join
    // must not invent mixed case either way.
    expect(upper).toContain('Krankenhaus');
  });

  it('returns nothing when no half decomposes', () => {
    expect(compoundSuggestions(suggest, has, 'besprchen')).toEqual([]);
  });
});

describe('personalDictionaryFor', () => {
  const config = (patch: Partial<SpellcheckConfig>): SpellcheckConfig => ({
    enabled: true,
    language: 'de',
    autoDetect: true,
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
