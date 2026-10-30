import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteChange, TicketsRemotePort } from '../../shared/remote-protocol';
import { DeviceRegistry, FailureLimiter, PairingCodes } from './auth';
import { RemoteGateway } from './gateway';

/**
 * req-66: the HTTP server on a real loopback socket — security headers,
 * the built-in pairing page, Host refusal, JSON errors and the event
 * stream.
 */

let gateway: RemoteGateway | null = null;
afterEach(async () => {
  await gateway?.stop();
  gateway = null;
});

async function start(): Promise<{ base: string; emit: (what: RemoteChange) => void; token: string }> {
  const listeners = new Set<(what: RemoteChange) => void>();
  const devices = new DeviceRegistry([], async () => undefined);
  const { token } = await devices.add('Test', false, new Date());
  let allowed = new Set<string>();
  gateway = new RemoteGateway({
    clientDir: '/nonexistent-client-dir',
    log: () => undefined,
    router: {
      port: {
        needs: async () => [],
        onChanged: (l: (what: RemoteChange) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      } as unknown as TicketsRemotePort,
      devices,
      pairing: new PairingCodes(),
      limiter: new FailureLimiter(),
      allowedHosts: () => allowed,
      now: () => new Date(),
      log: () => undefined,
      onPaired: () => undefined,
    },
  });
  await gateway.start('127.0.0.1', 0);
  const address = gateway.listening!;
  allowed = new Set([address]);
  return { base: `http://${address}`, emit: (what) => listeners.forEach((l) => l(what)), token };
}

describe('RemoteGateway', () => {
  it('serves the pairing page with a strict CSP', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('<script src="pair.js" defer></script>');
    expect((await fetch(`${base}/pair.js`)).headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(`${base}/../secret.json`)).status).toBe(404);
    expect((await fetch(`${base}/main.ts`)).status).toBe(404);
  });

  it('refuses a request for another host name', async () => {
    const { base } = await start();
    const res = await fetch(`${base.replace('127.0.0.1', 'localhost')}/api/health`);
    expect(res.status).toBe(421);
  });

  it('answers bad JSON with 400 and the API with JSON', async () => {
    const { base, token } = await start();
    const bad = await fetch(`${base}/api/tickets`, { method: 'POST', body: '{', headers: { Authorization: `Bearer ${token}` } });
    expect(bad.status).toBe(400);
    const needs = await fetch(`${base}/api/needs`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await needs.json()).toEqual([]);
  });

  it('streams board and fleet changes to a paired device only', async () => {
    const { base, emit, token } = await start();
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const res = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    emit('board');
    while (!text.includes('event: board')) {
      text += decoder.decode((await reader.read()).value);
    }
    expect(text).toContain('retry: 3000');
    await reader.cancel();
  });
});
