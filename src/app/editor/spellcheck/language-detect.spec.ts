import {
  LanguageDetector,
  blockAt,
  createLanguageDetector,
  matchInstalled,
  paragraphRanges,
  primarySubtag,
} from './language-detect';

describe('paragraphRanges', () => {
  it('splits on blank lines, keeping wrapped lines together', () => {
    const text = 'Erste Zeile\nund Zeile zwei\n\nZweiter Block\n\ndritter';
    expect(paragraphRanges(text)).toEqual([
      { from: 0, to: 27 },
      { from: 28, to: 42 },
      { from: 43, to: 50 },
    ]);
  });

  it('returns the trailing block when the text ends with a newline', () => {
    expect(paragraphRanges('Nur ein Block\n')).toEqual([{ from: 0, to: 14 }]);
  });

  it('yields nothing for empty or blank text', () => {
    expect(paragraphRanges('')).toEqual([]);
    expect(paragraphRanges('\n\n \n')).toEqual([]);
  });

  it('treats blank-ish lines (spaces) as separators', () => {
    const text = 'eins\n  \nzwei';
    expect(paragraphRanges(text)).toEqual([
      { from: 0, to: 5 },
      { from: 8, to: 12 },
    ]);
  });
});

describe('blockAt', () => {
  const ranges = [
    { from: 0, to: 10 },
    { from: 12, to: 20 },
  ];

  it('finds the range an offset lies in', () => {
    expect(blockAt(ranges, 5)).toEqual(ranges[0]);
    expect(blockAt(ranges, 19)).toEqual(ranges[1]);
  });

  it('returns null between and outside blocks', () => {
    expect(blockAt(ranges, 11)).toBeNull();
    expect(blockAt(ranges, 25)).toBeNull();
  });
});

describe('primarySubtag', () => {
  it('strips region and vendor suffixes', () => {
    expect(primarySubtag('de')).toBe('de');
    expect(primarySubtag('de-AT')).toBe('de');
    expect(primarySubtag('fr_FR')).toBe('fr');
  });
});

describe('matchInstalled', () => {
  const installed = ['de', 'en', 'de-AT', 'fr_FR'];

  it('prefers an exact id match over a shared subtag', () => {
    expect(matchInstalled('deu', installed)).toBe('de');
    expect(matchInstalled('eng', installed)).toBe('en');
  });

  it('falls back to the primary subtag when there is no exact id', () => {
    expect(matchInstalled('fra', installed)).toBe('fr_FR');
  });

  it('returns null for unknown or unmappable languages', () => {
    expect(matchInstalled('spa', ['de'])).toBeNull();
    expect(matchInstalled('ceb', ['en'])).toBeNull(); // no ISO 639-1 code
    expect(matchInstalled('und', ['de'])).toBeNull();
  });
});

describe('createLanguageDetector', () => {
  function makeDetector(
    installed: string[],
    fallback = 'de',
  ): LanguageDetector & { fallbackCalls(): number } {
    let calls = 0;
    return {
      ...createLanguageDetector({
        fallback: () => {
          calls++;
          return fallback;
        },
        installed: () => installed,
      }),
      fallbackCalls: () => calls,
    };
  }

  it('maps paragraphs onto the dictionary of their detected language', () => {
    const detector = makeDetector(['de', 'en']);
    expect(
      detector.languageFor(
        'Gestern habe ich den Arbeitsvertrag im Krankenhaus unterschrieben und besprochen.',
      ),
    ).toBe('de');
    expect(
      detector.languageFor(
        'Yesterday we reviewed the quarterly results and discussed the roadmap for next year.',
      ),
    ).toBe('en');
  });

  it('uses the fallback for blocks too short to detect', () => {
    const detector = makeDetector(['de', 'en']);
    expect(detector.languageFor('Kurze Zeile')).toBe('de');
    expect(detector.languageFor('one two')).toBe('de');
  });

  it('uses the fallback when the detected language has no dictionary', () => {
    const detector = makeDetector(['de']);
    expect(
      detector.languageFor(
        'Ayer firmamos el contrato de trabajo en el hospital cerca de la estacion.',
      ),
    ).toBe('de');
  });

  it('caches verdicts per block text', () => {
    const detector = makeDetector(['de']);
    const block = 'Dies ist ein Satz mit genug Worten fuer die Erkennung, ganz sicher.';
    expect(detector.languageFor(block)).toBe('de');
    expect(detector.fallbackCalls()).toBe(1); // served from the cache now
    expect(detector.languageFor(block)).toBe('de');
    expect(detector.fallbackCalls()).toBe(1);
  });

  it('invalidates the cache when the config changes', () => {
    const detector = makeDetector(['de']);
    const block = 'Dies ist ein Satz mit genug Worten fuer die Erkennung, ganz sicher.';
    detector.languageFor(block);
    detector.invalidate();
    detector.languageFor(block);
    expect(detector.fallbackCalls()).toBe(2);
  });
});
