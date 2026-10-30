import { describe, expect, it, vi } from 'vitest';
import type { TicketsRemotePort } from '../../shared/remote-protocol';
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
    ticket: vi.fn(async (id: string) => ({ ok: true, card: { id }, text: '# x' })),
    create: vi.fn(ok),
    move: vi.fn(ok),
    reorder: vi.fn(ok),
    unpin: vi.fn(ok),
    claim: vi.fn(ok),
    archive: vi.fn(ok),
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
    expect(remote.move).toHaveBeenCalledWith({ id: 'T-0052', from: 'build', to: 'review', index: null }, 'owner@iphone-15');

    await route(req({ method: 'POST', path: '/api/runs/r-1/answer', authorization: auth, body: { answers: { q0: 'Yes' } } }), deps);
    expect(remote.answer).toHaveBeenCalledWith({ runId: 'r-1', answers: { q0: 'Yes' } });
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
});
