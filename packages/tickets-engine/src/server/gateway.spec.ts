import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteChange, TicketsRemotePort } from '../contracts/remote-protocol';
import { DeviceRegistry, FailureLimiter, PairingCodes } from './auth';
import { parseByteRange, RemoteGateway } from './gateway';

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

async function start(videos?: (name: string) => Promise<{ file: string; bytes: number } | null>): Promise<{ base: string; emit: (what: RemoteChange) => void; token: string; calls: { patch?: unknown; pause?: unknown; thread?: unknown } }> {
  const listeners = new Set<(what: RemoteChange) => void>();
  const devices = new DeviceRegistry([], async () => undefined);
  const { token } = await devices.add('Test', false, new Date());
  let allowed = new Set<string>();
  const calls: { patch?: unknown; pause?: unknown; thread?: unknown } = {};
  gateway = new RemoteGateway({
    clientDir: '/nonexistent-client-dir',
    log: () => undefined,
    videos,
    router: {
      port: {
        needs: async () => [],
        personaPatch: async (cmd: unknown) => {
          calls.patch = cmd;
          return { ok: true };
        },
        chainPersonaPause: async (cmd: { persona: string; paused: boolean }) => {
          calls.pause = cmd;
          return { ok: true, persona: cmd.persona, paused: cmd.paused };
        },
        personaThread: async (id: string) => {
          calls.thread = id;
          return { ok: true, messages: [] };
        },
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
  return { base: `http://${address}`, emit: (what) => listeners.forEach((l) => l(what)), token, calls };
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

  it('carries a PATCH body through to the port — the U4 persona patch (U4)', async () => {
    const { base, token, calls } = await start();
    const patched = await fetch(`${base}/api/personas/pia`, {
      method: 'PATCH',
      body: JSON.stringify({ model: 'sonnet', router: 'budget' }),
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ ok: true });
    expect(calls.patch).toEqual({ persona: 'pia', model: 'sonnet', router: 'budget' });

    // a body-less PATCH is a refused command, not a transport error
    const empty = await fetch(`${base}/api/personas/pia`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { ok: boolean }).ok).toBe(false);

    const paused = await fetch(`${base}/api/chain/persona-pause`, {
      method: 'POST',
      body: JSON.stringify({ persona: 'pia', paused: true }),
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await paused.json()).toEqual({ ok: true, persona: 'pia', paused: true });
    expect(calls.pause).toEqual({ persona: 'pia', paused: true });
    expect((await fetch(`${base}/api/personas/pia/thread`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(calls.thread).toBe('pia');
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

describe('parseByteRange', () => {
  it('reads closed, open-ended and suffix windows', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });

  it('flags a window outside the file and ignores what is not a single range', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=9-2', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseByteRange(undefined, 100)).toBeNull();
  });
});

describe('GET /api/videos/<name> (E11-1)', () => {
  it('needs the bearer token, answers Range with 206 and pins the name', async () => {
    const dir = await fsp.mkdtemp(path.join(tmpdir(), 'gateway-videos-'));
    try {
      const file = path.join(dir, 'verify-20261101-143200-T-0042.webm');
      await fsp.writeFile(file, Buffer.from('0123456789'));
      const { base, token } = await start(async (name) =>
        name === 'verify-20261101-143200-T-0042.webm' ? { file, bytes: 10 } : null,
      );
      const url = `${base}/api/videos/verify-20261101-143200-T-0042.webm`;

      expect((await fetch(url)).status).toBe(401);

      const whole = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      expect(whole.status).toBe(200);
      expect(whole.headers.get('content-type')).toBe('video/webm');
      expect(whole.headers.get('accept-ranges')).toBe('bytes');
      expect(await whole.text()).toBe('0123456789');

      const part = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=2-5' } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(await part.text()).toBe('2345');

      const past = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=20-' } });
      expect(past.status).toBe(416);

      const auth = { Authorization: `Bearer ${token}` };
      expect((await fetch(`${base}/api/videos/other.webm`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/api/videos/..%2Fsecret.webm`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/api/videos/clip.avi`, { headers: auth })).status).toBe(404);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
