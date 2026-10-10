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

  function click(button: number): MouseEvent {
    const event = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true });
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

  it('run(id, payload) passes the payload through to the command', () => {
    let received: unknown = 'nothing';
    service.register({ id: 't.e', label: 'E', run: (payload) => (received = payload) });
    service.run('t.e', { tag: 'sailing' });
    expect(received).toEqual({ tag: 'sailing' });
  });

  it('run() on an unknown id is a no-op', () => {
    expect(() => service.run('no.such.id', { whatever: true })).not.toThrow();
  });

  it('runs a command on its bound mouse side button and swallows the event', () => {
    let runs = 0;
    service.register({ id: 't.f', label: 'F', mouseButton: 3, run: () => runs++ });

    const event = click(3);

    expect(runs).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('a mouse-bound command without a keybinding fires on every press', () => {
    let runs = 0;
    service.register({ id: 't.g', label: 'G', mouseButton: 4, run: () => runs++ });

    click(4);
    click(4);

    expect(runs).toBe(2);
  });

  it('ignores mouse buttons no command is bound to', () => {
    let runs = 0;
    service.register({ id: 't.h', label: 'H', mouseButton: 4, run: () => runs++ });

    const left = click(0);
    const middle = click(1);
    click(3);

    expect(runs).toBe(0);
    expect(left.defaultPrevented).toBe(false);
    expect(middle.defaultPrevented).toBe(false);
  });

  it('re-registering the same id replaces the mouse binding', () => {
    const calls: string[] = [];
    service.register({ id: 't.i', label: 'I', mouseButton: 3, run: () => calls.push('old') });
    service.register({ id: 't.i', label: 'I', mouseButton: 3, run: () => calls.push('new') });

    click(3);

    expect(calls).toEqual(['new']);
  });

  it('swallows the mousedown of a bound side button so the caret never moves', () => {
    let runs = 0;
    service.register({ id: 't.j', label: 'J', mouseButton: 3, run: () => runs++ });

    // A stand-in for an editor listener (e.g. CodeMirror's caret placement)
    // on the event's original target path -- it must never see the press.
    let reachedTarget = false;
    const probe = () => (reachedTarget = true);
    document.body.addEventListener('mousedown', probe);
    const press = new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true });
    document.body.dispatchEvent(press);
    document.body.removeEventListener('mousedown', probe);

    expect(reachedTarget).toBe(false);
    expect(press.defaultPrevented).toBe(true);
    expect(runs).toBe(0); // the command itself still waits for mouseup
  });

  it('leaves the mousedown of unbound buttons alone', () => {
    service.register({ id: 't.k', label: 'K', mouseButton: 3, run: () => {} });

    let reachedTarget = false;
    const probe = () => (reachedTarget = true);
    document.body.addEventListener('mousedown', probe);
    const press = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    document.body.dispatchEvent(press);
    document.body.removeEventListener('mousedown', probe);

    expect(reachedTarget).toBe(true);
    expect(press.defaultPrevented).toBe(false);
  });
});
