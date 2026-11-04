import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '../../../../shared/config/schema';
import {
  CHAT_PROVIDER_IDS,
  causeOf,
  chatRequest,
  deltaOf,
  resolveChatModel,
  testChatModel,
  type ChatModelConfig,
} from './chat-model';

/**
 * The engine's whole knowledge of providers (D-1, milestone 131): the
 * three-to-five config keys Drey pushes become one spec or one named
 * failure; both HTTP dialects build and read their wire here; "Test
 * connection" probes what a turn would use.
 */

function config(values: Record<string, unknown>): ChatModelConfig {
  return { get: async <T,>(key: string) => values[key] as T | undefined };
}

describe('the provider table', () => {
  it('knows every preset Drey ships, with the dialect of its client', async () => {
    expect([...CHAT_PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDER_PRESETS).sort());
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      const expected = preset.client === 'openai-compat' ? 'openai' : preset.client === 'anthropic-messages' ? 'anthropic' : null;
      const r = await resolveChatModel(config({ 'chat.provider': id, 'chat.baseUrl': 'http://h', 'chat.model': 'm' }));
      if (expected === null) {
        expect(r.ok, id).toBe(false);
      } else {
        expect(r.ok && r.spec.dialect, id).toBe(expected);
      }
    }
  });
});

describe('resolveChatModel', () => {
  it('treats an engine configured before the provider key existed as OpenAI-compatible', async () => {
    const r = await resolveChatModel(config({ 'chat.baseUrl': 'http://localhost:1234/v1/', 'chat.model': ' m ', 'chat.apiKey': ' k ' }));
    expect(r).toMatchObject({ ok: true, spec: { provider: 'openai-compat', dialect: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'm', apiKey: 'k' } });
  });

  it('names the provider that cannot be spoken and says where to change it', async () => {
    const r = await resolveChatModel(config({ 'chat.provider': 'claude-code', 'chat.baseUrl': '', 'chat.model': 'sonnet' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure).toMatchObject({ code: 'unsupported', providerLabel: 'Claude Code (CLI)' });
      expect(r.failure.message).toMatch(/Claude Code \(CLI\).*cannot talk to this provider.*Settings → Assistant/);
    }
  });

  it('an unknown provider id is refused, not guessed', async () => {
    const r = await resolveChatModel(config({ 'chat.provider': 'mystery', 'chat.baseUrl': 'http://h', 'chat.model': 'm' }));
    expect(r).toMatchObject({ ok: false, failure: { code: 'unsupported', providerLabel: 'mystery' } });
  });

  it('reports what is missing: endpoint first, then model', async () => {
    const noUrl = await resolveChatModel(config({ 'chat.model': 'm' }));
    expect(noUrl).toMatchObject({ ok: false, failure: { code: 'not-configured', reason: expect.stringMatching(/no endpoint/) } });
    const noModel = await resolveChatModel(config({ 'chat.baseUrl': 'http://h/v1' }));
    expect(noModel).toMatchObject({ ok: false, failure: { reason: expect.stringMatching(/no model/), baseUrl: 'http://h/v1' } });
  });

  it('follows the assistant master switch', async () => {
    const r = await resolveChatModel(config({ 'chat.enabled': false, 'chat.baseUrl': 'http://h', 'chat.model': 'm' }));
    expect(r).toMatchObject({ ok: false, failure: { reason: expect.stringMatching(/switched off/) } });
  });
});

describe('chatRequest', () => {
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ];

  it('OpenAI-compatible: /chat/completions with a bearer key', () => {
    const req = chatRequest({ provider: 'lmstudio', providerLabel: 'LM Studio', dialect: 'openai', baseUrl: 'http://h/v1', apiKey: 'k', model: 'm' }, messages);
    expect(req.url).toBe('http://h/v1/chat/completions');
    expect(req.headers['authorization']).toBe('Bearer k');
    expect(JSON.parse(req.body)).toEqual({ model: 'm', stream: true, messages });
  });

  it('Anthropic: /v1/messages, x-api-key, system lifted out, alternating roles', () => {
    const req = chatRequest({ provider: 'anthropic', providerLabel: 'Anthropic API', dialect: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'm' }, messages);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('k');
    expect(req.headers['authorization']).toBeUndefined();
    const body = JSON.parse(req.body) as { system: string; max_tokens: number; stream: boolean; messages: { role: string }[] };
    expect(body.system).toBe('SYS');
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(true);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('deltaOf', () => {
  it('reads the text delta of each dialect and nothing else', () => {
    expect(deltaOf('openai', JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }))).toBe('hi');
    expect(deltaOf('openai', JSON.stringify({ choices: [{ delta: {} }] }))).toBeNull();
    expect(deltaOf('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }))).toBe('hi');
    expect(deltaOf('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }))).toBeNull();
    expect(deltaOf('anthropic', JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }))).toBeNull();
    expect(deltaOf('openai', 'not json')).toBeNull();
  });
});

describe('causeOf', () => {
  it('unpacks the cause node hides behind "fetch failed"', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(causeOf(refused)).toMatch(/nothing is listening/);
    expect(causeOf(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toMatch(/does not resolve/);
    expect(causeOf(new Error('plain'))).toBe('plain');
  });
});

describe('testChatModel', () => {
  const cfg = config({ 'chat.provider': 'lmstudio', 'chat.baseUrl': 'http://h/v1', 'chat.model': 'glm' });
  const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('reports a reachable endpoint that lists the model', async () => {
    const r = await testChatModel(cfg, reply(200, { data: [{ id: 'glm' }] }));
    expect(r).toEqual({ ok: true, message: expect.stringContaining('Model glm is available') });
  });

  it('reports a reachable endpoint that does not list the model', async () => {
    const r = await testChatModel(cfg, reply(200, { data: [{ id: 'other' }] }));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/does not list the model glm/);
  });

  it('a host without a model list still counts as reached', async () => {
    const r = await testChatModel(cfg, reply(404, {}));
    expect(r).toEqual({ ok: true, message: expect.stringMatching(/exposes no model list/) });
  });

  it('names a rejected key, an unreachable host and an unspeakable provider', async () => {
    expect((await testChatModel(cfg, reply(401, {}))).message).toMatch(/LM Studio at http:\/\/h\/v1: the endpoint rejected the API key/);
    const down = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    const unreachable = await testChatModel(cfg, down);
    expect(unreachable.ok).toBe(false);
    expect(unreachable.message).toMatch(/http:\/\/h\/v1: could not be reached — connection refused/);
    const unsupported = await testChatModel(config({ 'chat.provider': 'copilot-web', 'chat.model': 'm' }), down);
    expect(unsupported).toMatchObject({ ok: false, message: expect.stringMatching(/cannot talk to this provider/) });
  });

  it('probes the Anthropic listing with the Anthropic headers', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const spy = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ data: [{ id: 'glm' }] }), { status: 200 });
    }) as typeof fetch;
    await testChatModel(config({ 'chat.provider': 'zai-glm', 'chat.baseUrl': 'https://api.z.ai/api/anthropic', 'chat.apiKey': 'zk', 'chat.model': 'glm' }), spy);
    expect(seen[0]!.url).toBe('https://api.z.ai/api/anthropic/v1/models');
    expect(seen[0]!.headers['x-api-key']).toBe('zk');
  });
});
