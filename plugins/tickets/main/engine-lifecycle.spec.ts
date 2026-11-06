import { describe, expect, it } from 'vitest';
import { syncChatConfig, syncConfig, syncNotesVault } from './engine-lifecycle';

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
