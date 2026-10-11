import { describe, expect, it } from 'vitest';
import { ANTHRAZIT_THEME, DREY_THEME } from '../../../../shared/app-config';
import { THEME_CATALOG, resolveTheme } from './theme-catalog';

describe('theme catalog', () => {
  it('leads with the default, Anthrazit, and lists Drey right after it', () => {
    expect(THEME_CATALOG[0].id).toBe(ANTHRAZIT_THEME);
    expect(THEME_CATALOG[1].id).toBe(DREY_THEME);
    expect(THEME_CATALOG[0].group).toBe('Drey');
    expect(THEME_CATALOG[1].group).toBe('Drey');
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

  it('resolves a known id and falls back to Anthrazit for an unknown one', () => {
    expect(resolveTheme('dracula').id).toBe('dracula');
    expect(resolveTheme('does-not-exist').id).toBe(ANTHRAZIT_THEME);
  });

  it('lists Cyberpunk as the third bespoke theme, with its own editor look', async () => {
    expect(THEME_CATALOG[2].id).toBe('cyberpunk');
    expect(THEME_CATALOG[2].group).toBe('Drey');
    await expect(resolveTheme('cyberpunk').load()).resolves.toBeDefined();
  });

  it('resolves the Drey extension synchronously via load()', async () => {
    await expect(resolveTheme(DREY_THEME).load()).resolves.toBeDefined();
  });
});
