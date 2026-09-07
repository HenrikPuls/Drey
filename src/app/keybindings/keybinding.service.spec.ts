import { TestBed } from '@angular/core/testing';
import { KeybindingService } from './keybinding.service';
import { matchesChord, parseChord } from './command';

describe('parseChord / matchesChord', () => {
  it('parses Mod / Ctrl / Cmd as the one "mod" flag', () => {
    expect(parseChord('Mod+Shift+F')).toEqual({ mod: true, shift: true, alt: false, key: 'f' });
    expect(parseChord('Ctrl+K')).toEqual({ mod: true, shift: false, alt: false, key: 'k' });
    expect(parseChord('Cmd+Alt+P')).toEqual({ mod: true, shift: false, alt: true, key: 'p' });
  });

  it('matches an event only when every modifier and the key line up', () => {
    const chord = parseChord('Mod+Shift+F');
    expect(
      matchesChord(
        new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }),
        chord,
      ),
    ).toBe(true);
    expect(
      matchesChord(
        new KeyboardEvent('keydown', { key: 'f', metaKey: true, shiftKey: true }),
        chord,
      ),
    ).toBe(true);
    expect(matchesChord(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }), chord)).toBe(
      false,
    );
    expect(
      matchesChord(
        new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, shiftKey: true }),
        chord,
      ),
    ).toBe(false);
  });
});

describe('KeybindingService', () => {
  let service: KeybindingService;

  beforeEach(() => {
    service = TestBed.inject(KeybindingService);
  });

  function press(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it('runs a registered command on its chord and swallows the event', () => {
    let runs = 0;
    service.register({ id: 't.a', label: 'A', keybinding: 'Mod+Shift+F', run: () => runs++ });

    const event = press({ key: 'f', ctrlKey: true, shiftKey: true });

    expect(runs).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores an unregistered chord', () => {
    let runs = 0;
    service.register({ id: 't.b', label: 'B', keybinding: 'Mod+Shift+F', run: () => runs++ });

    press({ key: 'f', ctrlKey: true }); // no shift

    expect(runs).toBe(0);
  });

  it('re-registering the same id replaces the binding', () => {
    const calls: string[] = [];
    service.register({ id: 't.c', label: 'C', keybinding: 'Mod+J', run: () => calls.push('old') });
    service.register({ id: 't.c', label: 'C', keybinding: 'Mod+J', run: () => calls.push('new') });

    press({ key: 'j', ctrlKey: true });

    expect(calls).toEqual(['new']);
  });

  it('run(id) invokes a command directly', () => {
    let ran = false;
    service.register({ id: 't.d', label: 'D', run: () => (ran = true) });
    service.run('t.d');
    expect(ran).toBe(true);
  });
});
