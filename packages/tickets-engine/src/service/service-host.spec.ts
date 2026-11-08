import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Args, RunnerDeps, RunnerHandle } from '../fleet/runner';
import type { Engine, EngineOptions } from '../server/engine';
import type { RemoteStatus } from '../server/service';
import { ServiceHost, formatServiceLogLine } from './service-host';
import { readServiceLock } from './service-lock';

/**
 * Drey Service's host (req-164) over a stand-in engine and a stand-in
 * runner: the four component rows, the lock, the control routes, the
 * service-level sleep and the handover. The real engine is engine.spec's;
 * the real runner runner.spec's and runner-component.spec's.
 */
describe('ServiceHost', () => {
  let home = '';
  let host: ServiceHost | null = null;
  let exits: number[] = [];
  let dreyClients = 0;
  let remote: { enabled: boolean; devices: number; listening: string | null };
  let engineClosed = false;
  let runnerExit: ((code: number) => void) | null = null;
  let handoverRefusal: string | null = null;
  let runnerStops = 0;

  const fakeEngine = async (_opts: EngineOptions): Promise<Engine> =>
    ({
      invokeUrl: 'http://127.0.0.1:4100',
      token: 'tok',
      config: null as never,
      ready: Promise.resolve(),
      invoke: async () => null,
      onEvent: () => () => undefined,
      onPaths: () => () => undefined,
      dreyClients: () => dreyClients,
      remoteStatus: () =>
        ({
          config: { enabled: remote.enabled },
          listening: remote.listening,
          error: null,
          deviceUrl: remote.listening === null ? null : `http://${remote.listening}`,
          devices: Array.from({ length: remote.devices }, (_, i) => ({ id: `d${i}` })),
        }) as unknown as RemoteStatus,
      close: async () => {
        engineClosed = true;
      },
    }) as Engine;

  /** A runner stand-in with its own /shutdown for the handover. */
  const fakeRunner = async (_args: Args, deps: RunnerDeps): Promise<RunnerHandle> => {
    runnerExit = deps.exit ?? null;
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/shutdown') {
        if (handoverRefusal !== null) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: handoverRefusal }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        server.close();
        setTimeout(() => deps.exit?.(0), 10);
        return;
      }
      res.writeHead(200);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    return {
      port,
      token: 'rt',
      descriptorPath: '',
      descriptor: { port, token: 'rt', pid: process.pid, startedAt: '', version: 1 },
      stop: async () => {
        runnerStops++;
        server.close();
        deps.exit?.(0);
      },
    };
  };

  const start = async (idleMs = 60_000, tickMs = 20): Promise<ServiceHost> => {
    // This test's own list: a previous test's host exits a moment after its teardown.
    const mine = exits;
    host = await ServiceHost.start({
      home,
      vaultPath: 'V:/vault',
      clientDir: path.join(home, 'client'),
      build: '2026-11-08T00:00:00.000Z#abc',
      idleMs,
      tickMs,
      exit: (code) => mine.push(code),
      createEngine: fakeEngine,
      startRunner: fakeRunner,
    });
    return host;
  };

  const control = async (method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const lock = await readServiceLock(home);
    const res = await fetch(`http://127.0.0.1:${lock!.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${lock!.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const until = async (check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await check()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await check()).toBe(true);
  };

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-service-host-'));
    exits = [];
    dreyClients = 0;
    remote = { enabled: false, devices: 0, listening: null };
    engineClosed = false;
    runnerExit = null;
    handoverRefusal = null;
    runnerStops = 0;
  });

  afterEach(async () => {
    await host?.shutdown({ handover: false });
    host = null;
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('writes service.lock with the four components — the engine running, the runner asleep, the MCP server Drey\'s', async () => {
    await start();
    const lock = await readServiceLock(home);
    expect(lock).toMatchObject({ pid: process.pid, vaultPath: 'V:/vault', token: 'tok', build: '2026-11-08T00:00:00.000Z#abc' });
    expect(lock!.components.engine).toEqual({ state: 'running', detail: 'V:/vault', port: 4100 });
    expect(lock!.components.runner).toEqual({ state: 'sleeping', detail: 'wakes on demand' });
    expect(lock!.components.gateway).toEqual({ state: 'stopped', detail: 'remote access is off' });
    expect(lock!.components.mcp).toEqual({ state: 'external', detail: 'served by Drey (until req-167)' });
  });

  it('answers /health and /status only with the token', async () => {
    await start();
    const lock = await readServiceLock(home);
    expect((await fetch(`http://127.0.0.1:${lock!.port}/health`)).status).toBe(401);
    expect((await control('GET', '/health')).json).toMatchObject({ ok: true, pid: process.pid });
    const status = await control('GET', '/status');
    expect(status.json).toMatchObject({ ok: true, sleep: { sleep: true }, dreyClients: 0 });
  });

  it('the runner row follows the component: woken over the control route, its endpoint in the lock, asleep again after its exit', async () => {
    await start();
    expect((await control('POST', '/components/runner/start')).status).toBe(200);
    await until(async () => (await readServiceLock(home))?.components.runner.state === 'running');
    const runnerRow = (await readServiceLock(home))!.components.runner;
    expect(runnerRow).toMatchObject({ state: 'running', token: 'rt' });
    expect(typeof runnerRow.port).toBe('number');
    runnerExit?.(0);
    await until(async () => (await readServiceLock(home))?.components.runner.state === 'sleeping');
  });

  it('the engine, the gateway and the MCP server cannot be stopped one by one — the refusal says why', async () => {
    await start();
    expect(await control('POST', '/components/engine/stop')).toMatchObject({ status: 409 });
    expect((await control('POST', '/components/mcp/start')).json['error']).toContain('req-167');
  });

  it('the gateway row: running with its address and the paired devices', async () => {
    remote = { enabled: true, devices: 2, listening: '0.0.0.0:7420' };
    await start();
    await until(async () => (await readServiceLock(home))?.components.gateway.state === 'running');
    expect((await readServiceLock(home))!.components.gateway).toMatchObject({ port: 7420, detail: expect.stringContaining('2 paired devices') as unknown as string });
  });

  it('leaves after the idle span when nothing holds it, and removes its lock', async () => {
    await start(150);
    await until(() => exits.length > 0);
    expect(exits).toEqual([0]);
    expect(engineClosed).toBe(true);
    expect(await readServiceLock(home)).toBeNull();
    host = null;
  });

  it('a Drey client, an awake runner and a paired device each keep it awake', async () => {
    dreyClients = 1;
    await start(100);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toEqual([]);
    dreyClients = 0;
    remote = { enabled: true, devices: 1, listening: '127.0.0.1:7420' };
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toEqual([]);
    remote = { enabled: true, devices: 0, listening: '127.0.0.1:7420' };
    await control('POST', '/components/runner/start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toEqual([]);
    runnerExit?.(0);
    await until(() => exits.length > 0);
    host = null;
  });

  it('a handover a busy runner refuses is a 409, and the service serves on', async () => {
    await start();
    await control('POST', '/components/runner/start');
    handoverRefusal = 'run R-1 (T-0001) is in its machine gate';
    const reply = await control('POST', '/shutdown', { handover: true });
    expect(reply).toEqual({ status: 409, json: { ok: false, error: 'run R-1 (T-0001) is in its machine gate' } });
    expect(exits).toEqual([]);
    expect((await control('GET', '/health')).status).toBe(200);
  });

  it('an accepted handover leaves the runs to the successor: the runner is not stopped, the service exits', async () => {
    await start();
    await control('POST', '/components/runner/start');
    const reply = await control('POST', '/shutdown', { handover: true });
    expect(reply).toEqual({ status: 200, json: { ok: true } });
    await until(() => exits.length > 0);
    expect(runnerStops).toBe(0);
    expect(await readServiceLock(home)).toBeNull();
    host = null;
  });

  it("the owner's stop stops the runner's live runs first", async () => {
    await start();
    await control('POST', '/components/runner/start');
    expect((await control('POST', '/shutdown')).status).toBe(200);
    await until(() => exits.length > 0);
    expect(runnerStops).toBe(1);
    host = null;
  });

  it('logs one line per event with the component as a field, into service.log', async () => {
    await start();
    await control('POST', '/components/runner/start');
    const lock = await readServiceLock(home);
    const res = await fetch(`http://127.0.0.1:${lock!.port}/log?component=service`, { headers: { Authorization: `Bearer ${lock!.token}` } });
    const text = await res.text();
    expect(text).toContain(' service ');
    expect(text.split('\n').every((line) => line.split(/\s+/)[2] === 'service')).toBe(true);
    await until(async () => (await fsp.readFile(path.join(home, 'service.log'), 'utf8').catch(() => '')).includes('up: control'));
    expect(formatServiceLogLine(new Date('2026-11-08T00:00:00.000Z'), 'warn', 'runner', 'x')).toBe('2026-11-08T00:00:00.000Z warn  runner  x');
  });
});
