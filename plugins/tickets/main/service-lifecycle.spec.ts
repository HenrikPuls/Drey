import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatStamp } from '../../../packages/tickets-engine/src/fleet/build-stamp';
import { ServiceHost } from '../../../packages/tickets-engine/src/service/service-host';
import { writeServiceLock, type ServiceLock } from '../../../packages/tickets-engine/src/service/service-lock';
import { EngineClient } from './engine-client';
import { ensureService, mirrorConfig, syncChatConfig, syncConfig, syncNotesVault } from './service-lifecycle';

/**
 * The activation/adoption config sync (E5a): the assistant LLM settings
 * the app config already carries reach the engine's config store as the
 * chat.* keys the Mission Control bridge reads — provider, enabled flag,
 * base URL, api key and model pushed on every sync (a cleared value
 * travels as null so nothing stale stays behind, D-1), the api key never
 * logged. The heavy
 * ensureService path (lockfile, spawn) is covered further down; the sync is
 * the unit under test, against a recording invoke stand-in.
 */

interface RecordedCall {
  readonly method: string;
  readonly payload: unknown;
}

function recordingClient(calls: RecordedCall[]): { invoke(method: string, payload?: unknown): Promise<unknown> } {
  return {
    invoke: async (method: string, payload?: unknown) => {
      calls.push({ method, payload });
      return null;
    },
  };
}

function ctxWith(
  pluginKeys: Record<string, unknown>,
  llm: { baseUrl: string; apiKey: string | null; model: string | null; provider?: string; enabled?: boolean },
): {
  config: { get<T>(key: string): Promise<T | undefined> };
  appConfig: { get(): { llm: typeof llm & { provider: string; enabled: boolean } } };
} {
  return {
    config: { get: async <T,>(key: string) => pluginKeys[key] as T | undefined },
    appConfig: { get: () => ({ llm: { enabled: true, provider: 'lmstudio', ...llm } }) },
  };
}

describe('syncConfig (E5a chat keys)', () => {
  it('pushes the assistant LLM settings as chat.baseUrl, chat.apiKey and chat.model', async () => {
    const calls: RecordedCall[] = [];
    await syncConfig(
      recordingClient(calls),
      ctxWith({}, { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'sk-secret-1', model: 'glm-5' }),
    );
    expect(calls).toEqual([
      { method: 'configSet', payload: { key: 'chat.enabled', value: true } },
      { method: 'configSet', payload: { key: 'chat.provider', value: 'lmstudio' } },
      { method: 'configSet', payload: { key: 'chat.baseUrl', value: 'http://127.0.0.1:1234/v1' } },
      { method: 'configSet', payload: { key: 'chat.apiKey', value: 'sk-secret-1' } },
      { method: 'configSet', payload: { key: 'chat.model', value: 'glm-5' } },
    ]);
  });

  it('carries the provider kind so the engine can pick the dialect or refuse by name', async () => {
    const calls: RecordedCall[] = [];
    await syncConfig(
      recordingClient(calls),
      ctxWith({}, { baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'k', model: 'glm-5.3-flash', provider: 'zai-glm' }),
    );
    expect(calls).toContainEqual({ method: 'configSet', payload: { key: 'chat.provider', value: 'zai-glm' } });
  });

  it('syncs the plain plugin keys alongside the chat keys', async () => {
    const calls: RecordedCall[] = [];
    await syncConfig(
      recordingClient(calls),
      ctxWith({ defaultWorker: 'claude-code' }, { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: null, model: 'glm-5' }),
    );
    expect(calls).toContainEqual({ method: 'configSet', payload: { key: 'defaultWorker', value: 'claude-code' } });
    expect(calls).toContainEqual({ method: 'configSet', payload: { key: 'chat.model', value: 'glm-5' } });
  });

  it('pushes a cleared key, model or URL as null instead of leaving the old value behind', async () => {
    const calls: RecordedCall[] = [];
    await syncConfig(
      recordingClient(calls),
      ctxWith({}, { baseUrl: '   ', apiKey: null, model: null }),
    );
    const chat = calls.filter((call) => String((call.payload as { key: unknown }).key).startsWith('chat.'));
    expect(chat.map((call) => call.payload)).toEqual([
      { key: 'chat.enabled', value: true },
      { key: 'chat.provider', value: 'lmstudio' },
      { key: 'chat.baseUrl', value: null },
      { key: 'chat.apiKey', value: null },
      { key: 'chat.model', value: null },
    ]);
  });

  it('trims the settings before pushing', async () => {
    const calls: RecordedCall[] = [];
    await syncConfig(
      recordingClient(calls),
      ctxWith({}, { baseUrl: ' http://127.0.0.1:1234/v1 ', apiKey: '  sk-padded  ', model: ' glm-5 ' }),
    );
    expect(calls.map((call) => call.payload)).toContainEqual({ key: 'chat.baseUrl', value: 'http://127.0.0.1:1234/v1' });
    expect(calls.map((call) => call.payload)).toContainEqual({ key: 'chat.apiKey', value: 'sk-padded' });
    expect(calls.map((call) => call.payload)).toContainEqual({ key: 'chat.model', value: 'glm-5' });
  });
});

