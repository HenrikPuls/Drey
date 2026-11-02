import { describe, expect, it, vi } from 'vitest';
import type { TicketsRemotePort } from '../contracts/remote-protocol';
import { DeviceRegistry, FailureLimiter, PairingCodes } from './auth';
import { route, type RemoteRequest, type RouterDeps } from './router';

/**
 * req-66: the gateway's API rules — Host and Origin first, pairing,
 * bearer auth with the failure limit, read-only devices, and the actor
 * and ids handed to the port.
 */

const HOST = '127.0.0.1:47811';

function port(): TicketsRemotePort {
  const ok = async () => ({ ok: true });
  return {
    board: vi.fn(async () => ({ columns: [] })),
    fleet: vi.fn(async () => ({ runs: [], chain: null })),
    needs: vi.fn(async () => []),
    personas: vi.fn(async () => []),
    personaImprovements: vi.fn(async () => ({ ok: true, persona: { id: 'pia' }, proposals: [], openCount: 0, frictionCount: 0 })),
    personaImprovementDecide: vi.fn(ok),
    ticketSave: vi.fn(async () => ({ ok: true, revision: '0123456789abcdef' })),
    ticketAccept: vi.fn(ok),
    ticketSendBack: vi.fn(ok),
    ticketWorktreeChanges: vi.fn(async () => []),
    ticketDiff: vi.fn(async () => ({ files: [], truncated: false })),
    ticket: vi.fn(async (id: string) => ({ ok: true, card: { id }, text: '# x' })),
    create: vi.fn(ok),
    move: vi.fn(ok),
    claim: vi.fn(ok),
    archive: vi.fn(ok),
    refine: vi.fn(ok),
    saveAttachment: vi.fn(async () => ({ ok: true, file: 'tickets/attachments/img-test.png' })),
    startRun: vi.fn(ok),
    stopRun: vi.fn(ok),
    send: vi.fn(ok),
    answer: vi.fn(ok),
    permission: vi.fn(ok),
    stream: vi.fn(async () => 'line'),
    chainMaster: vi.fn(ok),
    chainColumn: vi.fn(ok),
    chainColumnStop: vi.fn(ok),
    chainAbort: vi.fn(ok),
    chatSessions: vi.fn(async () => []),
    chatOpen: vi.fn(async () => null),
    chatSend: vi.fn(ok),
    chatStart: vi.fn(ok),
    chatConfirm: vi.fn(ok),
    chatDismiss: vi.fn(ok),
    onChanged: () => () => undefined,
  } as unknown as TicketsRemotePort;
}

function setup(): { deps: RouterDeps; pairing: PairingCodes; devices: DeviceRegistry; remote: TicketsRemotePort } {
  const pairing = new PairingCodes();
  const devices = new DeviceRegistry([], async () => undefined);
  const remote = port();
  const deps: RouterDeps = {
    port: remote,
    devices,
    pairing,
    limiter: new FailureLimiter(3, 60_000),
    allowedHosts: () => new Set([HOST]),
    now: () => new Date('2026-10-30T10:00:00Z'),
    log: () => undefined,
    onPaired: () => undefined,
  };
  return { deps, pairing, devices, remote };
}

const req = (patch: Partial<RemoteRequest>): RemoteRequest => ({
  method: 'GET',
  path: '/api/health',
  host: HOST,
  origin: undefined,
  authorization: undefined,
  body: undefined,
  remote: '127.0.0.1',
  ...patch,
});

