import { describe, expect, it } from 'vitest';
import { syncConfig } from './engine-lifecycle';

/**
 * The activation/adoption config sync (E5a): the assistant LLM settings
 * the app config already carries reach the engine's config store as the
 * chat.* keys the Mission Control bridge reads — base URL, api key and
 * model pushed on every sync, the api key never logged. The heavy
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
  llm: { baseUrl: string; apiKey: string | null; model: string | null },
): {
  config: { get<T>(key: string): Promise<T | undefined> };
  appConfig: { get(): { llm: typeof llm } };
} {
  return {
    config: { get: async <T,>(key: string) => pluginKeys[key] as T | undefined },
    appConfig: { get: () => ({ llm }) },
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
      { method: 'configSet', payload: { key: 'chat.baseUrl', value: 'http://127.0.0.1:1234/v1' } },
      { method: 'configSet', payload: { key: 'chat.apiKey', value: 'sk-secret-1' } },
      { method: 'configSet', payload: { key: 'chat.model', value: 'glm-5' } },
    ]);
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

  it('skips the chat keys the settings do not carry (no key, no model, blank base URL)', async () => {
    const calls: RecordedCall[] = [];
    await syncConfig(
      recordingClient(calls),
      ctxWith({}, { baseUrl: '   ', apiKey: null, model: null }),
    );
    expect(calls.filter((call) => String((call.payload as { key: unknown }).key).startsWith('chat.'))).toEqual([]);
  });

  it('trims the settings before pushing', async () => {
    const calls: RecordedCall[] = [];
    await syncConfig(
      recordingClient(calls),
      ctxWith({}, { baseUrl: ' http://127.0.0.1:1234/v1 ', apiKey: '  sk-padded  ', model: ' glm-5 ' }),
    );
    expect(calls).toEqual([
      { method: 'configSet', payload: { key: 'chat.baseUrl', value: 'http://127.0.0.1:1234/v1' } },
      { method: 'configSet', payload: { key: 'chat.apiKey', value: 'sk-padded' } },
      { method: 'configSet', payload: { key: 'chat.model', value: 'glm-5' } },
    ]);
  });
});