describe('syncChatConfig (D-1: Settings -> Assistant applies without a restart)', () => {
  it('pushes the new provider, URL and model the moment the settings change', async () => {
    const calls: RecordedCall[] = [];
    const client = recordingClient(calls);
    await syncChatConfig(client, { enabled: true, provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: null, model: 'a' });
    calls.length = 0;
    // The owner switches to Z.ai GLM in Settings -> Assistant.
    await syncChatConfig(client, { enabled: true, provider: 'zai-glm', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'zk', model: 'glm-5.3-flash' });
    expect(calls.map((call) => call.payload)).toEqual([
      { key: 'chat.enabled', value: true },
      { key: 'chat.provider', value: 'zai-glm' },
      { key: 'chat.baseUrl', value: 'https://api.z.ai/api/anthropic' },
      { key: 'chat.apiKey', value: 'zk' },
      { key: 'chat.model', value: 'glm-5.3-flash' },
    ]);
  });

  it('forwards the master switch, and survives an engine that rejects a key', async () => {
    const calls: RecordedCall[] = [];
    let first = true;
    await syncChatConfig(
      {
        invoke: async (method, payload) => {
          calls.push({ method, payload });
          if (first) {
            first = false;
            throw new Error('engine hiccup');
          }
          return null;
        },
      },
      { enabled: false, provider: 'lmstudio', baseUrl: 'http://h/v1', apiKey: null, model: 'm' },
    );
    expect(calls).toHaveLength(5);
    expect(calls[0]!.payload).toEqual({ key: 'chat.enabled', value: false });
  });
});

describe('syncNotesVault (req-100: the Notes API follows the active vault)', () => {
  const vault = (path: string, active: boolean, exists = true): { path: string; active: boolean; exists: boolean } => ({ path, active, exists });

  it("pushes the active vault's path", async () => {
    const calls: RecordedCall[] = [];
    await syncNotesVault(recordingClient(calls), { vault: { listVaults: async () => [vault('E:/a', false), vault('E:/b', true)] } });
    expect(calls).toEqual([{ method: 'configSet', payload: { key: 'notes.vaultPath', value: 'E:/b' } }]);
  });

  it('leaves the last one in place without an active vault, or when its folder is gone', async () => {
    const calls: RecordedCall[] = [];
    await syncNotesVault(recordingClient(calls), { vault: { listVaults: async () => [vault('E:/a', false), vault('E:/b', true, false)] } });
    expect(calls).toEqual([]);
  });
});

describe('mirrorConfig (E14-7a)', () => {
  let root = '';
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('writes the plugin keys and the chat keys into the engine home, and keeps what the engine owns', async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'engine-mirror-'));
    await fsp.writeFile(path.join(root, 'config.json'), JSON.stringify({ 'engine.token': 'tok', backend: 'files', 'dk.store': 'E:/old' }), 'utf8');
    await mirrorConfig(root, ctxWith({ backend: 'dricket', 'dk.store': 'E:/new' }, { baseUrl: 'http://h/v1', apiKey: null, model: 'm' }));
    const file = JSON.parse(await fsp.readFile(path.join(root, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({ 'engine.token': 'tok', backend: 'dricket', 'dk.store': 'E:/new', 'chat.baseUrl': 'http://h/v1', 'chat.apiKey': null });
  });

  it('leaves a key the plugin config does not hold as it is', async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'engine-mirror-'));
    await fsp.writeFile(path.join(root, 'config.json'), JSON.stringify({ backend: 'dricket' }), 'utf8');
    await mirrorConfig(root, ctxWith({}, { baseUrl: 'http://h/v1', apiKey: null, model: 'm' }));
    const file = JSON.parse(await fsp.readFile(path.join(root, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(file['backend']).toBe('dricket');
  });
});