describe('route', () => {
  it('answers health without auth, and refuses a foreign Host first', async () => {
    const { deps } = setup();
    expect(await route(req({}), deps)).toEqual({ status: 200, body: { ok: true, version: 1 } });
    expect((await route(req({ host: 'evil.example' }), deps)).status).toBe(421);
  });

  it('pairs with the current code once and hands out a working token', async () => {
    const { deps, pairing } = setup();
    const onPaired = vi.fn();
    const code = pairing.issue('iPad', false, deps.now().getTime()).code;
    const paired = await route(req({ method: 'POST', path: '/api/pair', body: { code } }), { ...deps, onPaired });
    expect(paired.status).toBe(200);
    const token = (paired.body as { token: string }).token;
    expect(onPaired).toHaveBeenCalledOnce();
    expect((await route(req({ method: 'POST', path: '/api/pair', body: { code } }), deps)).status).toBe(401);

    const me = await route(req({ path: '/api/me', authorization: `Bearer ${token}` }), deps);
    expect(me.body).toMatchObject({ ok: true, actor: 'owner@ipad', device: { name: 'iPad' } });
  });

  it('refuses unpaired requests and blocks the address after repeated failures', async () => {
    const { deps } = setup();
    for (let i = 0; i < 3; i++) {
      expect((await route(req({ path: '/api/board', authorization: 'Bearer nonsense-token-of-length-x' }), deps)).status).toBe(401);
    }
    expect((await route(req({ path: '/api/board' }), deps)).status).toBe(429);
  });

  it('refuses a write from another site and from a read-only device', async () => {
    const { deps, devices } = setup();
    const { token } = await devices.add('Viewer', true, new Date());
    const auth = `Bearer ${token}`;
    const foreign = await route(req({ method: 'POST', path: '/api/chain/abort', origin: 'http://evil.example', authorization: auth }), deps);
    expect(foreign.status).toBe(403);
    const readOnly = await route(req({ method: 'POST', path: '/api/chain/abort', origin: `http://${HOST}`, authorization: auth }), deps);
    expect(readOnly).toEqual({ status: 403, body: { ok: false, error: 'this device is paired read-only' } });
    expect((await route(req({ path: '/api/needs', authorization: auth }), deps)).status).toBe(200);
    expect((await route(req({ path: '/api/personas', authorization: auth }), deps)).status).toBe(200);
  });

  it('hands the ticket id from the path and the device actor to the port', async () => {
    const { deps, devices, remote } = setup();
    const { token } = await devices.add('iPhone 15', false, new Date());
    const auth = `Bearer ${token}`;
    const moved = await route(
      req({ method: 'POST', path: '/api/tickets/T-0052/move', authorization: auth, body: { id: 'T-9999', from: 'build', to: 'review' } }),
      deps,
    );
    expect(moved).toEqual({ status: 200, body: { ok: true } });
    expect(remote.move).toHaveBeenCalledWith({ id: 'T-0052', from: 'build', to: 'review' }, 'owner@iphone-15');

    await route(req({ method: 'POST', path: '/api/runs/r-1/answer', authorization: auth, body: { answers: { q0: 'Yes' } } }), deps);

    await route(
      req({ method: 'POST', path: '/api/tickets/T-0052/refine', authorization: auth, body: { baseRevision: '0123456789abcdef', sections: { plan: 'P' } } }),
      deps,
    );
    expect(remote.refine).toHaveBeenCalledWith(
      { id: 'T-0052', baseRevision: '0123456789abcdef', sections: { plan: 'P' }, header: {} },
      'owner@iphone-15',
    );
    expect(remote.answer).toHaveBeenCalledWith({ runId: 'r-1', answers: { q0: 'Yes' } });
  });

  it('routes the E5c ticket screen: save, accept, send-back, diff and worktree-changes', async () => {
    const { deps, devices, remote } = setup();
    const { token } = await devices.add('iPhone 15', false, new Date());
    const auth = `Bearer ${token}`;

    const saved = await route(
      req({ method: 'POST', path: '/api/tickets/T-0052/save', authorization: auth, body: { text: '---\nid: T-0052\n---\n', baseRevision: 'abc' } }),
      deps,
    );
    expect(saved.status).toBe(200);
    expect(remote.ticketSave).toHaveBeenCalledWith({ id: 'T-0052', text: '---\nid: T-0052\n---\n', baseRevision: 'abc' }, 'owner@iphone-15');

    await route(req({ method: 'POST', path: '/api/tickets/T-0052/accept', authorization: auth }), deps);
    expect(remote.ticketAccept).toHaveBeenCalledWith({ id: 'T-0052' }, 'owner@iphone-15');

    const silent = await route(req({ method: 'POST', path: '/api/tickets/T-0052/send-back', authorization: auth, body: {} }), deps);
    expect(silent.body).toEqual({ ok: false, error: 'a send-back needs a note' });
    await route(req({ method: 'POST', path: '/api/tickets/T-0052/send-back', authorization: auth, body: { note: 'The button still misaligns' } }), deps);
    expect(remote.ticketSendBack).toHaveBeenCalledWith({ id: 'T-0052', note: 'The button still misaligns' }, 'owner@iphone-15');

    expect((await route(req({ path: '/api/tickets/T-0052/diff', authorization: auth }), deps)).status).toBe(200);
    expect(remote.ticketDiff).toHaveBeenCalledWith('T-0052');
    expect((await route(req({ path: '/api/tickets/T-0052/worktree-changes', authorization: auth }), deps)).status).toBe(200);
    expect(remote.ticketWorktreeChanges).toHaveBeenCalledWith('T-0052');
  });

  it('a refused command is a 200 with ok:false; unknown ids and routes are 404', async () => {
    const { deps, devices } = setup();
    const { token } = await devices.add('p', false, new Date());
    const auth = `Bearer ${token}`;
    expect(await route(req({ method: 'POST', path: '/api/tickets/T-0001/claim', authorization: auth, body: { mode: 'steal' } }), deps)).toEqual({
      status: 200,
      body: { ok: false, error: 'bad claim payload' },
    });
    expect((await route(req({ method: 'POST', path: '/api/tickets/..%2Fx/move', authorization: auth }), deps)).status).toBe(404);
    expect((await route(req({ path: '/api/nope', authorization: auth }), deps)).status).toBe(404);
    expect((await route(req({ path: '/api/tickets/notes.md', authorization: auth }), deps)).status).toBe(404);
    expect((await route(req({ path: '/api/tickets/T-0007', authorization: auth }), deps)).body).toMatchObject({ ok: true, card: { id: 'T-0007' } });
  });

  it('uploads an attachment with the device actor, refuses bad bytes, and stays behind auth', async () => {
    const { deps, devices, remote } = setup();
    const { token } = await devices.add('iPhone', false, new Date());
    const auth = `Bearer ${token}`;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await route(
      req({ method: 'POST', path: '/api/attachments', origin: `http://${HOST}`, authorization: auth, body: { dataBase64: png.toString('base64') } }),
      deps,
    );
    expect(uploaded).toEqual({ status: 200, body: { ok: true, file: 'tickets/attachments/img-test.png' } });
    expect(remote.saveAttachment).toHaveBeenCalledWith({ bytes: png, ext: 'png' }, 'owner@iphone');

    const refused = await route(
      req({ method: 'POST', path: '/api/attachments', origin: `http://${HOST}`, authorization: auth, body: { dataBase64: Buffer.from('text').toString('base64') } }),
      deps,
    );
    expect(refused).toEqual({ status: 200, body: { ok: false, error: 'the file is not a PNG, JPEG, GIF or WebP image' } });
    expect((await route(req({ method: 'POST', path: '/api/attachments', origin: `http://${HOST}` }), deps)).status).toBe(401);
  });

  it('routes the chat surface for a paired device — reads for all, writes refused for read-only', async () => {
    const { deps, devices, remote } = setup();
    const { token } = await devices.add('iPhone', false, new Date());
    const auth = `Bearer ${token}`;
    const origin = `http://${HOST}`;
    const file = 'tickets/_meta/chat/20261102-090000-demo.md';

    expect((await route(req({ path: '/api/chat/sessions', authorization: auth }), deps)).status).toBe(200);

    const opened = await route(req({ path: `/api/chat/sessions/${file}`, authorization: auth }), deps);
    expect(opened.status).toBe(200);
    expect(remote.chatOpen).toHaveBeenCalledWith(file);

    const started = await route(req({ method: 'POST', path: '/api/chat/sessions', origin, authorization: auth, body: { title: 'Hi', text: 'Hello there' } }), deps);
    expect(started.status).toBe(200);
    expect(remote.chatStart).toHaveBeenCalledWith({ title: 'Hi', text: 'Hello there' });

    await route(req({ method: 'POST', path: `/api/chat/sessions/${file}/messages`, origin, authorization: auth, body: { text: 'And more' } }), deps);
    expect(remote.chatSend).toHaveBeenCalledWith({ file, text: 'And more' });

    await route(req({ method: 'POST', path: `/api/chat/sessions/${file}/proposals/p-1/confirm`, origin, authorization: auth }), deps);
    expect(remote.chatConfirm).toHaveBeenCalledWith({ file, id: 'p-1' });
    await route(req({ method: 'POST', path: `/api/chat/sessions/${file}/proposals/p-1/dismiss`, origin, authorization: auth }), deps);
    expect(remote.chatDismiss).toHaveBeenCalledWith({ file, id: 'p-1' });

    // A session file outside tickets/_meta/chat/ is not a route; a blank
    // message is a refused command, not a transport error.
    expect((await route(req({ path: '/api/chat/sessions/tickets/evil.md', authorization: auth }), deps)).status).toBe(404);
    expect(await route(req({ method: 'POST', path: '/api/chat/sessions', origin, authorization: auth, body: { text: '  ' } }), deps)).toEqual({
      status: 200,
      body: { ok: false, error: 'a chat start needs text' },
    });

    const { token: ro } = await devices.add('Viewer', true, new Date());
    const readOnly = await route(req({ method: 'POST', path: '/api/chat/sessions', origin, authorization: `Bearer ${ro}`, body: { text: 'Hi' } }), deps);
    expect(readOnly).toEqual({ status: 403, body: { ok: false, error: 'this device is paired read-only' } });
    expect((await route(req({ path: '/api/chat/sessions', authorization: `Bearer ${ro}` }), deps)).status).toBe(200);
  });

  it('routes the E6 improvements card: GET for every device, apply/dismiss POSTs with pinned ids', async () => {
    const { deps, devices, remote } = setup();
    const { token } = await devices.add('iPhone 15', false, new Date());
    const auth = `Bearer ${token}`;
    const origin = `http://${HOST}`;

    const listed = await route(req({ path: '/api/personas/pia/improvements', authorization: auth }), deps);
    expect(listed.status).toBe(200);
    expect(remote.personaImprovements).toHaveBeenCalledWith('pia');

    await route(req({ method: 'POST', path: '/api/personas/pia/improvements/imp-1/apply', origin, authorization: auth }), deps);
    expect(remote.personaImprovementDecide).toHaveBeenCalledWith({ persona: 'pia', proposal: 'imp-1', decision: 'accepted' });
    await route(req({ method: 'POST', path: '/api/personas/pia/improvements/imp-2/dismiss', origin, authorization: auth }), deps);
    expect(remote.personaImprovementDecide).toHaveBeenCalledWith({ persona: 'pia', proposal: 'imp-2', decision: 'dismissed' });

    // Both ids are pinned by their grammars before the port sees them;
    // a read-only device gets the usual 403 on the POST.
    expect((await route(req({ path: '/api/personas/Pia%2Fx/improvements', authorization: auth }), deps)).status).toBe(404);
    expect((await route(req({ method: 'POST', path: '/api/personas/pia/improvements/1/apply', origin, authorization: auth }), deps)).status).toBe(404);
    expect((await route(req({ method: 'POST', path: '/api/personas/pia/improvements/imp-1/nope', origin, authorization: auth }), deps)).status).toBe(404);
    const { token: ro } = await devices.add('Viewer', true, new Date());
    const readOnly = await route(req({ method: 'POST', path: '/api/personas/pia/improvements/imp-1/apply', origin, authorization: `Bearer ${ro}` }), deps);
    expect(readOnly).toEqual({ status: 403, body: { ok: false, error: 'this device is paired read-only' } });
    expect((await route(req({ path: '/api/personas/pia/improvements', authorization: `Bearer ${ro}` }), deps)).status).toBe(200);
  });
});
