import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, writeEngineLock, type Engine } from '../../../packages/tickets-engine/src/server/engine';
import { ensureEngine, mirrorConfig, syncChatConfig, syncConfig, syncNotesVault } from './engine-lifecycle';

/**
 * The activation/adoption config sync (E5a): the assistant LLM settings
 * the app config already carries reach the engine's config store as the
 * chat.* keys the Mission Control bridge reads — provider, enabled flag,
 * base URL, api key and model pushed on every sync (a cleared value
 * travels as null so nothing stale stays behind, D-1), the api key never
 * logged. The heavy
 * ensureEngine path (lockfile, spawn) stays untested here; the sync is
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
 * `ensureEngine` over a real engine, started in-process where it would be spawned.
 * The first start after `dk.store` changed must report the NEW store, with no second start.
 */
describe('ensureEngine: the first start reads the new settings (E14-7a)', () => {
  const PIPELINE = ['---', 'phases:', '  - { id: inbox, title: Inbox, handover: manual }', '  - { id: done, title: Done, handover: none }', '---', ''].join('\n');
  let root = '';
  let engine: Engine | null = null;

  afterEach(async () => {
    await engine?.close();
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
    await ensureEngine(
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
        spawn: async (vaultPath, engineHome) => {
          engine = await createEngine({ vaultPath, home: engineHome, clientDir: path.join(root, 'client'), log: () => undefined });
          await writeEngineLock(engineHome, { pid: process.pid, invokePort: Number(new URL(engine.invokeUrl).port), token: engine.token, vaultPath });
        },
      },
    );
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
    // The startup scan builds the board inside createEngine; close waits for its report.
    await engine!.invoke('snapshot');
    await engine!.close();

    const report = JSON.parse(await fsp.readFile(path.join(home, 'shadow', 'board-diff.json'), 'utf8')) as { diff: { rightCount: number } };
    expect(report.diff.rightCount).toBe(3);
  });
});
