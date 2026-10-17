import { describe, expect, it } from 'vitest';
import { createColumnCollapseStore, type ColumnCollapseStorage } from './column-collapse';

/** An in-memory localStorage stand-in (the spec project has no DOM). */
function memoryStorage(): ColumnCollapseStorage & { dump(): string | null } {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    dump: () => data.get('drey.tickets') ?? null,
  };
}

describe('column-collapse store (T-0005)', () => {
  it('starts with nothing collapsed on empty or unreadable state', () => {
    const broken = memoryStorage();
    broken.setItem('drey.tickets', '{ not json');
    expect(createColumnCollapseStore(broken).isCollapsed('done')).toBe(false);
    expect(createColumnCollapseStore(memoryStorage()).isCollapsed('done')).toBe(false);
  });

  it('collapses, survives a reload and expands again', () => {
    const storage = memoryStorage();
    createColumnCollapseStore(storage).setCollapsed('done', true);
    const reloaded = createColumnCollapseStore(storage); // a fresh view after restart
    expect(reloaded.isCollapsed('done')).toBe(true);
    reloaded.setCollapsed('done', false);
    expect(createColumnCollapseStore(storage).isCollapsed('done')).toBe(false);
  });

  it('ignores non-string and empty entries when reading', () => {
    const storage = memoryStorage();
    storage.setItem('drey.tickets', JSON.stringify({ collapsed: ['done', 7, null, ''] }));
    const store = createColumnCollapseStore(storage);
    expect(store.isCollapsed('done')).toBe(true);
    store.setCollapsed('build', true);
    expect(JSON.parse(storage.dump() ?? '{}')).toEqual({ collapsed: ['done', 'build'] });
  });

  it('prunes phase ids the board no longer lists and persists the rest', () => {
    const storage = memoryStorage();
    const store = createColumnCollapseStore(storage);
    store.setCollapsed('done', true);
    store.setCollapsed('build', true);
    expect(store.prune(['build', 'review'])).toBe(true);
    expect(store.isCollapsed('done')).toBe(false);
    expect(store.isCollapsed('build')).toBe(true);
    expect(store.prune(['build', 'review'])).toBe(false); // nothing left to drop
    expect(createColumnCollapseStore(storage).isCollapsed('done')).toBe(false); // persisted
  });

  it('writes nothing when the value does not change', () => {
    const storage = memoryStorage();
    const store = createColumnCollapseStore(storage);
    store.setCollapsed('build', false);
    store.setCollapsed('build', false);
    expect(storage.dump()).toBe(null);
  });
});
