/**
 * Specs for Mission Control's connection layer (E5b): the bearer-headed
 * JSON calls, the pairing exchange, and the `/api/events` follower —
 * framing, reconnect backoff, the visibility fast-reconnect and the
 * 401 give-up. Runs under Node against the fake desk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, McClient, TOKEN_KEY } from './client';
import { FakeDesk } from './fakes';

const stops: (() => void)[] = [];

afterEach(() => {
  while (stops.length > 0) {
    stops.pop()?.();
  }
  vi.useRealTimers();
});

const makeClient = (desk: FakeDesk): McClient => new McClient({ fetch: desk.fetch, storage: desk.storage });

const waitFor = async (check: () => void): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    try {
      check();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  check();
};

describe('McClient token storage', () => {
  it('stores the token under the key the legacy client uses', () => {
    const desk = new FakeDesk();
    const client = makeClient(desk);
    expect(client.token()).toBeNull();
    expect(client.setToken('tok-1')).toBe(true);
    expect(desk.storage.getItem(TOKEN_KEY)).toBe('tok-1');
    expect(client.token()).toBe('tok-1');
    client.clearToken();
    expect(client.token()).toBeNull();
    expect(desk.storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('forgives a storage that throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const client = new McClient({ fetch: new FakeDesk().fetch, storage: blocked });
    expect(client.token()).toBeNull();
    expect(client.setToken('x')).toBe(false);
    expect(() => client.clearToken()).not.toThrow();
  });
});

describe('McClient.request', () => {
  it('sends the bearer header and returns the parsed body', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/board', () => ({ columns: [{ phase: { id: 'inbox' }, tickets: [] }] }));
    desk.storage.setItem(TOKEN_KEY, 'tok-9');
    const client = makeClient(desk);
    const body = await client.request('GET', '/api/board');
    expect(body).toEqual({ columns: [{ phase: { id: 'inbox' }, tickets: [] }] });
    const call = desk.callsOf('GET', '/api/board')[0]!;
    expect(call.headers['Authorization']).toBe('Bearer tok-9');
    expect(call.headers['Content-Type']).toBe('application/json');
  });

  it('sends no bearer header while unpaired', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/board', () => ({ columns: [] }));
    const client = makeClient(desk);
    await client.request('GET', '/api/board');
    expect(desk.callsOf('GET', '/api/board')[0]!.headers['Authorization']).toBeUndefined();
  });

  it('POSTs a JSON body', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/runs', (body) => ({ ok: true, runId: (body as { ticketId: string }).ticketId }));
    const client = makeClient(desk);
    const reply = await client.request('POST', '/api/runs', { ticketId: 'T-1' });
    expect(reply).toEqual({ ok: true, runId: 'T-1' });
    expect(desk.callsOf('POST', '/api/runs')[0]!.body).toEqual({ ticketId: 'T-1' });
  });

  it('throws ApiError with the desk message when the answer is not ok', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/board', () => ({ __status: 403, __body: { ok: false, error: 'this device is paired read-only' } }));
    const client = makeClient(desk);
    const error = await client.request('GET', '/api/board').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: 'this device is paired read-only' });
  });

  it('throws a plain HTTP message when the error body has none', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/board', () => ({ __status: 500, __body: null }));
    const client = makeClient(desk);
    await expect(client.request('GET', '/api/board')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  it('throws ApiError(0) when the desk does not answer', async () => {
    const desk = new FakeDesk();
    const client = new McClient({
      fetch: () => Promise.reject(new Error('refused')),
      storage: desk.storage,
    });
    await expect(client.request('GET', '/api/board')).rejects.toMatchObject({
      status: 0,
      message: 'The desk does not answer.',
    });
  });
});

describe('McClient.pair', () => {
  it('exchanges the code, stores the token and reports ok', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/pair', () => ({ ok: true, token: 'fresh-token', device: { name: 'phone' } }));
    const client = makeClient(desk);
    const reply = await client.pair('1234-5678');
    expect(reply).toEqual({ ok: true, token: 'fresh-token' });
    expect(desk.storage.getItem(TOKEN_KEY)).toBe('fresh-token');
    expect(desk.callsOf('POST', '/api/pair')[0]!.body).toEqual({ code: '1234-5678' });
  });

  it('surfaces a wrong code without storing anything', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/pair', () => ({ __status: 401, __body: { ok: false, error: 'the pairing code is wrong or has expired' } }));
    const client = makeClient(desk);
    const reply = await client.pair('0000-0000');
    expect(reply).toEqual({ ok: false, error: 'the pairing code is wrong or has expired' });
    expect(desk.storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('refuses a pairing answer without a token', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/pair', () => ({ ok: true }));
    const client = makeClient(desk);
    const reply = await client.pair('1234-5678');
    expect(reply.ok).toBe(false);
    expect(desk.storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('surfaces a desk that does not answer', async () => {
    const client = new McClient({ fetch: () => Promise.reject(new Error('down')), storage: new FakeDesk().storage });
    const reply = await client.pair('1234-5678');
    expect(reply).toEqual({ ok: false, error: 'The desk does not answer.' });
  });
});

describe('McClient.listen', () => {
  it('delivers parsed frames and reports the connection', async () => {
    const desk = new FakeDesk();
    const client = makeClient(desk);
    const events: { name: string; data: string }[] = [];
    const states: boolean[] = [];
    stops.push(client.listen({ onEvent: (e) => events.push(e), onState: (c) => states.push(c), onUnauthorized: () => undefined }));
    await waitFor(() => expect(desk.eventsOpen).toBe(true));

    desk.pushRaw('event: board\ndata: {}\n\n');
    desk.pushEvent('chat', { file: 'f.md', event: { kind: 'text', text: 'hi' } });
    desk.pushRaw(': ping\n\nretry: 3000\n\n');
    await waitFor(() => expect(events.length).toBe(2));

    expect(events[0]).toEqual({ name: 'board', data: '{}' });
    expect(events[1]).toEqual({ name: 'chat', data: '{"file":"f.md","event":{"kind":"text","text":"hi"}}' });
    expect(states).toEqual([true]);
  });

  it('assembles a frame split across chunks', async () => {
    const desk = new FakeDesk();
    const client = makeClient(desk);
    const events: { name: string; data: string }[] = [];
    stops.push(client.listen({ onEvent: (e) => events.push(e), onState: () => undefined, onUnauthorized: () => undefined }));
    await waitFor(() => expect(desk.eventsOpen).toBe(true));

    desk.pushRaw('event: bo');
    desk.pushRaw('ard\ndata: {"a"');
    desk.pushRaw(':1}\n\n');
    await waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ name: 'board', data: '{"a":1}' });
  });

  it('reconnects with a growing backoff while the desk keeps failing', async () => {
    vi.useFakeTimers();
    const desk = new FakeDesk();
    const client = makeClient(desk);
    const states: boolean[] = [];
    stops.push(client.listen({ onEvent: () => undefined, onState: (c) => states.push(c), onUnauthorized: () => undefined }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(desk.callsOf('GET', '/api/events').length).toBe(1);
    expect(desk.eventsOpen).toBe(true);

    // First drop: the reconnect waits 1s.
    desk.endEvents();
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(998);
    expect(desk.callsOf('GET', '/api/events').length).toBe(1);

    // 1s elapsed: the reconnect finds a desk that keeps failing.
    desk.eventsStatus = 500;
    await vi.advanceTimersByTimeAsync(1);
    expect(desk.callsOf('GET', '/api/events').length).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(desk.callsOf('GET', '/api/events').length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(desk.callsOf('GET', '/api/events').length).toBe(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(desk.callsOf('GET', '/api/events').length).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(desk.callsOf('GET', '/api/events').length).toBe(4);

    // A working desk answers again — the backoff resets.
    desk.eventsStatus = null;
    await vi.advanceTimersByTimeAsync(8000);
    expect(desk.eventsOpen).toBe(true);
    expect(states).toEqual([true, false, false, false, false, true]);
  });

  it('gives up with onUnauthorized when the desk answers 401', async () => {
    vi.useFakeTimers();
    const desk = new FakeDesk();
    const client = makeClient(desk);
    let unauthorized = 0;
    stops.push(client.listen({ onEvent: () => undefined, onState: () => undefined, onUnauthorized: () => unauthorized++ }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(desk.eventsOpen).toBe(true);

    desk.endEvents();
    await vi.advanceTimersByTimeAsync(1);
    desk.eventsStatus = 401;
    await vi.advanceTimersByTimeAsync(1000);
    expect(unauthorized).toBe(1);
    const count = desk.callsOf('GET', '/api/events').length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(desk.callsOf('GET', '/api/events').length).toBe(count);
  });

  it('reconnects at once when the document returns to visibility', async () => {
    vi.useFakeTimers();
    const desk = new FakeDesk();
    const client = makeClient(desk);
    stops.push(client.listen({ onEvent: () => undefined, onState: () => undefined, onUnauthorized: () => undefined }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(desk.callsOf('GET', '/api/events').length).toBe(1);

    // The stream drops; the client is now in the backoff sleep.
    desk.endEvents();
    await vi.advanceTimersByTimeAsync(1);
    expect(desk.callsOf('GET', '/api/events').length).toBe(1);

    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    if (original !== undefined) {
      Object.defineProperty(document, 'visibilityState', original);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(desk.callsOf('GET', '/api/events').length).toBe(2);
  });

  it('stops fetching after stop()', async () => {
    vi.useFakeTimers();
    const desk = new FakeDesk();
    const client = makeClient(desk);
    const states: boolean[] = [];
    const stop = client.listen({ onEvent: () => undefined, onState: (c) => states.push(c), onUnauthorized: () => undefined });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(desk.eventsOpen).toBe(true);
    stop();

    desk.endEvents();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(desk.callsOf('GET', '/api/events').length).toBe(1);
    expect(states).toEqual([true]);
  });
});
