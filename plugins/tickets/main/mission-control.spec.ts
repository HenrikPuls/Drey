import { describe, expect, it } from 'vitest';
import {
  MISSION_CONTROL_REMOTE_OFF,
  MissionControlHost,
  type LocalClientReply,
  type MissionControlView,
} from './mission-control';

/**
 * The Mission Control host (E5c, concept §3.5.4) — the window surface
 * and the engine's localClient are injected, so the spec never opens a
 * real window and never talks to the engine.
 */

class FakeView implements MissionControlView {
  loaded: string[] = [];
  shown = 0;
  focused = 0;
  destroyed = false;
  closedHandlers: Array<() => void> = [];
  failLoad: Error | null = null;

  async loadURL(url: string): Promise<void> {
    if (this.failLoad !== null) {
      throw this.failLoad;
    }
    this.loaded.push(url);
  }

  show(): void {
    this.shown += 1;
  }

  focus(): void {
    this.focused += 1;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }

  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler);
  }

  /** What Electron fires when the user closes the window. */
  close(): void {
    for (const handler of this.closedHandlers) {
      handler();
    }
  }
}

const CLIENT: LocalClientReply = { ok: true, token: 'tok-123', url: 'http://127.0.0.1:8787' };

function setup(...replies: LocalClientReply[]): { host: MissionControlHost; views: FakeView[]; clientCalls: () => number } {
  const views: FakeView[] = [];
  let calls = 0;
  const host = new MissionControlHost({
    // The later opens keep answering with the last reply — the host must
    // not even ask again while its window lives, but a fresh window
    // (after a close) does ask again.
    localClient: () => Promise.resolve(replies[Math.min(calls++, replies.length - 1)] ?? { ok: false, error: 'no reply' }),
    createView: () => {
      const view = new FakeView();
      views.push(view);
      return view;
    },
  });
  return { host, views, clientCalls: () => calls };
}

describe('MissionControlHost', () => {
  it('opens the gateway URL with the token in the fragment', async () => {
    const { host, views } = setup(CLIENT);
    const result = await host.open();
    expect(result).toEqual({ ok: true });
    expect(views).toHaveLength(1);
    expect(views[0]!.loaded).toEqual(['http://127.0.0.1:8787#token=tok-123']);
    // Hidden until loaded, shown and focused after.
    expect(views[0]!.shown).toBe(1);
    expect(views[0]!.focused).toBe(1);
  });

  it('encodes a token that is not URL-safe', async () => {
    const { host, views } = setup({ ok: true, token: 'a b/&=+', url: 'https://example.test:8443' });
    await host.open();
    expect(views[0]!.loaded).toEqual([`https://example.test:8443#token=${encodeURIComponent('a b/&=+')}`]);
  });

  it('answers honestly while the remote is off (null URL)', async () => {
    const { host, views, clientCalls } = setup({ ok: true, token: 'tok', url: null });
    const result = await host.open();
    expect(result).toEqual({ ok: false, error: MISSION_CONTROL_REMOTE_OFF });
    expect(result.error).toBe('Enable remote access in Settings → Tickets → Remote.');
    expect(views).toHaveLength(0);
    expect(clientCalls()).toBe(1);
  });

  it('treats an empty URL like the remote being off', async () => {
    const { host, views } = setup({ ok: true, token: 'tok', url: '' });
    const result = await host.open();
    expect(result).toEqual({ ok: false, error: MISSION_CONTROL_REMOTE_OFF });
    expect(views).toHaveLength(0);
  });

  it('passes the engine refusal through', async () => {
    const { host, views } = setup({ ok: false, error: 'the registry is not initialized' });
    const result = await host.open();
    expect(result).toEqual({ ok: false, error: 'the registry is not initialized' });
    expect(views).toHaveLength(0);
  });

  it('refuses politely when the engine hands out no token', async () => {
    const { host, views } = setup({ ok: true, url: 'http://127.0.0.1:8787' });
    const result = await host.open();
    expect(result.ok).toBe(false);
    expect(views).toHaveLength(0);
  });

  it('surfaces a localClient throw instead of crashing', async () => {
    const views: FakeView[] = [];
    const host = new MissionControlHost({
      localClient: () => Promise.reject(new Error('engine unreachable')),
      createView: () => {
        const view = new FakeView();
        views.push(view);
        return view;
      },
    });
    const result = await host.open();
    expect(result).toEqual({ ok: false, error: 'engine unreachable' });
    expect(views).toHaveLength(0);
  });

  it('focuses the living window on a second open — no second registration', async () => {
    const { host, views, clientCalls } = setup(CLIENT);
    await host.open();
    const result = await host.open();
    expect(result).toEqual({ ok: true });
    expect(views).toHaveLength(1);
    expect(views[0]!.loaded).toHaveLength(1);
    expect(views[0]!.shown).toBe(2);
    expect(views[0]!.focused).toBe(2);
    expect(clientCalls()).toBe(1);
  });

  it('asks the engine again after the user closed the window', async () => {
    const { host, views, clientCalls } = setup(CLIENT);
    await host.open();
    views[0]!.close();
    const result = await host.open();
    expect(result).toEqual({ ok: true });
    expect(views).toHaveLength(2);
    expect(clientCalls()).toBe(2);
  });

  it('destroys the window on a failed load and retries cleanly', async () => {
    const first = new FakeView();
    const second = new FakeView();
    const made: FakeView[] = [first, second];
    let madeIndex = 0;
    const failing = new MissionControlHost({
      localClient: () => Promise.resolve(CLIENT),
      createView: () => made[madeIndex++] ?? null,
    });
    first.failLoad = new Error('net::ERR_CONNECTION_REFUSED');
    const result = await failing.open();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('net::ERR_CONNECTION_REFUSED');
    expect(first.destroyed).toBe(true);
    // The failed window is forgotten: the next open builds a fresh one
    // and loads it.
    const retry = await failing.open();
    expect(retry).toEqual({ ok: true });
    expect(second.loaded).toEqual(['http://127.0.0.1:8787#token=tok-123']);
  });

  it('dispose closes the window and forgets it', async () => {
    const { host, views } = setup(CLIENT);
    await host.open();
    host.dispose();
    expect(views[0]!.destroyed).toBe(true);
    const result = await host.open();
    expect(result).toEqual({ ok: true });
    expect(views).toHaveLength(2);
  });
});
