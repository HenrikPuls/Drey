import { describe, expect, it } from 'vitest';

import { loadEmojiRecents, pushEmojiRecent, type EmojiRecentsStorage } from './emoji-recents';

/** An in-memory localStorage stand-in. */
function memory(): EmojiRecentsStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
  };
}

const KEY = 'drey.emoji.recent';

describe('loadEmojiRecents', () => {
  it('reads the persisted ring, oldest last', () => {
    const storage = memory();
    storage.map.set(KEY, JSON.stringify(['joy', 'fire']));
    expect(loadEmojiRecents(storage)).toEqual(['joy', 'fire']);
  });

  it('reads corruption and foreign payloads as "no recents"', () => {
    const storage = memory();
    storage.map.set(KEY, '{not json');
    expect(loadEmojiRecents(storage)).toEqual([]);
    storage.map.set(KEY, JSON.stringify({ nope: true }));
    expect(loadEmojiRecents(storage)).toEqual([]);
    storage.map.set(KEY, JSON.stringify(['ok', 42, null]));
    expect(loadEmojiRecents(storage)).toEqual(['ok']);
  });
});

describe('pushEmojiRecent', () => {
  it('moves a repeat pick to the front and caps the ring at 24', () => {
    const storage = memory();
    pushEmojiRecent(storage, 'a');
    pushEmojiRecent(storage, 'b');
    expect(pushEmojiRecent(storage, 'a')).toEqual(['a', 'b']);
    expect(loadEmojiRecents(storage)).toEqual(['a', 'b']);

    for (let i = 0; i < 30; i++) {
      pushEmojiRecent(storage, `e${i}`);
    }
    const ring = loadEmojiRecents(storage);
    expect(ring).toHaveLength(24);
    expect(ring[0]).toBe('e29');
  });

  it('survives a throwing storage', () => {
    const broken: EmojiRecentsStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(pushEmojiRecent(broken, 'joy')).toEqual(['joy']);
  });
});
