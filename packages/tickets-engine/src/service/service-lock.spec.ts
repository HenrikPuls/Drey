import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  engineEndpointsOf,
  readServiceLock,
  removeServiceLock,
  serviceAlive,
  serviceLockPath,
  writeServiceLock,
  type ServiceLock,
} from './service-lock';

const lockOf = (over: Partial<ServiceLock> = {}): ServiceLock => ({
  version: 1,
  pid: 100,
  build: 'b',
  startedAt: '2026-11-08T00:00:00.000Z',
  home: 'H',
  vaultPath: 'V',
  port: 1,
  token: 'tok',
  components: {
    engine: { state: 'running', detail: 'V', port: 4100 },
    runner: { state: 'sleeping', detail: 'wakes on demand' },
    gateway: { state: 'stopped', detail: 'remote access is off' },
    mcp: { state: 'external', detail: 'served by Drey (until req-167)' },
  },
  ...over,
});

describe('service.lock', () => {
  let home = '';

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-service-lock-'));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('round-trips, and leaves no temp file behind', async () => {
    await writeServiceLock(home, lockOf());
    expect(await readServiceLock(home)).toEqual(lockOf());
    expect(await fsp.readdir(home)).toEqual(['service.lock']);
  });

  it('an absent, broken or foreign file is no lock', async () => {
    expect(await readServiceLock(home)).toBeNull();
    await fsp.writeFile(serviceLockPath(home), '{ broken');
    expect(await readServiceLock(home)).toBeNull();
    // The old engine.lock shape is not a service lock.
    await fsp.writeFile(serviceLockPath(home), JSON.stringify({ pid: 1, invokePort: 2, token: 't', vaultPath: 'v' }));
    expect(await readServiceLock(home)).toBeNull();
  });

  it('is removed only by the process that wrote it — a successor keeps its own', async () => {
    await writeServiceLock(home, lockOf({ pid: 200 }));
    await removeServiceLock(home, 100);
    expect(await readServiceLock(home)).not.toBeNull();
    await removeServiceLock(home, 200);
    expect(await readServiceLock(home)).toBeNull();
  });

  it("hands Drey the engine's invoke endpoint once the engine runs", () => {
    expect(engineEndpointsOf(lockOf())).toEqual({ invokeUrl: 'http://127.0.0.1:4100', token: 'tok' });
    expect(engineEndpointsOf(lockOf({ components: { ...lockOf().components, engine: { state: 'starting', detail: null } } }))).toBeNull();
  });

  it('alive means: the control port answers /health with this token', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.headers.authorization === 'Bearer tok' ? 200 : 401);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await serviceAlive({ port, token: 'tok' })).toBe(true);
      expect(await serviceAlive({ port, token: 'other' })).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await serviceAlive({ port, token: 'tok' })).toBe(false);
  });
});
