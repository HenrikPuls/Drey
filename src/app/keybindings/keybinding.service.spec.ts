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

  it('runs a command on the user\'s chord instead of its default (ADR-0073)', () => {
    let runs = 0;
    service.register({ id: 't.o1', label: 'O1', keybinding: 'Mod+Alt+1', run: () => runs++ });
    service.setOverrides({ 't.o1': 'Mod+Alt+2' });

    press({ key: '1', ctrlKey: true, altKey: true });
    expect(runs).toBe(0);
    press({ key: '2', ctrlKey: true, altKey: true });
    expect(runs).toBe(1);
    expect(service.chordFor('t.o1')).toBe('Mod+Alt+2');
    expect(service.defaultChord('t.o1')).toBe('Mod+Alt+1');
    expect(service.hint('t.o1')).toBe('Ctrl Alt 2');
  });

  it('a null override leaves the command without a shortcut', () => {
    let runs = 0;
    service.register({ id: 't.o2', label: 'O2', keybinding: 'Mod+Alt+3', run: () => runs++ });
    service.setOverrides({ 't.o2': null });

    press({ key: '3', ctrlKey: true, altKey: true });

    expect(runs).toBe(0);
    expect(service.hint('t.o2')).toBe('');
    expect(service.all().find((c) => c.id === 't.o2')?.keybinding).toBeUndefined();
  });

  it('an override registered before its command applies when the command arrives', () => {
    let runs = 0;
    service.setOverrides({ 't.o3': 'Mod+Alt+4' });
    service.register({ id: 't.o3', label: 'O3', run: () => runs++ });

    press({ key: '4', ctrlKey: true, altKey: true });

    expect(runs).toBe(1);
  });

  it('the user\'s chord wins over another command\'s default with the same keys', () => {
    const calls: string[] = [];
    service.register({ id: 't.o4', label: 'O4', keybinding: 'Mod+Alt+5', run: () => calls.push('default') });
    service.register({ id: 't.o5', label: 'O5', run: () => calls.push('chosen') });
    service.setOverrides({ 't.o5': 'Mod+Alt+5' });

    press({ key: '5', ctrlKey: true, altKey: true });

    expect(calls).toEqual(['chosen']);
  });

  it('re-registering without a chord drops the old one (a disabled plugin\'s stand-in)', () => {
    let runs = 0;
    service.register({ id: 't.o6', label: 'O6', keybinding: 'Mod+Alt+6', run: () => runs++ });
    service.register({ id: 't.o6', label: 'O6', run: () => {} });

    const event = press({ key: '6', ctrlKey: true, altKey: true });

    expect(runs).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('matches nothing while paused, and again once resumed', () => {
    let runs = 0;
    service.register({ id: 't.o7', label: 'O7', keybinding: 'Mod+Alt+7', run: () => runs++ });

    const resume = service.pause();
    press({ key: '7', ctrlKey: true, altKey: true });
    expect(runs).toBe(0);
    resume();
    resume(); // idempotent
    press({ key: '7', ctrlKey: true, altKey: true });
    expect(runs).toBe(1);
  });

  it('titled() appends the chord to a tooltip only when there is one', () => {
    service.register({ id: 't.o8', label: 'O8', keybinding: 'Mod+G', run: () => {} });
    service.register({ id: 't.o9', label: 'O9', run: () => {} });

    expect(service.titled('Toggle', 't.o8')).toBe('Toggle (Ctrl G)');
    expect(service.titled('Other', 't.o9')).toBe('Other');
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