/**
 * The rehearsal's finding, end to end minus the process boundary: the real
 * `ensureService` over a real Drey Service, started in-process where it would be spawned.
 * The first start after `dk.store` changed must report the NEW store, with no second start.
 */
describe('ensureService: the first start reads the new settings (E14-7a)', () => {
  const PIPELINE = ['---', 'phases:', '  - { id: inbox, title: Inbox, handover: manual }', '  - { id: done, title: Done, handover: none }', '---', ''].join('\n');
  let root = '';
  let service: ServiceHost | null = null;
  let engine: EngineClient | null = null;

  afterEach(async () => {
    await service?.shutdown({ handover: false });
    service = null;
    engine = null;
    await fsp.rm(root, { recursive: true, force: true });
  });

  /** A store checkout holding `count` inbox tickets (t-1, t-2, ...), in dk's file layout. */
  async function storeWith(name: string, count: number): Promise<string> {
    const store = path.join(root, name);
    for (let n = 1; n <= count; n += 1) {
      const dir = path.join(store, 'tickets', 't', '0000', `t-${n}`);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'ticket.md'), `---\nid: t-${n}\ntitle: Ticket ${n}\nstage: inbox\nowner: \nkind: human\nsize: M\nclaimed_at: \nlease_until: \nepoch: 0\nrev: 1\n---\n\n## Description\n\nText\n`, 'utf8');
    }
    return store;
  }

  async function start(vault: string, home: string, pluginKeys: Record<string, unknown>): Promise<void> {
    const base = ctxWith(pluginKeys, { baseUrl: 'http://h/v1', apiKey: null, model: 'm' });
    const endpoints = await ensureService(
      {
        ...base,
        vault: {
          listVaults: async () => [{ id: 'v', name: 'vault', path: vault, exists: true }],
          read: async () => PIPELINE,
        },
      },
      () => undefined,
      {
        home,
        spawn: async (vaultPath, serviceHome) => {
          service = await ServiceHost.start({
            home: serviceHome,
            vaultPath,
            clientDir: path.join(root, 'client'),
            build: 'spec',
            idleMs: 3_600_000,
            exit: () => undefined,
          });
        },
      },
    );
    engine = new EngineClient(endpoints);
  }

  it('the shadow report of the very first start describes the store the settings name', async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'engine-first-start-'));
    const vault = path.join(root, 'vault');
    const home = path.join(root, 'home');
    await fsp.mkdir(path.join(vault, 'tickets/_meta'), { recursive: true });
    await fsp.mkdir(path.join(root, 'client'), { recursive: true });
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(path.join(vault, 'tickets/_meta/pipeline.md'), PIPELINE, 'utf8');
    const oldStore = await storeWith('old-store', 1);
    const newStore = await storeWith('new-store', 3);
    // What the previous run left behind: the engine's config still names the old store.
    await fsp.writeFile(path.join(home, 'config.json'), JSON.stringify({ backend: 'shadow', 'dk.store': oldStore }), 'utf8');

    await start(vault, home, { backend: 'shadow', 'dk.store': newStore });
    // The startup scan builds the board inside createEngine; the shutdown waits for its report.
    await engine!.invoke('snapshot');
    await service!.shutdown({ handover: false });
    service = null;

    const report = JSON.parse(await fsp.readFile(path.join(home, 'shadow', 'board-diff.json'), 'utf8')) as { diff: { rightCount: number } };
    expect(report.diff.rightCount).toBe(3);
  });
});

