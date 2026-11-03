/**
 * Specs for the appearance module: the defaults, the localStorage
 * persistence of every setting, and what lands on the document element —
 * all against fake document/storage pairs, no globals touched.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCENT_STORAGE_KEY,
  COMPACT_STORAGE_KEY,
  DEFAULT_THEME,
  MOTION_STORAGE_KEY,
  TEXT_SIZE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  Theme,
  accentValueOf,
  applyTheme,
  parseAccent,
  parseTextSize,
  parseTheme,
  persistTheme,
  storedTheme,
  type ThemeEnv,
} from './theme';

interface FakeRoot {
  dataset: Record<string, string>;
  style: { props: Map<string, string>; setProperty(k: string, v: string): void; removeProperty(k: string): void };
}

/** A fake document: the dataset the token blocks key off and the style vars. */
const fakeDoc = (): { documentElement: FakeRoot } => {
  const props = new Map<string, string>();
  return {
    documentElement: {
      dataset: {},
      style: {
        props,
        setProperty: (k, v) => void props.set(k, v),
        removeProperty: (k) => void props.delete(k),
      },
    },
  };
};

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

const env = (extra: Partial<ThemeEnv> = {}): ThemeEnv => ({
  doc: fakeDoc() as unknown as Document,
  storage: fakeStorage(),
  ...extra,
});

const rootOf = (e: ThemeEnv): FakeRoot => e.doc!.documentElement as unknown as FakeRoot;

describe('parsers', () => {
  it('accepts the three themes and reads the first build’s anthracite as Anthrazit', () => {
    expect(parseTheme('anthrazit')).toBe('anthrazit');
    expect(parseTheme('drey')).toBe('drey');
    expect(parseTheme('cyberpunk')).toBe('cyberpunk');
    expect(parseTheme('anthracite')).toBe('anthrazit');
  });

  it('falls back to the default for anything else', () => {
    for (const odd of ['solarized', null, 42, undefined]) {
      expect(parseTheme(odd)).toBe(DEFAULT_THEME);
    }
    expect(parseAccent('chartreuse')).toBe('default');
    expect(parseAccent('teal')).toBe('teal');
    expect(parseTextSize('XXXL')).toBe('M');
    expect(parseTextSize('XL')).toBe('XL');
  });

  it('keeps the default accent as no override', () => {
    expect(accentValueOf('default')).toBeNull();
    expect(accentValueOf('pink')).toBe('#f2a0d0');
  });
});

describe('storedTheme / persistTheme', () => {
  it('reads what persistTheme wrote', () => {
    const storage = fakeStorage();
    expect(storedTheme(storage)).toBe(DEFAULT_THEME);
    persistTheme('drey', storage);
    expect(storedTheme(storage)).toBe('drey');
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
    expect(() => new Theme({ doc: null, storage: broken }).setTextSize('L')).not.toThrow();
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
  it('boots to the defaults and applies them', () => {
    const e = env();
    const theme = new Theme(e);
    expect(theme.name()).toBe('anthrazit');
    expect(theme.accent()).toBe('default');
    expect(theme.textSize()).toBe('M');
    expect(theme.compact()).toBe(false);
    expect(theme.reduceMotion()).toBe(false);
    expect(rootOf(e).dataset).toMatchObject({ theme: 'anthrazit', compact: 'false', reduceMotion: 'false' });
    expect(rootOf(e).style.props.get('--mc-text')).toBe('1');
    expect(rootOf(e).style.props.has('--accent')).toBe(false);
  });

  it('honours everything persisted on boot', () => {
    const e = env();
    e.storage?.setItem(THEME_STORAGE_KEY, 'cyberpunk');
    e.storage?.setItem(ACCENT_STORAGE_KEY, 'teal');
    e.storage?.setItem(TEXT_SIZE_STORAGE_KEY, 'XL');
    e.storage?.setItem(COMPACT_STORAGE_KEY, 'true');
    e.storage?.setItem(MOTION_STORAGE_KEY, 'true');
    const theme = new Theme(e);
    expect([theme.name(), theme.accent(), theme.textSize(), theme.compact(), theme.reduceMotion()]).toEqual([
      'cyberpunk',
      'teal',
      'XL',
      true,
      true,
    ]);
    expect(rootOf(e).style.props.get('--accent')).toBe('#7fd1b9');
    expect(rootOf(e).style.props.get('--mc-text')).toBe('1.3');
  });

  it('falls back to the default when a stored value is broken', () => {
    const e = env();
    e.storage?.setItem(THEME_STORAGE_KEY, 'solarized');
    e.storage?.setItem(TEXT_SIZE_STORAGE_KEY, 'huge');
    const theme = new Theme(e);
    expect(theme.name()).toBe(DEFAULT_THEME);
    expect(theme.textSize()).toBe('M');
  });

  it('starts Reduce motion from the OS preference until the owner chooses', () => {
    expect(new Theme(env({ prefersReducedMotion: true })).reduceMotion()).toBe(true);
    const e = env({ prefersReducedMotion: true });
    e.storage?.setItem(MOTION_STORAGE_KEY, 'false');
    expect(new Theme(e).reduceMotion()).toBe(false);
  });

  it('every setter persists and applies at once', () => {
    const e = env();
    const theme = new Theme(e);
    expect(theme.set('drey')).toBe('drey');
    theme.setAccent('pink');
    theme.setTextSize('XXL');
    theme.setCompact(true);
    theme.setReduceMotion(true);
    expect(e.storage?.getItem(THEME_STORAGE_KEY)).toBe('drey');
    expect(e.storage?.getItem(ACCENT_STORAGE_KEY)).toBe('pink');
    expect(e.storage?.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('XXL');
    expect(e.storage?.getItem(COMPACT_STORAGE_KEY)).toBe('true');
    expect(e.storage?.getItem(MOTION_STORAGE_KEY)).toBe('true');
    expect(rootOf(e).dataset).toMatchObject({ theme: 'drey', compact: 'true', reduceMotion: 'true' });
    expect(rootOf(e).style.props.get('--accent')).toBe('#f2a0d0');
    expect(rootOf(e).style.props.get('--mc-text')).toBe('1.5');
    theme.setAccent('default');
    expect(rootOf(e).style.props.has('--accent')).toBe(false);
  });
});
