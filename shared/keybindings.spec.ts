import { describe, expect, it } from 'vitest';
import {
  canonicalChord,
  chordFromKeyPress,
  chordProblem,
  chordToAccelerator,
  effectiveChord,
  parseChord,
  sameChord,
} from './keybindings';

const press = (key: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false,
});

describe('parseChord', () => {
  it('reads modifiers in any spelling and the key lower-cased', () => {
    expect(parseChord('Mod+Shift+F')).toEqual({ mod: true, shift: true, alt: false, key: 'f' });
    expect(parseChord('Cmd+Option+P')).toEqual({ mod: true, shift: false, alt: true, key: 'p' });
  });

  it('reads the plus key and Space', () => {
    expect(parseChord('Mod++').key).toBe('+');
    expect(parseChord('Mod+Shift++')).toEqual({ mod: true, shift: true, alt: false, key: '+' });
    expect(parseChord('Alt+Space').key).toBe(' ');
  });
});

describe('canonicalChord', () => {
  it('orders the modifiers and spells the key', () => {
    expect(canonicalChord('shift+ctrl+k')).toBe('Mod+Shift+K');
    expect(canonicalChord('Alt+arrowleft')).toBe('Alt+ArrowLeft');
    expect(canonicalChord('shift+f6')).toBe('Shift+F6');
    expect(canonicalChord('Mod+\\')).toBe('Mod+\\');
  });

  it('is null without a key', () => {
    expect(canonicalChord('Mod+Shift')).toBeNull();
  });
});

describe('chordFromKeyPress', () => {
  it('waits while only modifiers are held', () => {
    expect(chordFromKeyPress(press('Control', { ctrl: true }))).toBeNull();
    expect(chordFromKeyPress(press('Shift', { shift: true }))).toBeNull();
  });

  it('spells the pressed chord canonically', () => {
    expect(chordFromKeyPress(press('K', { ctrl: true, shift: true }))).toBe('Mod+Shift+K');
    expect(chordFromKeyPress(press('F6'))).toBe('F6');
    expect(chordFromKeyPress(press(' ', { alt: true }))).toBe('Alt+Space');
  });
});

describe('chordProblem', () => {
  it('accepts Ctrl or Alt chords and function keys', () => {
    expect(chordProblem('Mod+Shift+K')).toBeNull();
    expect(chordProblem('Alt+J')).toBeNull();
    expect(chordProblem('F6')).toBeNull();
    expect(chordProblem('Shift+F6')).toBeNull();
  });

  it('refuses a bare key or Shift+key — it would swallow typing', () => {
    expect(chordProblem('K')).toBe('needs-modifier');
    expect(chordProblem('Shift+K')).toBe('needs-modifier');
    expect(chordProblem('Enter')).toBe('needs-modifier');
  });

  it('refuses the chords the editor needs, in any spelling', () => {
    expect(chordProblem('Ctrl+z')).toBe('reserved');
    expect(chordProblem('shift+mod+z')).toBe('reserved');
    expect(chordProblem('Mod+C')).toBe('reserved');
    expect(chordProblem('Mod+Enter')).toBe('reserved');
    expect(chordProblem('Alt+ArrowUp')).toBe('reserved');
  });

  it('needs a key', () => {
    expect(chordProblem('Mod+Alt')).toBe('no-key');
  });
});

describe('effectiveChord', () => {
  it('prefers the override, null meaning none, missing meaning the default', () => {
    const overrides = { a: 'Mod+K', b: null };
    expect(effectiveChord('a', 'Mod+J', overrides)).toBe('Mod+K');
    expect(effectiveChord('b', 'Mod+J', overrides)).toBeUndefined();
    expect(effectiveChord('c', 'Mod+J', overrides)).toBe('Mod+J');
  });
});

describe('sameChord', () => {
  it('compares spellings of the same keys', () => {
    expect(sameChord('Ctrl+Shift+k', 'Mod+Shift+K')).toBe(true);
    expect(sameChord('Mod+K', 'Mod+Shift+K')).toBe(false);
  });
});

describe('chordToAccelerator', () => {
  it('converts to Electron accelerator names', () => {
    expect(chordToAccelerator('Mod+Alt+N')).toBe('CommandOrControl+Alt+N');
    expect(chordToAccelerator('Mod+Shift+ArrowLeft')).toBe('CommandOrControl+Shift+Left');
    expect(chordToAccelerator('Alt+Space')).toBe('Alt+Space');
    expect(chordToAccelerator('F9')).toBe('F9');
    expect(chordToAccelerator('Mod+,')).toBe('CommandOrControl+,');
  });

  it('is null for a key Electron cannot name', () => {
    expect(chordToAccelerator('Mod+MediaPlayPause')).toBeNull();
  });
});
