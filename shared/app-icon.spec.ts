import { describe, expect, it } from 'vitest';
import { appIconStem, appIconVariant } from './app-icon';
import { ANTHRAZIT_THEME, CYBERPUNK_THEME, DREY_THEME } from './app-config';

describe('appIconVariant', () => {
  it('gives Cyberpunk its own mark', () => {
    expect(appIconVariant(CYBERPUNK_THEME)).toBe('cyberpunk');
  });

  it('keeps the default mark for every other theme, known or not', () => {
    for (const id of [ANTHRAZIT_THEME, DREY_THEME, 'dracula', '', 'no-such-theme']) {
      expect(appIconVariant(id)).toBe('default');
    }
  });
});

describe('appIconStem', () => {
  it('names the files make-icon.mjs writes', () => {
    expect(appIconStem('default')).toBe('icon');
    expect(appIconStem('cyberpunk')).toBe('icon-cyberpunk');
  });
});
