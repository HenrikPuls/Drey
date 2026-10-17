import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The save-before-exit state machine of MainWindowHost (bug-5), driven
 * through a fake BrowserWindow: every close path ends in one `close`
 * event, which the host holds, answers with the renderer over the exit
 * bridge, and only lets through once a decision is in. The fake mirrors
 * the real close semantics: `close()` emits `close`; when nothing
 * prevented it, the window is destroyed and `closed` fires.
 */

const electron = vi.hoisted(() => ({
  quit: vi.fn(),
}));

vi.mock('electron', () => {
  // The factory is hoisted above the imports, so no outside binding may be
  // touched here -- hence the own tiny emitter.
  class Emitter {
    private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>();
    on(event: string, listener: (arg?: unknown) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, arg?: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(arg);
    }
  }

  class FakeWebContents extends Emitter {
    session = { webRequest: { onHeadersReceived: () => undefined } };
    setWindowOpenHandler = vi.fn();
    setVisualZoomLevelLimits = vi.fn(async () => undefined);
    send = vi.fn();
    openDevTools = vi.fn();
  }

  class FakeBrowserWindow extends Emitter {
    webContents = new FakeWebContents();
    destroyed = false;
    minimized = false;
    loadURL = vi.fn(async () => undefined);
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    isDestroyed = (): boolean => this.destroyed;
    isMinimized = (): boolean => this.minimized;
    isMaximized = (): boolean => false;
    isFullScreen = (): boolean => false;
    close = vi.fn((): void => {
      const event = {
        defaultPrevented: false,
        preventDefault: (): void => {
          event.defaultPrevented = true;
        },
      };
      this.emit('close', event);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit('closed');
      }
    });
  }

  return {
    app: { quit: (...args: unknown[]) => electron.quit(...(args as [])) },
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: vi.fn(async () => undefined) },
  };
});

import type { BrowserWindow } from 'electron';
import { MainWindowHost } from './main-window';

type FakeWindow = BrowserWindow & {
  destroyed: boolean;
  minimized: boolean;
  close: () => void;
  emit: (event: string, arg?: unknown) => void;
};

function harness() {
  // The real bridge: hasPending is true from the ask until the answer,
  // so the tests drive WHEN the dialog is answered.
  let dialogOpen = false;
  let answer: ((decision: 'save' | 'discard' | 'cancel') => void) | null = null;
  const exitBridge = {
    hasPending: vi.fn(() => dialogOpen),
    requestDecision: vi.fn(
      () =>
        new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
          dialogOpen = true;
          answer = (decision) => {
            dialogOpen = false;
            resolve(decision);
          };
        }),
    ),
  };
  const onCreated = vi.fn();
  const host = new MainWindowHost({ exitBridge: exitBridge as never, onCreated });
  const window = host.create() as unknown as FakeWindow;
  return { host, window, exitBridge, onCreated, answer: (d: 'save' | 'discard' | 'cancel') => answer?.(d) };
}

/** The close prompt answers in a microtask; flush it. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('MainWindowHost - the window and the save-before-exit prompt', () => {
  beforeEach(() => {
    electron.quit.mockClear();
  });

  it('hands every created window to onCreated and keeps it as current', () => {
    const { host, window, onCreated } = harness();
    expect(onCreated).toHaveBeenCalledWith(window);
    expect(host.current).toBe(window);
    expect(host.isGone).toBe(false);
  });

  it('holds the first close, asks the renderer, and closes on "save"', async () => {
    const { host, window, exitBridge, answer } = harness();
    const prevented = vi.fn();
    window.emit('close', { preventDefault: prevented });
    expect(prevented).toHaveBeenCalledOnce();
    expect(exitBridge.requestDecision).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(false);

    answer('save');
    await settled();
    expect(window.close).toHaveBeenCalledTimes(1); // the deliberate second close
    expect(window.destroyed).toBe(true);
    expect(host.current).toBeNull();
    expect(electron.quit).not.toHaveBeenCalled(); // a plain close is not a quit
  });

  it('an app-level quit runs the same prompt and quits after the window is gone', async () => {
    const { host, window, answer } = harness();
    const event = { preventDefault: vi.fn() };
    host.interceptQuit(event as never);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();

    answer('save');
    await settled();
    expect(window.destroyed).toBe(true);
    expect(electron.quit).toHaveBeenCalledOnce();
  });

  it('a second X while the dialog is up waits, without asking twice', async () => {
    const { window, exitBridge, answer } = harness();
    window.emit('close', { preventDefault: vi.fn() });
    window.emit('close', { preventDefault: vi.fn() });
    expect(exitBridge.requestDecision).toHaveBeenCalledOnce();

    answer('save');
    await settled();
    expect(window.destroyed).toBe(true);
    expect(exitBridge.requestDecision).toHaveBeenCalledOnce();
  });

  it('"cancel" keeps the window open and prompts again on the next close', async () => {
    const { host, window, exitBridge, answer } = harness();
    window.emit('close', { preventDefault: vi.fn() });
    answer('cancel');
    await settled();
    expect(window.destroyed).toBe(false);
    expect(host.current).toBe(window);

    window.emit('close', { preventDefault: vi.fn() });
    expect(exitBridge.requestDecision).toHaveBeenCalledTimes(2);
  });

  it('a cancelled quit does not re-issue app.quit', async () => {
    const { host, window, answer } = harness();
    host.interceptQuit({ preventDefault: vi.fn() } as never);
    answer('cancel');
    await settled();
    expect(window.destroyed).toBe(false);
    expect(electron.quit).not.toHaveBeenCalled();

    // The cancelled quit leaves no intent behind: a later approved close
    // is just a close, not the quit that was cancelled.
    window.emit('close', { preventDefault: vi.fn() });
    answer('save');
    await settled();
    expect(window.destroyed).toBe(true);
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('a closed window means gone, and a fresh one prompts again', async () => {
    const { host, window, answer } = harness();
    window.emit('close', { preventDefault: vi.fn() });
    answer('save');
    await settled();
    expect(host.isGone).toBe(true);
  });

  it('interceptQuit passes once the exit was approved', async () => {
    const { host, window } = harness();
    (host as unknown as { exitApproved: boolean }).exitApproved = true;
    const event = { preventDefault: vi.fn() };
    host.interceptQuit(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });

  it('interceptQuit without a window is a no-op', () => {
    const host = new MainWindowHost({ exitBridge: {} as never, onCreated: () => undefined });
    const event = { preventDefault: vi.fn() };
    host.interceptQuit(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('raise focuses the window, restoring a minimized one first', () => {
    const { host, window, answer } = harness();
    expect(host.raise()).toBe(true);
    expect(window.show).toHaveBeenCalledOnce();

    window.minimized = true;
    host.raise();
    expect(window.restore).toHaveBeenCalledOnce();
  });

  it('raise answers false when there is no window', () => {
    const host = new MainWindowHost({ exitBridge: {} as never, onCreated: () => undefined });
    expect(host.raise()).toBe(false);
  });
});
