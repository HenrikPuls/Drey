/**
 * Specs for the theme module: the default (anthracite), the localStorage
 * persistence, and the toggle cycle — all against fake document/storage
 * pairs, no globals touched.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  Theme,
  applyTheme,
  parseTheme,
  persistTheme,
  storedTheme,
  type ThemeEnv,
} from './theme';

/** A fake document: only the dataset the token blocks key off. */
const fakeDoc = (): { documentElement: { dataset: Record<string, string> } } => ({
  documentElement: { dataset: {} },
});

/** A fake storage: an in-memory map with localStorage's two methods. */
const fakeStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
};

const env = (): ThemeEnv => ({ doc: fakeDoc() as unknown as Document, storage: fakeStorage() });

describe('parseTheme', () => {
  it('accepts the two shipped theme names', () => {
    expect(parseTheme('anthracite')).toBe('anthracite');
    expect(parseTheme('cyberpunk')).toBe('cyberpunk');
  });

  it('falls back to the default for anything else', () => {
    expect(parseTheme('solarized')).toBe(DEFAULT_THEME);
    expect(parseTheme(null)).toBe(DEFAULT_THEME);
    expect(parseTheme(42)).toBe(DEFAULT_THEME);
    expect(parseTheme(undefined)).toBe(DEFAULT_THEME);
  });
});

describe('storedTheme / persistTheme', () => {
  it('reads what persistTheme wrote', () => {
    const storage = fakeStorage();
    expect(storedTheme(storage)).toBe(DEFAULT_THEME);
    persistTheme('cyberpunk', storage);
    expect(storedTheme(storage)).toBe('cyberpunk');
  });

  it('tolerates a null storage and a throwing one', () => {
    expect(storedTheme(null)).toBe(DEFAULT_THEME);
    expect(() => persistTheme('cyberpunk', null)).not.toThrow();
    const broken: Storage = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(storedTheme(broken)).toBe(DEFAULT_THEME);
    expect(() => persistTheme('cyberpunk', broken)).not.toThrow();
  });
});

describe('applyTheme', () => {
  it('writes the theme onto the document element', () => {
    const doc = fakeDoc() as unknown as Document;
    applyTheme('cyberpunk', doc);
    expect(doc.documentElement.dataset['theme']).toBe('cyberpunk');
  });
});

describe('Theme', () => {
  it('boots to anthracite and applies it', () => {
    const e = env();
    const theme = new Theme(e);
    expect(theme.name()).toBe('anthracite');
    expect(e.doc?.documentElement.dataset['theme']).toBe('anthracite');
  });

  it('honours a persisted theme on boot', () => {
    const e = env();
    e.storage?.setItem(THEME_STORAGE_KEY, 'cyberpunk');
    const theme = new Theme(e);
    expect(theme.name()).toBe('cyberpunk');
    expect(e.doc?.documentElement.dataset['theme']).toBe('cyberpunk');
  });

  it('falls back to the default when the stored value is broken', () => {
    const e = env();
    e.storage?.setItem(THEME_STORAGE_KEY, 'solarized');
    expect(new Theme(e).name()).toBe(DEFAULT_THEME);
  });

  it('set persists and applies the chosen theme', () => {
    const e = env();
    const theme = new Theme(e);
    expect(theme.set('cyberpunk')).toBe('cyberpunk');
    expect(e.storage?.getItem(THEME_STORAGE_KEY)).toBe('cyberpunk');
    expect(e.doc?.documentElement.dataset['theme']).toBe('cyberpunk');
  });

  it('toggle cycles anthracite → cyberpunk → anthracite, persisting each step', () => {
    const e = env();
    const theme = new Theme(e);
    expect(theme.toggle()).toBe('cyberpunk');
    expect(e.storage?.getItem(THEME_STORAGE_KEY)).toBe('cyberpunk');
    expect(theme.toggle()).toBe('anthracite');
    expect(e.storage?.getItem(THEME_STORAGE_KEY)).toBe('anthracite');
    expect(e.doc?.documentElement.dataset['theme']).toBe('anthracite');
  });
});
