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
  DEFAULT_TEXT_SIZE,
  migrateLegacyTextSize,
  parseTextSize,
  storedTextSize,
  TEXT_BODY_PX,
  TEXT_SCALE,
  TEXT_SIZES,
  TEXT_SIZE_SCALE_KEY,
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
    expect(parseTextSize('M')).toBe('M');
    expect(parseTextSize('XXXL')).toBe('L');
    expect(parseTextSize('XL')).toBe('XL');
  });

  it('keeps the default accent as no override', () => {
    expect(accentValueOf('default')).toBeNull();
    expect(accentValueOf('pink')).toBe('#f2d3e2');
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

describe('text size scale', () => {
  it('is S / M / L / XL / XXL = 15 / 16 / 17 / 19 / 21 px with L the default', () => {
    expect(TEXT_SIZES).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
    expect(TEXT_SIZES.map((size) => TEXT_BODY_PX[size])).toEqual([15, 16, 17, 19, 21]);
    expect(15 * TEXT_SCALE.XXL).toBeCloseTo(21);
    expect(parseTextSize('XXL')).toBe('XXL');
    expect(DEFAULT_TEXT_SIZE).toBe('L');
    expect(TEXT_SCALE.S).toBe(1);
    expect(15 * TEXT_SCALE.L).toBeCloseTo(17);
  });

  it('migrates both earlier scales to the nearest step by px', () => {
    expect(['S', 'M', 'L', 'XL', 'XXL'].map((v) => migrateLegacyTextSize(v))).toEqual(['S', 'S', 'L', 'XL', 'XXL']);
    expect(['S', 'L', 'XL', 'XXL', 'XXXL'].map((v) => migrateLegacyTextSize(v, '2'))).toEqual(['S', 'L', 'XL', 'XXL', 'XXL']);
    expect(migrateLegacyTextSize('huge')).toBe('L');
  });

  it('reads an unmarked stored value as legacy, once, and keeps the choice afterwards', () => {
    const store = new Map<string, string>([[TEXT_SIZE_STORAGE_KEY, 'XXL']]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;
    expect(storedTextSize(storage)).toBe('XXL');
    expect(store.get(TEXT_SIZE_STORAGE_KEY)).toBe('XXL');
    expect(store.get(TEXT_SIZE_SCALE_KEY)).toBe('3');
    expect(storedTextSize(storage)).toBe('XXL');
    expect(storedTextSize(null)).toBe('L');
  });

  it('reads a version-2 value (E12-7) once: XXXL lands on XXL, then it stays', () => {
    const store = new Map<string, string>([[TEXT_SIZE_STORAGE_KEY, 'XXXL'], [TEXT_SIZE_SCALE_KEY, '2']]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;
    expect(storedTextSize(storage)).toBe('XXL');
    expect(store.get(TEXT_SIZE_SCALE_KEY)).toBe('3');
    expect(storedTextSize(storage)).toBe('XXL');
  });

  it('keeps a current-scale XXL, and every existing step its value, across a restart', () => {
    for (const size of TEXT_SIZES) {
      const store = new Map<string, string>();
      const storage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      } as unknown as Storage;
      new Theme({ doc: null, storage }).setTextSize(size);
      expect(new Theme({ doc: null, storage }).textSize()).toBe(size);
    }
    expect(TEXT_BODY_PX).toMatchObject({ S: 15, M: 16, L: 17, XL: 19 });
  });

  it('boots a stored legacy M (15 px) to S, the nearest step', () => {
    const e = env();
    e.storage?.setItem(TEXT_SIZE_STORAGE_KEY, 'M');
    expect(new Theme(e).textSize()).toBe('S');
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
    expect(theme.textSize()).toBe('L');
    expect(theme.compact()).toBe(false);
    expect(theme.reduceMotion()).toBe(false);
    expect(rootOf(e).dataset).toMatchObject({ theme: 'anthrazit', compact: 'false', reduceMotion: 'false' });
    expect(rootOf(e).style.props.get('--mc-text')).toBe(String(17 / 15));
    expect(rootOf(e).style.props.has('--accent')).toBe(false);
  });

  it('honours everything persisted on boot', () => {
    const e = env();
    e.storage?.setItem(THEME_STORAGE_KEY, 'cyberpunk');
    e.storage?.setItem(ACCENT_STORAGE_KEY, 'teal');
    e.storage?.setItem(TEXT_SIZE_STORAGE_KEY, 'XL');
    e.storage?.setItem(TEXT_SIZE_SCALE_KEY, '3');
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
    expect(rootOf(e).style.props.get('--mc-text')).toBe(String(19 / 15));
  });

  it('falls back to the default when a stored value is broken', () => {
    const e = env();
    e.storage?.setItem(THEME_STORAGE_KEY, 'solarized');
    e.storage?.setItem(TEXT_SIZE_STORAGE_KEY, 'huge');
    const theme = new Theme(e);
    expect(theme.name()).toBe(DEFAULT_THEME);
    expect(theme.textSize()).toBe('L');
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
    theme.setTextSize('M');
    theme.setCompact(true);
    theme.setReduceMotion(true);
    expect(e.storage?.getItem(THEME_STORAGE_KEY)).toBe('drey');
    expect(e.storage?.getItem(ACCENT_STORAGE_KEY)).toBe('pink');
    expect(e.storage?.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('M');
    expect(e.storage?.getItem(TEXT_SIZE_SCALE_KEY)).toBe('3');
    expect(e.storage?.getItem(COMPACT_STORAGE_KEY)).toBe('true');
    expect(e.storage?.getItem(MOTION_STORAGE_KEY)).toBe('true');
    expect(rootOf(e).dataset).toMatchObject({ theme: 'drey', compact: 'true', reduceMotion: 'true' });
    expect(rootOf(e).style.props.get('--accent')).toBe('#f2d3e2');
    expect(rootOf(e).style.props.get('--mc-text')).toBe(String(16 / 15));
    theme.setAccent('default');
    expect(rootOf(e).style.props.has('--accent')).toBe(false);
  });
});
