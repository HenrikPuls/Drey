import { describe, expect, it } from 'vitest';
import { DeviceRegistry, FailureLimiter, PairingCodes, PAIRING_TTL_MS } from './auth';
import { route, type PairingAccess, type PairingReply, type RemoteRequest, type RouterDeps } from './router';
import type { TicketsRemotePort } from '../contracts/remote-protocol';

const HOST = 'desk.test';
const T0 = Date.parse('2026-11-04T10:00:00Z');

const req = (patch: Partial<RemoteRequest>): RemoteRequest => ({
  method: 'POST',
  path: '/api/pairing/start',
  host: HOST,
  origin: undefined,
  authorization: undefined,
  body: {},
  remote: '127.0.0.1',
  ...patch,
});

/** The router over the real registry and codes; the access mirrors RemoteService's. */
async function setup(): Promise<{ deps: RouterDeps; full: string; viewer: string; codes: PairingCodes; devices: DeviceRegistry; clock: { now: number }; logs: string[] }> {
  const clock = { now: T0 };
  const logs: string[] = [];
  const devices = new DeviceRegistry([], async () => undefined);
  const codes = new PairingCodes();
  const { token: full } = await devices.add('iPad', false, new Date(T0));
  const { token: viewer } = await devices.add('Viewer', true, new Date(T0));
  const view = (): PairingReply => {
    const p = codes.current(clock.now);
    return {
      ok: true,
      needsPublicUrl: false,
      pairing:
        p === null
          ? null
          : {
              code: p.code,
              url: `https://desk.test/#pair=${p.code}`,
              deviceName: p.deviceName,
              readOnly: p.readOnly,
              expiresAt: new Date(p.expiresAt).toISOString(),
              qr: ['101', '010', '101'],
            },
    };
  };
  const pairingAccess: PairingAccess = {
    current: view,
    start: (name, readOnly) => {
      codes.issue(name === '' ? 'Phone' : name, readOnly, clock.now);
      return view();
    },
    cancel: () => {
      codes.cancel();
      return view();
    },
  };
  const deps: RouterDeps = {
    port: {} as unknown as TicketsRemotePort,
    devices,
    pairing: codes,
    limiter: new FailureLimiter(3, 60_000),
    allowedHosts: () => new Set([HOST]),
    now: () => new Date(clock.now),
    log: (m) => void logs.push(m),
    onPaired: () => undefined,
    pairingAccess,
  };
  return { deps, full: `Bearer ${full}`, viewer: `Bearer ${viewer}`, codes, devices, clock, logs };
}

describe('pairing from a paired device (D-2)', () => {
  it('starts a pairing, a second client pairs with the code, the new device is listed', async () => {
    const { deps, full, devices, logs } = await setup();
    const started = await route(req({ authorization: full, body: { name: ' Pia’s phone ', readOnly: false } }), deps);
    expect(started.status).toBe(200);
    const body = started.body as PairingReply;
    expect(body.pairing).toMatchObject({ deviceName: 'Pia’s phone', readOnly: false });
    expect(body.pairing!.code).toMatch(/^[0-9A-Z]{10}$/);
    // The engine log says who started it.
    expect(logs.some((m) => m.includes('iPad') && m.includes('pairing started for "Pia’s phone"'))).toBe(true);

    const paired = await route(req({ path: '/api/pair', body: { code: body.pairing!.code } }), deps);
    expect(paired.status).toBe(200);
    expect(devices.list().map((d) => d.name)).toEqual(['iPad', 'Viewer', 'Pia’s phone']);
    // The code is used up: the pending pairing is gone and a second use fails.
    expect(((await route(req({ method: 'GET', path: '/api/pairing', authorization: full, body: undefined }), deps)).body as PairingReply).pairing).toBeNull();
    expect((await route(req({ path: '/api/pair', body: { code: body.pairing!.code } }), deps)).status).toBe(401);
  });

  it('pairs read-only when asked, and falls back to the default name', async () => {
    const { deps, full, devices } = await setup();
    const started = (await route(req({ authorization: full, body: { readOnly: true } }), deps)).body as PairingReply;
    expect(started.pairing).toMatchObject({ deviceName: 'Phone', readOnly: true });
    await route(req({ path: '/api/pair', body: { code: started.pairing!.code } }), deps);
    expect(devices.list().at(-1)).toMatchObject({ name: 'Phone', readOnly: true });
  });

  it('refuses a read-only device: start, cancel and even looking at the waiting code', async () => {
    const { deps, viewer, full, codes, clock } = await setup();
    codes.issue('Waiting', false, clock.now);
    expect((await route(req({ authorization: viewer }), deps)).status).toBe(403);
    expect((await route(req({ path: '/api/pairing/cancel', authorization: viewer }), deps)).status).toBe(403);
    expect((await route(req({ method: 'GET', path: '/api/pairing', authorization: viewer, body: undefined }), deps)).status).toBe(403);
    // Nothing changed: the waiting pairing is still there for a device that may see it.
    expect(((await route(req({ method: 'GET', path: '/api/pairing', authorization: full, body: undefined }), deps)).body as PairingReply).pairing?.deviceName).toBe('Waiting');
  });

  it('needs a bearer token and a bad payload is refused', async () => {
    const { deps, full } = await setup();
    expect((await route(req({}), deps)).status).toBe(401);
    expect((await route(req({ authorization: full, body: { name: 5 } }), deps)).body).toMatchObject({ ok: false });
    expect((await route(req({ authorization: full, body: { readOnly: 'yes' } }), deps)).body).toMatchObject({ ok: false });
  });

  it('cancels, and the code expires after its time to live', async () => {
    const { deps, full, clock } = await setup();
    await route(req({ authorization: full, body: { name: 'A' } }), deps);
    const cancelled = await route(req({ path: '/api/pairing/cancel', authorization: full }), deps);
    expect((cancelled.body as PairingReply).pairing).toBeNull();

    const again = (await route(req({ authorization: full, body: { name: 'B' } }), deps)).body as PairingReply;
    clock.now += PAIRING_TTL_MS - 1;
    expect(((await route(req({ method: 'GET', path: '/api/pairing', authorization: full, body: undefined }), deps)).body as PairingReply).pairing).not.toBeNull();
    clock.now += 1;
    expect(((await route(req({ method: 'GET', path: '/api/pairing', authorization: full, body: undefined }), deps)).body as PairingReply).pairing).toBeNull();
    expect((await route(req({ path: '/api/pair', body: { code: again.pairing!.code } }), deps)).status).toBe(401);
  });

  it('answers 404 on a host without the pairing half', async () => {
    const { deps, full } = await setup();
    const bare: RouterDeps = { ...deps, pairingAccess: undefined };
    expect((await route(req({ authorization: full }), bare)).status).toBe(404);
  });
});
