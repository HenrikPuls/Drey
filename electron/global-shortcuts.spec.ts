import { beforeEach, describe, expect, it, vi } from 'vitest';

const shortcuts = vi.hoisted(() => ({
  taken: new Set<string>(),
  registered: new Map<string, () => void>(),
  calls: [] as string[],
}));

vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string, callback: () => void): boolean => {
      shortcuts.calls.push(accelerator);
      if (shortcuts.taken.has(accelerator)) {
        return false;
      }
      shortcuts.registered.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string): void => {
      shortcuts.registered.delete(accelerator);
    },
  },
}));

import { GlobalShortcuts } from './global-shortcuts';

describe('GlobalShortcuts', () => {
  beforeEach(() => {
    shortcuts.taken.clear();
    shortcuts.registered.clear();
    shortcuts.calls.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('registers each chord and reports the press with its command id', () => {
    const onPress = vi.fn();
    const globals = new GlobalShortcuts(onPress);
    expect(globals.sync([{ id: 'tickets.newTicket', chord: 'Mod+Alt+T' }], [])).toEqual([
      { id: 'tickets.newTicket', chord: 'Mod+Alt+T', registered: true },
    ]);
    shortcuts.registered.get('CommandOrControl+Alt+T')?.();
    expect(onPress).toHaveBeenCalledWith('tickets.newTicket');
  });

  it('registers exactly the new list and drops the chords that left it', () => {
    const globals = new GlobalShortcuts(() => undefined);
    globals.sync(
      [
        { id: 'a.one', chord: 'Mod+Alt+1' },
        { id: 'a.two', chord: 'Mod+Alt+2' },
      ],
      [],
    );
    globals.sync([{ id: 'a.two', chord: 'Mod+Alt+2' }], []);
    expect([...shortcuts.registered.keys()]).toEqual(['CommandOrControl+Alt+2']);
    expect(globals.status()).toEqual([{ id: 'a.two', chord: 'Mod+Alt+2', registered: true }]);
  });

  it('reports a combo another program holds, and retries it on the next sync', () => {
    shortcuts.taken.add('CommandOrControl+Alt+T');
    const globals = new GlobalShortcuts(() => undefined);
    expect(globals.sync([{ id: 'a.one', chord: 'Mod+Alt+T' }], []).at(0)?.registered).toBe(false);
    shortcuts.taken.clear();
    expect(globals.sync([{ id: 'a.one', chord: 'Mod+Alt+T' }], []).at(0)?.registered).toBe(true);
  });

  it('never touches a reserved accelerator (the quick-capture hotkey)', () => {
    // The hotkey's own registration, as CaptureHotkey would leave it.
    shortcuts.registered.set('CommandOrControl+Alt+N', () => undefined);
    const before = shortcuts.registered.get('CommandOrControl+Alt+N');

    const globals = new GlobalShortcuts(() => undefined);
    const statuses = globals.sync([{ id: 'a.one', chord: 'Mod+Alt+N' }], [
      'CommandOrControl+Alt+N',
    ]);

    expect(statuses.at(0)?.registered).toBe(false); // refused before any register call
    expect(shortcuts.calls).not.toContain('CommandOrControl+Alt+N');
    expect(shortcuts.registered.get('CommandOrControl+Alt+N')).toBe(before); // untouched
  });

  it('gives a duplicate chord to the first command only', () => {
    const globals = new GlobalShortcuts(() => undefined);
    const statuses = globals.sync(
      [
        { id: 'a.first', chord: 'Mod+Alt+T' },
        { id: 'a.second', chord: 'Mod+Alt+T' },
      ],
      [],
    );
    expect(statuses).toEqual([
      { id: 'a.first', chord: 'Mod+Alt+T', registered: true },
      { id: 'a.second', chord: 'Mod+Alt+T', registered: false },
    ]);
  });

  it('an unchanged, fully registered list re-registers nothing', () => {
    const globals = new GlobalShortcuts(() => undefined);
    globals.sync([{ id: 'a.one', chord: 'Mod+Alt+T' }], []);
    shortcuts.calls.length = 0;
    expect(globals.sync([{ id: 'a.one', chord: 'Mod+Alt+T' }], []).at(0)?.registered).toBe(true);
    expect(shortcuts.calls).toEqual([]);
  });

  it('holds nothing once the list empties', () => {
    const globals = new GlobalShortcuts(() => undefined);
    globals.sync([{ id: 'a.one', chord: 'Mod+Alt+T' }], []);
    expect(globals.sync([], [])).toEqual([]);
    expect(shortcuts.registered.size).toBe(0);
  });
});
