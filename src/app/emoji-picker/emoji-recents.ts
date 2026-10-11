/**
 * The emoji picker's "recently used" ring: the last ~24 shortcode names
 * picked, persisted under `drey.emoji.recent` (the same localStorage
 * convention the dock uses). Pure functions over an injected storage so
 * the unit spec needs no DOM -- the picker service hands them the real
 * `localStorage`, and the `:`-completion reads the same list to rank its
 * options.
 */
const STORAGE_KEY = 'drey.emoji.recent';
const LIMIT = 24;

/** The storage slice the helpers need (structurally `localStorage`). */
export interface EmojiRecentsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The persisted recents, oldest last; corruption reads as "none". */
export function loadEmojiRecents(storage: EmojiRecentsStorage): readonly string[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((name): name is string => typeof name === 'string').slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** Moves `name` to the front (deduped), persists, and returns the next ring. */
export function pushEmojiRecent(storage: EmojiRecentsStorage, name: string): readonly string[] {
  const next = [name, ...loadEmojiRecents(storage).filter((n) => n !== name)].slice(0, LIMIT);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota exceeded -- recents are a nicety, never an error
  }
  return next;
}
