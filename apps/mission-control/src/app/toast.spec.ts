/**
 * Specs for the toast: the McState slice (one pill at a time, the 2.2 s
 * auto-hide) and the Toast component's view of it — no DOM, the state
 * runs against the fake desk's storage like the store's own specs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { Signal } from '@angular/core';
import { McClient } from './api/client';
import { FakeDesk } from './api/fakes';
import { McState, type ToastMessage } from './api/state';
import { Toast } from './toast';

afterEach(() => {
  vi.useRealTimers();
});

interface ToastSurface {
  toast: Signal<ToastMessage | null>;
}

describe('McState.toast', () => {
  it('shows the message with the given kind', () => {
    vi.useFakeTimers();
    const state = new McState(
      new McClient({ fetch: new FakeDesk().fetch, storage: new FakeDesk().storage }),
    );
    state.toast('Theme: Cyberpunk', 'ok');
    expect(state.toastMessage()).toEqual({ message: 'Theme: Cyberpunk', kind: 'ok' });
  });

  it('defaults the kind to ok', () => {
    vi.useFakeTimers();
    const state = new McState(
      new McClient({ fetch: new FakeDesk().fetch, storage: new FakeDesk().storage }),
    );
    state.toast('plain');
    expect(state.toastMessage()?.kind).toBe('ok');
  });

  it('hides itself after 2.2 s', () => {
    vi.useFakeTimers();
    const state = new McState(
      new McClient({ fetch: new FakeDesk().fetch, storage: new FakeDesk().storage }),
    );
    state.toast('Saved');
    expect(state.toastMessage()).not.toBeNull();
    vi.advanceTimersByTime(2199);
    expect(state.toastMessage()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(state.toastMessage()).toBeNull();
  });

  it('a newer toast replaces the running one and restarts the hide timer', () => {
    vi.useFakeTimers();
    const state = new McState(
      new McClient({ fetch: new FakeDesk().fetch, storage: new FakeDesk().storage }),
    );
    state.toast('first', 'ok');
    vi.advanceTimersByTime(1000);
    state.toast('second', 'warn');
    vi.advanceTimersByTime(2100); // 3100 ms after the first — only 2.1 s after the second
    expect(state.toastMessage()).toEqual({ message: 'second', kind: 'warn' });
    vi.advanceTimersByTime(100);
    expect(state.toastMessage()).toBeNull();
  });
});

describe('Toast (component)', () => {
  it('renders the current toast from the shared state', () => {
    vi.useFakeTimers();
    const desk = new FakeDesk();
    const state = new McState(new McClient({ fetch: desk.fetch, storage: desk.storage }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: McState, useValue: state }] });
    const surface = TestBed.runInInjectionContext(() => new Toast()) as unknown as ToastSurface;

    expect(surface.toast()).toBeNull();

    state.toast('Sent back to Build', 'warn');
    expect(surface.toast()).toEqual({ message: 'Sent back to Build', kind: 'warn' });

    vi.advanceTimersByTime(2200);
    expect(surface.toast()).toBeNull();
  });
});
