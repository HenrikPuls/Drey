import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '../../../../shared/app-config';
import { THEME_CATALOG, resolveTheme } from './theme-catalog';

describe('theme catalog', () => {
  it('leads with the built-in Drey theme', () => {
    expect(THEME_CATALOG[0].id).toBe(DEFAULT_THEME);
    expect(THEME_CATALOG[0].group).toBe('Drey');
  });

  it('has unique ids and a plausible seed per entry', () => {
    const ids = THEME_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of THEME_CATALOG) {
      expect(entry.seed.bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(entry.seed.fg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(entry.seed.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(typeof entry.load).toBe('function');
    }
  });

  it('resolves a known id and falls back to Drey for an unknown one', () => {
    expect(resolveTheme('dracula').id).toBe('dracula');
    expect(resolveTheme('does-not-exist').id).toBe(DEFAULT_THEME);
  });

  it('resolves the Drey extension synchronously via load()', async () => {
    await expect(resolveTheme(DEFAULT_THEME).load()).resolves.toBeDefined();
  });
});
