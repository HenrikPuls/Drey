import { beforeEach, describe, expect, it, vi } from 'vitest';

const shortcuts = vi.hoisted(() => ({
  taken: new Set<string>(),
  registered: new Map<string, () => void>(),
}));

vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string, callback: () => void): boolean => {
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

import { CaptureHotkey } from './capture-hotkey';

describe('CaptureHotkey', () => {
  beforeEach(() => {
    shortcuts.taken.clear();
    shortcuts.registered.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('registers the chord as an accelerator and runs the handler', () => {
    const onPress = vi.fn();
    const hotkey = new CaptureHotkey(onPress);
    expect(hotkey.sync('Mod+Alt+N')).toEqual({ chord: 'Mod+Alt+N', registered: true });
    shortcuts.registered.get('CommandOrControl+Alt+N')?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('moves to a new chord and releases the old one', () => {
    const hotkey = new CaptureHotkey(() => undefined);
    hotkey.sync('Mod+Alt+N');
    hotkey.sync('Mod+Alt+Q');
    expect([...shortcuts.registered.keys()]).toEqual(['CommandOrControl+Alt+Q']);
  });

  it('reports a combo another program holds, and retries it on the next sync', () => {
    shortcuts.taken.add('CommandOrControl+Alt+N');
    const hotkey = new CaptureHotkey(() => undefined);
    expect(hotkey.sync('Mod+Alt+N').registered).toBe(false);
    expect(hotkey.status()).toEqual({ chord: 'Mod+Alt+N', registered: false });
    shortcuts.taken.clear();
    expect(hotkey.sync('Mod+Alt+N').registered).toBe(true);
  });

  it('holds nothing when the chord is removed', () => {
    const hotkey = new CaptureHotkey(() => undefined);
    hotkey.sync('Mod+Alt+N');
    expect(hotkey.sync(null)).toEqual({ chord: null, registered: false });
    expect(shortcuts.registered.size).toBe(0);
  });
});