/**
 * Adoption and the stale-build handover (req-164; req-51's rule, now for the
 * whole service): a fake service on loopback stands behind a `service.lock`.
 * Only a service OLDER than this build is asked to hand over; one that
 * refuses (a run in its gate) keeps serving, and Drey adopts it.
 */
describe('ensureService: adopt, or hand an older build over', () => {
  let root = '';
  let server: http.Server;
  let shutdownStatus = 409;
  const shutdowns: unknown[] = [];
  const spawned: string[] = [];

  const ctx = {
    ...ctxWith({}, { baseUrl: 'http://h/v1', apiKey: null, model: 'm' }),
    vault: {
      listVaults: async () => [{ id: 'v', name: 'vault', path: 'V:/vault', exists: true }],
      read: async () => 'pipeline',
    },
  };

  async function lockFor(build: string): Promise<ServiceLock> {
    const port = (server.address() as AddressInfo).port;
    const lock: ServiceLock = {
      version: 1,
      pid: 4242,
      build,
      startedAt: '',
      home: root,
      vaultPath: 'V:/vault',
      port,
      token: 'tok',
      components: {
        engine: { state: 'running', detail: null, port },
        runner: { state: 'sleeping', detail: null },
        gateway: { state: 'stopped', detail: null },
        mcp: { state: 'external', detail: 'served by Drey (until req-167)' },
      },
    };
    await writeServiceLock(root, lock);
    return lock;
  }

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function setUp(): Promise<void> {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'service-adopt-'));
    shutdowns.length = 0;
    spawned.length = 0;
    shutdownStatus = 409;
    let gone = false;
    server = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (gone) {
        send(503, { ok: false });
      } else if (req.url === '/health' || req.url === '/api/health') {
        send(200, { ok: true });
      } else if (req.url === '/shutdown') {
        let text = '';
        req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        req.on('end', () => {
          shutdowns.push(JSON.parse(text) as unknown);
          if (shutdownStatus === 200) {
            gone = true;
          }
          send(shutdownStatus, shutdownStatus === 200 ? { ok: true } : { ok: false, error: 'run R-1 (T-0001) is in its machine gate' });
        });
      } else {
        send(200, { ok: true, value: null });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }

  const ensure = (own: string, logs: string[] = []): Promise<unknown> =>
    ensureService(ctx, (message) => logs.push(message), {
      home: root,
      ownBuild: async () => own,
      spawn: (vaultPath) => {
        spawned.push(vaultPath);
        throw new Error('spawned');
      },
    });

  it('adopts a running service of the same build: nothing spawned, nothing asked', async () => {
    await setUp();
    const lock = await lockFor(formatStamp('2026-11-08T00:00:00.000Z', 'same'));
    await expect(ensure(formatStamp('2026-11-08T01:00:00.000Z', 'same'))).resolves.toEqual({
      invokeUrl: `http://127.0.0.1:${lock.port}`,
      token: 'tok',
    });
    expect(shutdowns).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('adopts a NEWER build without asking it to leave (two checkouts share one home)', async () => {
    await setUp();
    await lockFor(formatStamp('2999-01-01T00:00:00.000Z', 'newer'));
    await ensure(formatStamp('2026-11-08T00:00:00.000Z', 'mine'));
    expect(shutdowns).toEqual([]);
  });

  it('asks an older build for the handover and, refused, keeps using it', async () => {
    await setUp();
    await lockFor(formatStamp('2000-01-01T00:00:00.000Z', 'old0'));
    const logs: string[] = [];
    await ensure(formatStamp('2026-11-08T00:00:00.000Z', 'mine'), logs);
    expect(shutdowns).toEqual([{ handover: true }]);
    expect(spawned).toEqual([]);
    expect(logs.some((line) => line.includes('handover deferred'))).toBe(true);
  });

  it('an older build that hands over is waited out, then a new service is started', async () => {
    await setUp();
    shutdownStatus = 200;
    await lockFor(formatStamp('2000-01-01T00:00:00.000Z', 'old0'));
    await expect(ensure(formatStamp('2026-11-08T00:00:00.000Z', 'mine'))).rejects.toThrow('spawned');
    expect(shutdowns).toEqual([{ handover: true }]);
    expect(spawned).toEqual(['V:/vault']);
  });
});
