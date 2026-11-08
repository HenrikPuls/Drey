import { describe, expect, it } from 'vitest';
import { createFoldStore } from './fold-store.js';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

describe('createFoldStore', () => {
  it('starts with History folded and the change groups open', () => {
    const folds = createFoldStore(memoryStorage());
    expect(folds.isOpen('v1', 'history')).toBe(false);
    expect(folds.isOpen('v1', 'changes')).toBe(true);
    expect(folds.isOpen('v1', 'staged')).toBe(true);
    expect(folds.isOpen('v1', 'conflicts')).toBe(true);
  });

  it('keeps a fold per repository across a new store on the same storage (a restart)', () => {
    const storage = memoryStorage();
    const folds = createFoldStore(storage);
    folds.setOpen('v1', 'changes', false);
    folds.setOpen('v1::drey', 'history', true);
    const again = createFoldStore(storage);
    expect(again.isOpen('v1', 'changes')).toBe(false);
    expect(again.isOpen('v2', 'changes')).toBe(true);
    expect(again.isOpen('v1::drey', 'history')).toBe(true);
    expect(again.isOpen('v1', 'history')).toBe(false);
  });

  it('works without storage and survives a broken value', () => {
    const none = createFoldStore(null);
    none.setOpen('v1', 'staged', false);
    expect(none.isOpen('v1', 'staged')).toBe(false);
    const storage = memoryStorage();
    storage.setItem('drey.git.folds', '{not json');
    expect(createFoldStore(storage).isOpen('v1', 'staged')).toBe(true);
  });
});
