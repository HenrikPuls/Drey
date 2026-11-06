/**
 * Specs for Mission Control's connection layer (E5b): the bearer-headed
 * JSON calls, the pairing exchange, and the `/api/events` follower —
 * framing, reconnect backoff, the visibility fast-reconnect and the
 * 401 give-up. Runs under Node against the fake desk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, bootHintsFromHash, McClient, TOKEN_KEY } from './client';
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

describe('boot hints', () => {
  it('reads the pairing code from a #pair hash', () => {
    expect(bootHintsFromHash('#pair=1234-5678')).toEqual({ pairCode: '1234-5678', token: null });
  });

  it('reads the bearer token from a #token hash', () => {
    expect(bootHintsFromHash('#token=aZ_9-x.Q~+')).toEqual({ pairCode: null, token: 'aZ_9-x.Q~+' });
    expect(bootHintsFromHash('#token=abc==')).toEqual({ pairCode: null, token: 'abc==' });
  });

  it('yields none for an empty or foreign hash', () => {
    expect(bootHintsFromHash('')).toEqual({ pairCode: null, token: null });
    expect(bootHintsFromHash('#section-2')).toEqual({ pairCode: null, token: null });
    expect(bootHintsFromHash('#token=')).toEqual({ pairCode: null, token: null });
    expect(bootHintsFromHash('#pair=12 34')).toEqual({ pairCode: null, token: null });
  });
});

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

describe('McClient.raw', () => {
  it('returns the parsed JSON body', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/tickets/T-1/diff', () => ({ files: [{ status: 'M', path: 'a.ts', patch: '+x' }], truncated: false }));
    const client = makeClient(desk);
    const body = await client.raw('/api/tickets/T-1/diff');
    expect(body).toEqual({ files: [{ status: 'M', path: 'a.ts', patch: '+x' }], truncated: false });
    expect(desk.callsOf('GET', '/api/tickets/T-1/diff')[0]!.headers['Authorization']).toBeUndefined();
  });

  it('returns null instead of throwing on a failed GET', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/tickets/T-1/diff', () => ({ __status: 404, __body: { ok: false, error: 'no such ticket' } }));
    const client = makeClient(desk);
    expect(await client.raw('/api/tickets/T-1/diff')).toBeNull();
  });

  it('returns null when the desk does not answer', async () => {
    const client = new McClient({ fetch: () => Promise.reject(new Error('down')), storage: new FakeDesk().storage });
    expect(await client.raw('/api/tickets/T-1/diff')).toBeNull();
  });
});

describe('McClient.attachment', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('fetches the bytes with the bearer and hands the blob to the object-URL seam', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/attachments/shot.png', () => ({ __bytes: PNG, __contentType: 'image/png' }));
    desk.storage.setItem(TOKEN_KEY, 'tok-9');
    let seen: Blob | null = null;
    const client = new McClient({
      fetch: desk.fetch,
      storage: desk.storage,
      createObjectUrl: (blob) => {
        seen = blob;
        return 'blob:fake-1';
      },
    });
    const url = await client.attachment('shot.png');
    expect(url).toBe('blob:fake-1');
    const call = desk.callsOf('GET', '/api/attachments/shot.png')[0]!;
    expect(call.headers['Authorization']).toBe('Bearer tok-9');
    expect(call.headers['Content-Type']).toBeUndefined();
    expect(new Uint8Array(await seen!.arrayBuffer())).toEqual(PNG);
  });

  it('sends no bearer header while unpaired', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/attachments/shot.png', () => ({ __bytes: PNG }));
    const client = new McClient({ fetch: desk.fetch, storage: desk.storage, createObjectUrl: () => 'blob:fake-2' });
    await client.attachment('shot.png');
    expect(desk.callsOf('GET', '/api/attachments/shot.png')[0]!.headers['Authorization']).toBeUndefined();
  });

  it('throws ApiError when the desk has no such attachment', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/attachments/missing.png', () => ({ __status: 404, __body: { ok: false, error: 'no such attachment' } }));
    const client = new McClient({ fetch: desk.fetch, storage: desk.storage, createObjectUrl: () => 'blob:fake-3' });
    const error = await client.attachment('missing.png').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: 'no such attachment' });
  });

  it('surfaces a desk that does not answer', async () => {
    const client = new McClient({
      fetch: () => Promise.reject(new Error('refused')),
      storage: new FakeDesk().storage,
      createObjectUrl: () => 'blob:fake-4',
    });
    await expect(client.attachment('shot.png')).rejects.toMatchObject({ status: 0, message: 'The desk does not answer.' });
  });

  it('returns null where the platform cannot create object URLs', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/attachments/shot.png', () => ({ __bytes: PNG }));
    const client = new McClient({ fetch: desk.fetch, storage: desk.storage, createObjectUrl: () => null });
    expect(await client.attachment('shot.png')).toBeNull();
  });

  it('release revokes through the seam', async () => {
    const revoked: string[] = [];
    const desk = new FakeDesk();
    const client = new McClient({ fetch: desk.fetch, storage: desk.storage, revokeObjectUrl: (url) => revoked.push(url) });
    client.release('blob:fake-9');
    expect(revoked).toEqual(['blob:fake-9']);
  });
});

describe('McClient.uploadAttachments', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PNG_B64 = btoa(String.fromCharCode(...PNG));

  const pngFile = (name = 'shot.png'): File => new File([PNG], name, { type: 'image/png' });

  it('POSTs one JSON body per file — { dataBase64 } with the bearer — and returns the stored paths', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/attachments', () => ({ ok: true, file: 'tickets/attachments/img-x.png' }));
    desk.storage.setItem(TOKEN_KEY, 'tok-9');
    const client = makeClient(desk);
    const reply = await client.uploadAttachments([pngFile()]);
    expect(reply).toEqual({ ok: true, stored: ['tickets/attachments/img-x.png'] });
    const call = desk.callsOf('POST', '/api/attachments')[0]!;
    expect(call.headers['Authorization']).toBe('Bearer tok-9');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({ dataBase64: PNG_B64 });
  });

  it('uploads several files in order, one request each', async () => {
    const desk = new FakeDesk();
    let nth = 0;
    desk.on('POST', '/api/attachments', () => ({ ok: true, file: `tickets/attachments/img-${++nth}.png` }));
    const client = makeClient(desk);
    const reply = await client.uploadAttachments([pngFile('a.png'), pngFile('b.jpeg')]);
    expect(reply).toEqual({ ok: true, stored: ['tickets/attachments/img-1.png', 'tickets/attachments/img-2.png'] });
    expect(desk.callsOf('POST', '/api/attachments').length).toBe(2);
  });

  it('returns ok with nothing stored for an empty pick, without a request', async () => {
    const desk = new FakeDesk();
    const client = makeClient(desk);
    expect(await client.uploadAttachments([])).toEqual({ ok: true, stored: [] });
    expect(desk.calls.length).toBe(0);
  });

  it('surfaces the desk’s refusal — a non-image — without storing', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/attachments', () => ({
      __status: 400,
      __body: { ok: false, error: 'the file is not a PNG, JPEG, GIF or WebP image' },
    }));
    const client = makeClient(desk);
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'brief.pdf', { type: 'application/pdf' });
    expect(await client.uploadAttachments([pdf])).toEqual({
      ok: false,
      error: 'the file is not a PNG, JPEG, GIF or WebP image',
    });
  });

  it('stops at the first failure — the earlier files stay stored, the error surfaces', async () => {
    const desk = new FakeDesk();
    let nth = 0;
    desk.on('POST', '/api/attachments', () =>
      nth++ === 0
        ? { ok: true, file: 'tickets/attachments/img-1.png' }
        : { __status: 400, __body: { ok: false, error: 'the image is larger than 6 MB' } },
    );
    const client = makeClient(desk);
    const reply = await client.uploadAttachments([pngFile('a.png'), pngFile('b.png')]);
    expect(reply).toEqual({ ok: false, error: 'the image is larger than 6 MB' });
    expect(desk.callsOf('POST', '/api/attachments').length).toBe(2);
  });

  it('refuses an oversized file without a request', async () => {
    const desk = new FakeDesk();
    const client = makeClient(desk);
    const big = new File([new Uint8Array(6 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    expect(await client.uploadAttachments([big])).toEqual({ ok: false, error: 'the image is larger than 6 MB' });
    expect(desk.calls.length).toBe(0);
  });

  it('surfaces a desk that does not answer', async () => {
    const client = new McClient({ fetch: () => Promise.reject(new Error('refused')), storage: new FakeDesk().storage });
    expect(await client.uploadAttachments([pngFile()])).toEqual({ ok: false, error: 'The desk does not answer.' });
  });

  it('reports a 200 answer that stored nothing', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/attachments', () => ({ ok: true }));
    const client = makeClient(desk);
    expect(await client.uploadAttachments([pngFile()])).toEqual({ ok: false, error: 'the desk stored no attachment' });
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

describe('ApiError keeps the code of the desk (req-101)', () => {
  it('carries the body code, and null when the body has none', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/notes', () => ({ __status: 404, __body: { ok: false, code: 'no_vault', error: 'gone' } }));
    desk.on('GET', '/api/board', () => ({ __status: 500, __body: { ok: false, error: 'boom' } }));
    const client = makeClient(desk);
    const withCode = await client.request('GET', '/api/notes').catch((caught: unknown) => caught);
    expect(withCode).toMatchObject({ status: 404, code: 'no_vault', message: 'gone' });
    const without = await client.request('GET', '/api/board').catch((caught: unknown) => caught);
    expect((without as ApiError).code).toBeNull();
  });
});

describe('the Notes calls (req-101)', () => {
  it('GETs the folder, recent and search with encoded parameters', async () => {
    const desk = new FakeDesk();
    desk.on('GET', '/api/notes', () => ({ ok: true, vault: 'V', folder: '', folders: [], notes: [] }));
    desk.on('GET', '/api/notes?folder=a%20b%2Fc', () => ({ ok: true, vault: 'V', folder: 'a b/c', folders: [], notes: [] }));
    desk.on('GET', '/api/notes/recent?limit=8', () => ({ ok: true, vault: 'V', notes: [] }));
    desk.on('GET', '/api/notes/search?q=big%20idea&limit=30', () => ({ ok: true, query: 'big idea', hits: [], truncated: false }));
    desk.on('GET', '/api/notes/note?path=a%20b%2Fx.md', () => ({ ok: true, path: 'a b/x.md', name: 'x', text: 't', body: 't', tags: [], mtime: 1 }));
    const client = makeClient(desk);
    expect((await client.notesList()).ok).toBe(true);
    expect(await client.notesList('a b/c')).toMatchObject({ ok: true, folder: 'a b/c' });
    expect((await client.notesRecent()).ok).toBe(true);
    expect(await client.notesSearch('big idea')).toMatchObject({ query: 'big idea' });
    expect(await client.notesRead('a b/x.md')).toMatchObject({ ok: true, mtime: 1 });
  });

  it('saves with the read mtime as baseMtime and passes a 200 conflict through', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/notes/note', () => ({ ok: false, code: 'conflict', error: 'changed', disk: { text: 'D', mtime: 9 } }));
    const client = makeClient(desk);
    const reply = await client.notesSave('x.md', 'T', 5);
    expect(desk.callsOf('POST', '/api/notes/note')[0]!.body).toEqual({ path: 'x.md', text: 'T', baseMtime: 5 });
    expect(reply).toMatchObject({ ok: false, code: 'conflict', disk: { text: 'D', mtime: 9 } });
  });

  it('creates a note with POST /api/notes', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/notes', () => ({ ok: true, path: 'n.md', text: '', mtime: 3 }));
    const client = makeClient(desk);
    expect(await client.notesCreate('n.md')).toMatchObject({ ok: true, path: 'n.md' });
    expect(desk.callsOf('POST', '/api/notes')[0]!.body).toEqual({ path: 'n.md', text: '' });
  });

  it('turns a refusal into a value with its code and an unreachable desk into offline', async () => {
    const desk = new FakeDesk();
    desk.on('POST', '/api/notes/note', () => ({ __status: 403, __body: { ok: false, code: 'read_only', error: 'ro' } }));
    const client = makeClient(desk);
    expect(await client.notesSave('x.md', 'T', 1)).toEqual({ ok: false, code: 'read_only', error: 'ro' });
    const dead = new McClient({ fetch: async () => { throw new Error('down'); }, storage: desk.storage });
    expect(await dead.notesList()).toMatchObject({ ok: false, code: 'offline' });
  });
});
