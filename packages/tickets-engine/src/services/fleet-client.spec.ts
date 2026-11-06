import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetClient } from './fleet-client';
import { formatStamp } from '../fleet/build-stamp';

/**
 * The client's retirement of a runner from an older build (req-51)
 * against a fake runner on loopback: the handover is asked for, and a
 * runner that refuses (a run in its gate) keeps serving.
 */
describe('FleetClient handover', () => {
  let root = '';
  let server: http.Server;
  const shutdowns: unknown[] = [];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-client-'));
    shutdowns.length = 0;
    server = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/health') {
        send(200, { ok: true, build: formatStamp('2000-01-01T00:00:00.000Z', 'old0'), live: 1 });
      } else if (req.url === '/shutdown') {
        let text = '';
        req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        req.on('end', () => {
          shutdowns.push(JSON.parse(text) as unknown);
          send(409, { ok: false, error: 'run R-1 (T-0001) is in its machine gate' });
        });
      } else if (req.url === '/status') {
        send(200, { runs: [{ id: 'R-1', startedAt: '2026-10-19T10:00:00Z' }] });
      } else {
        send(200, {});
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await fsp.writeFile(path.join(root, 'runner.json'), JSON.stringify({ port, token: 't', pid: 1, startedAt: '', version: 1 }));
    await fsp.writeFile(path.join(root, 'runner.js'), 'exports.newer = true;\n');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('asks for a handover and, refused, keeps using the old runner — logged once', async () => {
    const logs: string[] = [];
    const client = new FleetClient({
      root,
      runnerScript: path.join(root, 'runner.js'),
      log: (message) => logs.push(message),
      onFleetChanged: () => undefined,
    });
    try {
      expect(await client.runs()).toHaveLength(1);
      expect(await client.runs()).toHaveLength(1);
    } finally {
      client.dispose();
    }
    expect(shutdowns.length).toBeGreaterThanOrEqual(1);
    expect(shutdowns.every((body) => (body as { handover?: unknown }).handover === true)).toBe(true);
    expect(logs.filter((line) => line.includes('handover deferred'))).toHaveLength(1);
  });
});

/**
 * The Autopilot's announce (req-95): the client's push is what the engine
 * emits as the `fleet` change every device's event stream carries, so the
 * owner's set and the runner's own resume both must reach it.
 */
describe('FleetClient Autopilot', () => {
  let root = '';
  let server: http.Server;
  let chain: Record<string, unknown>;
  const posted: unknown[] = [];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-client-'));
    posted.length = 0;
    chain = { configured: true, master: 'halted', autopilot: { state: 'off' } };
    server = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/health') {
        send(200, { ok: true, live: 0 });
      } else if (req.url === '/status') {
        send(200, { runs: [] });
      } else if (req.url === '/chain') {
        send(200, chain);
      } else if (req.url === '/chain/autopilot') {
        let text = '';
        req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        req.on('end', () => {
          const body = JSON.parse(text) as { state: string };
          posted.push(body);
          if (body.state === 'bad') {
            send(422, { ok: false, error: 'bad_state', code: 'bad_state' });
            return;
          }
          chain = { ...chain, autopilot: body, master: body.state === 'on' ? 'run' : 'halted' };
          send(200, chain);
        });
      } else {
        send(404, {});
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    // A build newer than this one: never retired, it just serves.
    const build = formatStamp('2999-01-01T00:00:00.000Z', 'new0');
    await fsp.writeFile(path.join(root, 'runner.json'), JSON.stringify({ port, token: 't', pid: 1, startedAt: '', version: 1, build }));
    await fsp.writeFile(path.join(root, 'runner.js'), 'exports.older = true;\n');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('announces a set at once, then the runner firing a resume by itself — each once', async () => {
    const states: unknown[] = [];
    const client = new FleetClient({
      root,
      runnerScript: path.join(root, 'runner.js'),
      log: () => undefined,
      onFleetChanged: (fleet) => states.push(fleet.chain?.autopilot),
    });
    try {
      const paused = { state: 'paused', resumeAt: '2026-11-06T18:00:00.000Z' } as const;
      expect(await client.setAutopilot(paused)).toMatchObject({ autopilot: paused });
      expect(posted).toEqual([paused]);
      expect(states).toEqual([paused]);

      // The runner's tick turned it On; the next poll round announces it.
      chain = { ...chain, master: 'run', autopilot: { state: 'on' } };
      await client.runs();
      await client.runs();
      expect(states).toEqual([paused, { state: 'on' }]);
    } finally {
      client.dispose();
    }
  });

  it('hands a refusal back with its code', async () => {
    const client = new FleetClient({ root, runnerScript: path.join(root, 'runner.js'), log: () => undefined, onFleetChanged: () => undefined });
    try {
      expect(await client.setAutopilot({ state: 'bad' as 'on' })).toEqual({ ok: false, error: 'bad_state', code: 'bad_state' });
    } finally {
      client.dispose();
    }
  });
});
