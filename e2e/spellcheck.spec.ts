import { test, expect } from './fixtures/drey';

/**
 * The personal / per-language accepted-word feature, end to end through
 * the real main process (IPC → app-config.json → nspell.personal()).
 */
test.describe('spellcheck — accepted words', () => {
  const WORD = 'Zqxwptool';

  test('a word added to the personal list stops being flagged, and persists', async ({ page }) => {
    // Baseline: the bundled German dictionary rejects the invented word.
    const before = await page.evaluate((w) => window.dreyApi.checkSpelling([w]), WORD);
    expect(before.misspelled).toContain(WORD);

    // Add it to the global personal list via the immediate IPC path.
    const stored = await page.evaluate((w) => window.dreyApi.addSpellWord(w, 'personal'), WORD);
    expect(stored.spellcheck.personalWords).toContain(WORD);

    // Now the checker accepts it — the dictionary was reloaded.
    const after = await page.evaluate((w) => window.dreyApi.checkSpelling([w]), WORD);
    expect(after.misspelled).not.toContain(WORD);

    // And it survives a re-read of the config.
    const config = await page.evaluate(() => window.dreyApi.getConfig());
    expect(config.spellcheck.personalWords).toContain(WORD);
  });

  test('a per-language word is scoped to the active dictionary', async ({ page }) => {
    const stored = await page.evaluate((w) => window.dreyApi.addSpellWord(w, 'language'), WORD);
    // Default active language is "de".
    expect(stored.spellcheck.languageWords['de']).toContain(WORD);
    expect(stored.spellcheck.personalWords).not.toContain(WORD);

    const deVerdict = await page.evaluate((w) => window.dreyApi.checkSpelling([w]), WORD);
    expect(deVerdict.language).toBe('de');
    expect(deVerdict.misspelled).not.toContain(WORD);
  });

  test('legitimate German compounds are not flagged (nspell has no COMPOUND rules)', async ({ page }) => {
    // dictionary-de declares Hunspell's COMPOUND* rules, but nspell never
    // evaluates them -- the verdict falls back to the shared compound
    // splitter, so "Testfall" (Test + Fall) and "Arbeitsspeicher"
    // (Arbeit + s + Speicher) must come back unflagged.
    const result = await page.evaluate(() =>
      window.dreyApi.checkSpelling(['Testfall', 'Arbeitsspeicher', 'Zqxwptool']),
    );
    expect(result.misspelled).toContain('Zqxwptool');
    expect(result.misspelled).not.toContain('Testfall');
    expect(result.misspelled).not.toContain('Arbeitsspeicher');
  });

  test('the bulk check stays suggestion-free; suggest answers per word', async ({ page }) => {
    // `check` must stay cheap (no per-word suggestion search), so it
    // carries words only; suggestions are a separate per-word call.
    const result = await page.evaluate((w) => window.dreyApi.checkSpelling([w]), WORD);
    expect(result.misspelled).toContain(WORD);

    const suggestions = await page.evaluate((w) => window.dreyApi.suggestSpelling(w), WORD);
    expect(Array.isArray(suggestions)).toBe(true);

    // An accepted word gets no suggestions even when asked directly.
    await page.evaluate((w) => window.dreyApi.addSpellWord(w, 'personal'), WORD);
    const accepted = await page.evaluate((w) => window.dreyApi.suggestSpelling(w), WORD);
    expect(accepted).toEqual([]);
  });

  test('a typo inside a compound gets recombined suggestions', async ({ page }) => {
    // nspell's own suggest is empty for compound typos (the correction is
    // no dictionary word either); the splitter rebuilds candidates from
    // the half the dictionary can advise on, ranked by edit distance so
    // the real fix outranks its recombination noise.
    const krankenhaus = await page.evaluate((w) => window.dreyApi.suggestSpelling(w), 'Krankehnhaus');
    expect(krankenhaus[0]).toBe('Krankenhaus');

    // No dictionary hit for the whole typo, but at least one synthesis.
    const testfhal = await page.evaluate((w) => window.dreyApi.suggestSpelling(w), 'Testfhal');
    expect(testfhal.length).toBeGreaterThan(0);
  });
});
