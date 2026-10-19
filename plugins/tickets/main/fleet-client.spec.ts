import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetClient } from './fleet-client';
import { formatStamp } from './fleet/build-stamp';

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
