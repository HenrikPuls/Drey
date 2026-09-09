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
    expect(before.issues.map((i) => i.word)).toContain(WORD);

    // Add it to the global personal list via the immediate IPC path.
    const stored = await page.evaluate((w) => window.dreyApi.addSpellWord(w, 'personal'), WORD);
    expect(stored.spellcheck.personalWords).toContain(WORD);

    // Now the checker accepts it — the dictionary was reloaded.
    const after = await page.evaluate((w) => window.dreyApi.checkSpelling([w]), WORD);
    expect(after.issues.map((i) => i.word)).not.toContain(WORD);

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
    expect(deVerdict.issues.map((i) => i.word)).not.toContain(WORD);
  });
});
