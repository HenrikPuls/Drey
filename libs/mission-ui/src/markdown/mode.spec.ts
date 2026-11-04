import { deviceStorage, isMdMode, storedMode, storeMode, type ModeStorage } from './mode';

function fake(initial: Record<string, string> = {}): ModeStorage {
  const data = { ...initial };
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe('the Markdown surface mode memory', () => {
  it('knows its three modes', () => {
    expect(['live', 'view', 'source'].every(isMdMode)).toBe(true);
    expect(isMdMode('edit')).toBe(false);
    expect(isMdMode(null)).toBe(false);
  });

  it('falls back to the surface default when nothing is stored', () => {
    expect(storedMode(fake(), 'ticket', 'view')).toBe('view');
    expect(storedMode(null, 'plan-edit', 'live')).toBe('live');
  });

  it('remembers the pick per surface', () => {
    const storage = fake();
    storeMode(storage, 'ticket', 'source');
    expect(storedMode(storage, 'ticket', 'view')).toBe('source');
    expect(storedMode(storage, 'proof', 'view')).toBe('view');
  });

  it('ignores a broken stored value', () => {
    expect(storedMode(fake({ 'mc.md-mode.ticket': 'nonsense' }), 'ticket', 'view')).toBe('view');
  });

  it('survives a storage that throws', () => {
    const blocked: ModeStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(storedMode(blocked, 'ticket', 'view')).toBe('view');
    expect(() => storeMode(blocked, 'ticket', 'live')).not.toThrow();
  });

  it('offers a device storage where the runtime has one', () => {
    expect(deviceStorage()).not.toBeUndefined();
  });
});
