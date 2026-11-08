import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasHandedOverRuns, retireLegacyEngine, retireLegacyRunner } from './legacy';

/**
 * The migration of req-164: a pre-service engine and runner are retired on
 * the service's first start, their lock files removed, nothing else
 * touched. Fake processes on loopback stand in for both.
 */
describe('retiring the pre-service processes', () => {
  let home = '';
  let server: http.Server;
  let port = 0;
  let alive = true;
  let shutdownStatus = 200;
  const shutdowns: unknown[] = [];
  const kills: number[] = [];

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-legacy-'));
    alive = true;
    shutdownStatus = 200;
    shutdowns.length = 0;
    kills.length = 0;
    server = http.createServer((req, res) => {
      if (!alive || req.headers.authorization !== 'Bearer t') {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      if (req.url === '/shutdown') {
        let text = '';
        req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        req.on('end', () => {
          shutdowns.push(JSON.parse(text) as unknown);
          if (shutdownStatus === 200) {
            alive = false;
          }
          res.writeHead(shutdownStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify(shutdownStatus === 200 ? { ok: true } : { ok: false, error: 'run R-1 is in its gate' }));
        });
        return;
      }
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(home, { recursive: true, force: true });
  });

  const deps = { kill: (pid: number) => { kills.push(pid); alive = false; }, sleep: async () => undefined };

  it('an old engine that answers its own health check is ended by pid, and engine.lock goes', async () => {
    await fsp.writeFile(path.join(home, 'engine.lock'), JSON.stringify({ pid: 31337, invokePort: port, token: 't', vaultPath: 'V' }));
    expect(await retireLegacyEngine(home, () => undefined, deps)).toBe(true);
    expect(kills).toEqual([31337]);
    await expect(fsp.access(path.join(home, 'engine.lock'))).rejects.toThrow();
  });

  it('a stale engine.lock whose engine is gone is only removed — no pid is ended on a hunch', async () => {
    alive = false;
    await fsp.writeFile(path.join(home, 'engine.lock'), JSON.stringify({ pid: 31337, invokePort: port, token: 't', vaultPath: 'V' }));
    expect(await retireLegacyEngine(home, () => undefined, deps)).toBe(false);
    expect(kills).toEqual([]);
    await expect(fsp.access(path.join(home, 'engine.lock'))).rejects.toThrow();
  });

  it('an old runner is asked for the handover (its workers live on) and runner.json goes', async () => {
    await fsp.mkdir(path.join(home, 'fleet'), { recursive: true });
    await fsp.writeFile(path.join(home, 'fleet', 'runner.json'), JSON.stringify({ port, token: 't', pid: 77, startedAt: '', version: 1 }));
    expect(await retireLegacyRunner(home, () => undefined, deps)).toEqual({ kind: 'gone', pid: 77 });
    expect(shutdowns).toEqual([{ handover: true }]);
    await expect(fsp.access(path.join(home, 'fleet', 'runner.json'))).rejects.toThrow();
  });

  it('an old runner with a run in its gate refuses: busy, and its descriptor stays', async () => {
    shutdownStatus = 409;
    await fsp.mkdir(path.join(home, 'fleet'), { recursive: true });
    await fsp.writeFile(path.join(home, 'fleet', 'runner.json'), JSON.stringify({ port, token: 't', pid: 77, startedAt: '', version: 1 }));
    expect(await retireLegacyRunner(home, () => undefined, deps)).toEqual({ kind: 'busy', pid: 77, reason: 'run R-1 is in its gate' });
    await expect(fsp.access(path.join(home, 'fleet', 'runner.json'))).resolves.toBeUndefined();
  });

  it('nothing to retire: nothing happens', async () => {
    expect(await retireLegacyEngine(home, () => undefined, deps)).toBe(false);
    expect(await retireLegacyRunner(home, () => undefined, deps)).toEqual({ kind: 'none' });
  });

  it('config.json and the run history are left as they are', async () => {
    await fsp.writeFile(path.join(home, 'config.json'), '{"backend":"files"}');
    await fsp.mkdir(path.join(home, 'fleet', 'runs', 'R-1'), { recursive: true });
    await fsp.writeFile(path.join(home, 'fleet', 'runs', 'R-1', 'run.json'), '{}');
    await fsp.writeFile(path.join(home, 'engine.lock'), JSON.stringify({ pid: 31337, invokePort: port, token: 't', vaultPath: 'V' }));
    await retireLegacyEngine(home, () => undefined, deps);
    expect(await fsp.readFile(path.join(home, 'config.json'), 'utf8')).toBe('{"backend":"files"}');
    expect(await fsp.readFile(path.join(home, 'fleet', 'runs', 'R-1', 'run.json'), 'utf8')).toBe('{}');
  });
});

describe('handed-over runs wake the runner at boot', () => {
  let root = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-legacy-runs-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const record = async (id: string, body: unknown): Promise<void> => {
    await fsp.mkdir(path.join(root, 'runs', id), { recursive: true });
    await fsp.writeFile(path.join(root, 'runs', id, 'run.json'), JSON.stringify(body));
  };

  it('a live record with a handover stamp counts; a settled one or one without the stamp does not', async () => {
    expect(await hasHandedOverRuns(root)).toBe(false);
    await record('R-1', { info: { state: 'done' }, handover: { mode: 'resume' } });
    await record('R-2', { info: { state: 'running' } });
    expect(await hasHandedOverRuns(root)).toBe(false);
    await record('R-3', { info: { state: 'running' }, handover: { mode: 'reattach' } });
    expect(await hasHandedOverRuns(root)).toBe(true);
  });
});
