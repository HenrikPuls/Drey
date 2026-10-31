import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolSpec } from '../../../shared/llm';
import type { AppConfigStore } from '../../app-config';
import {
  installFakeFetch,
  jsonReply,
  streamReply,
  textReply,
  type FakeFetch,
} from '../../testing/fake-fetch';
import { LlmDebugLog } from '../llm-debug-log';
import { LlmError } from '../llm-errors';
import { OpenAiCompatProvider } from './openai-compat';

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: {} }));

interface LlmSlice {
  enabled: boolean;
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

const DEFAULT_LLM: LlmSlice = {
  enabled: true,
  baseUrl: 'http://localhost:1234/v1/',
  apiKey: null,
  model: 'local-model',
};

function provider(llm: Partial<LlmSlice> = {}): { client: OpenAiCompatProvider; debug: LlmDebugLog } {
  const config = { get: () => ({ llm: { ...DEFAULT_LLM, ...llm } }) } as unknown as AppConfigStore;
  const debug = new LlmDebugLog();
  return { client: new OpenAiCompatProvider('lmstudio', config, debug), debug };
}

const USER: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

const READ_TOOL: ToolSpec = {
  name: 'vault_read',
  description: 'Reads a note',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

function completion(content: string | null, extra: Record<string, unknown> = {}): Response {
  return jsonReply({ choices: [{ message: { content, ...extra } }] });
}

function toolCallReply(id: string, name: string, args: string): Response {
  return completion(null, { tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] });
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const err: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(LlmError);
  return err as LlmError;
}

let fake: FakeFetch | null = null;

function script(...replies: Array<Response | Error>): FakeFetch {
  fake = installFakeFetch(replies);
  return fake;
}

afterEach(() => {
  fake?.restore();
  fake = null;
});

describe('OpenAiCompatProvider.listModels', () => {
  it('asks GET /models below the base URL, without a bearer when no key is set', async () => {
    const { requests } = script(jsonReply({ data: [{ id: 'a' }, { id: '' }, { id: 7 }, { id: 'b' }] }));

    await expect(provider().client.listModels()).resolves.toEqual(['a', 'b']);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://localhost:1234/v1/models');
    expect(requests[0].method).toBe('GET');
    expect(requests[0].headers).not.toHaveProperty('authorization');
    expect(requests[0].signal).not.toBeNull();
  });

  it('sends the key as a bearer and keeps it out of the debug log', async () => {
    const { requests } = script(jsonReply({ data: [] }));
    const { client, debug } = provider({ apiKey: 'sk-very-secret-key-0001' });

    await client.listModels();

    expect(requests[0].headers['authorization']).toBe('Bearer sk-very-secret-key-0001');
    const [entry] = debug.all();
    expect(entry.authSent).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('sk-very-secret-key-0001');
  });

  it('probes the endpoint the Settings screen passes, not the saved one', async () => {
    const { requests } = script(jsonReply({ data: [] }));

    await provider().client.listModels({ baseUrl: 'https://example.test/api//', apiKey: 'typed-key' });

    expect(requests[0].url).toBe('https://example.test/api/models');
    expect(requests[0].headers['authorization']).toBe('Bearer typed-key');
  });

  it('names the API key as the cause of a 401, depending on whether one was sent', async () => {
    script(textReply('nope', 401), textReply('nope', 403));

    const without = await failure(provider().client.listModels());
    expect(without.code).toBe('auth');
    expect(without.message).toContain('requires an API key');

    const withKey = await failure(provider({ apiKey: 'k' }).client.listModels());
    expect(withKey.code).toBe('auth');
    expect(withKey.message).toContain('rejected the API key');
  });
});

describe('OpenAiCompatProvider.testConnection', () => {
  it('reports the models it found', async () => {
    script(jsonReply({ data: [{ id: 'only' }] }));
    await expect(provider().client.testConnection()).resolves.toEqual({
      ok: true,
      message: 'Connected. 1 model available.',
      models: ['only'],
    });
  });

  it('turns a refused connection into a message instead of rejecting', async () => {
    script(new TypeError('fetch failed'));
    const result = await provider().client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Could not reach http://localhost:1234/v1 — fetch failed');
  });

  it('does not claim the server was unreachable when it answered with an error', async () => {
    script(textReply('boom', 500));
    const result = await provider().client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toBe('http://localhost:1234/v1 — HTTP 500: boom');
  });
});

describe('OpenAiCompatProvider.chat', () => {
  it('refuses without a request when LLM features are off, and logs why', async () => {
    const { requests } = script();
    const { client, debug } = provider({ enabled: false });

    expect((await failure(client.chat(USER))).code).toBe('disabled');
    expect(requests).toHaveLength(0);
    expect(debug.all()[0].error).toContain('Not sent');
  });

  it('refuses without a request when no model is selected', async () => {
    const { requests } = script();
    expect((await failure(provider({ model: '' }).client.chat(USER))).code).toBe('no-model');
    expect(requests).toHaveLength(0);
  });

  it('posts one non-streamed completion and returns text and usage', async () => {
    const { requests } = script(
      jsonReply({
        choices: [{ message: { content: 'Hi there' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
    );
    const controller = new AbortController();

    const result = await provider().client.chat(USER, { signal: controller.signal });

    expect(result).toEqual({ text: 'Hi there', usage: { inputTokens: 11, outputTokens: 3 } });
    expect(requests[0].url).toBe('http://localhost:1234/v1/chat/completions');
    expect(requests[0].body).toEqual({
      model: 'local-model',
      messages: USER,
      temperature: 0.2,
      stream: false,
    });
    // Cancellation only -- no deadline of the provider's own (ADR-0014).
    expect(requests[0].signal).toBe(controller.signal);
  });

  it('lets a rejected fetch through unchanged, so a cancel stays recognisable', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    script(abort);
    const { client, debug } = provider();

    await expect(client.chat(USER)).rejects.toBe(abort);
    expect(debug.all()[0].error).toContain('AbortError');
  });

  it('maps HTTP failures onto the error taxonomy', async () => {
    script(textReply('overloaded', 503), textReply('', 401));
    const http = await failure(provider().client.chat(USER));
    expect(http.code).toBe('http');
    expect(http.message).toBe('HTTP 503: overloaded');
    expect((await failure(provider().client.chat(USER))).code).toBe('auth');
  });

  it('reports a 200 that is not JSON, carries an error body, or is empty', async () => {
    script(
      textReply('<html>gateway</html>'),
      jsonReply({ error: { message: 'model not found' } }),
      completion(''),
    );
    const { client } = provider();

    const notJson = await failure(client.chat(USER));
    expect(notJson.code).toBe('bad-reply');
    expect(notJson.detail).toBe('<html>gateway</html>');

    const errorBody = await failure(client.chat(USER));
    expect(errorBody.code).toBe('http');
    expect(errorBody.message).toBe('HTTP 200 — model not found');

    expect((await failure(client.chat(USER))).code).toBe('bad-reply');
  });

  it('puts image attachments on the last user message only', async () => {
    const { requests } = script(completion('ok'));
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'what is this?' },
    ];

    await provider().client.chat(messages, {
      attachments: [{ kind: 'image', mediaType: 'image/png', base64: 'AAAA' }],
    });

    const sent = requests[0].body?.['messages'] as Array<{ content: unknown }>;
    expect(sent[0].content).toBe('first');
    expect(Array.isArray(sent[2].content)).toBe(true);
    expect(JSON.stringify(sent[2].content)).toContain('data:image/png;base64,AAAA');
  });
});

describe('OpenAiCompatProvider tool loop', () => {
  const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  const content = (text: string): unknown => ({ choices: [{ delta: { content: text } }] });
  const toolFragment = (fragment: Record<string, unknown>): unknown => ({
    choices: [{ delta: { tool_calls: [fragment] } }],
  });
  const finish = (reason: string): unknown => ({ choices: [{ delta: {}, finish_reason: reason }] });
  const DONE = 'data: [DONE]\n\n';

  it('streams a tool round: interim text, the call, then the streamed answer', async () => {
    const { requests } = script(
      streamReply([
        sse(content('Let me look.')),
        sse(toolFragment({ index: 0, id: 'call-1', function: { name: 'vault_read', arguments: '' } })),
        sse(toolFragment({ index: 0, function: { arguments: '{"path":"a.md"}' } })),
        sse(finish('tool_calls')),
        DONE,
      ]),
      streamReply([sse(content('The note says hi.')), DONE]),
    );
    const onToolCall = vi.fn(async () => 'note body');
    const deltas: string[] = [];

    const result = await provider().client.chat(USER, {
      tools: [READ_TOOL],
      onToolCall,
      onDelta: (delta) => deltas.push(delta),
    });

    expect(onToolCall).toHaveBeenCalledExactlyOnceWith('vault_read', '{"path":"a.md"}', undefined);
    expect(result.text).toBe('The note says hi.');
    expect(result.toolTrace?.map((turn) => turn.role)).toEqual(['assistant', 'tool']);

    expect(requests).toHaveLength(2);
    expect(requests[0].body?.['tool_choice']).toBe('auto');
    expect(requests[0].body?.['stream']).toBe(true);
    expect(requests[1].body?.['stream']).toBe(true);
    const second = requests[1].body?.['messages'] as ChatMessage[];
    expect(second.map((turn) => turn.role)).toEqual(['user', 'assistant', 'tool']);
    expect(second[2]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'note body' });

    // Every round streamed: interim text, answer text — and no full-text repeat.
    expect(deltas).toEqual(['Let me look.', 'The note says hi.']);
  });

  it('runs the loop non-streamed when the caller cannot stream', async () => {
    const { requests } = script(
      toolCallReply('call-1', 'vault_read', '{"path":"a.md"}'),
      completion('The note says hi.'),
    );
    const onToolCall = vi.fn(async () => 'note body');

    const result = await provider().client.chat(USER, { tools: [READ_TOOL], onToolCall });

    expect(result.text).toBe('The note says hi.');
    expect(requests[0].body?.['stream']).toBe(false);
    expect(requests[1].body?.['stream']).toBe(false);
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith('vault_read', '{"path":"a.md"}', undefined);
  });

  it('retries a refused streamed round non-streamed, and stops streaming the call', async () => {
    const { requests } = script(
      textReply('stream not supported with tools', 400),
      toolCallReply('call-1', 'vault_read', '{"path":"a.md"}'),
      completion('The note says hi.'),
    );
    const onToolCall = vi.fn(async () => 'note body');
    const onDelta = vi.fn();

    const result = await provider().client.chat(USER, { tools: [READ_TOOL], onToolCall, onDelta });

    expect(result.text).toBe('The note says hi.');
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith('vault_read', '{"path":"a.md"}', undefined);
    // The streamed attempt, its non-streamed retry, and the answer round
    // (which goes non-streamed directly — the call stopped streaming).
    expect(requests).toHaveLength(3);
    expect(requests[0].body?.['stream']).toBe(true);
    expect(requests[1].body?.['stream']).toBe(false);
    expect(requests[1].body?.['tools']).toBeDefined();
    expect(requests[2].body?.['stream']).toBe(false);
    // Nothing streamed: the final text arrives as exactly one call.
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('The note says hi.');
  });

  it('concludes tools-rejected only when the non-streamed retry refuses the tools too', async () => {
    const { requests } = script(
      textReply('stream not supported', 400),
      textReply('unknown field tools', 400),
      completion('plain answer'),
    );
    const onToolCall = vi.fn(async () => '');
    const onDelta = vi.fn();

    const result = await provider().client.chat(USER, { tools: [READ_TOOL], onToolCall, onDelta });

    expect(result).toEqual({ text: 'plain answer', toolsDropped: true });
    expect(requests[0].body?.['stream']).toBe(true);
    expect(requests[0].body).toHaveProperty('tools');
    expect(requests[1].body?.['stream']).toBe(false);
    expect(requests[1].body).toHaveProperty('tools');
    expect(requests[2].body).not.toHaveProperty('tools');
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it('retries once without tools when the server rejects the parameter', async () => {
    const { requests } = script(textReply('unknown field tools', 400), completion('plain answer'));
    const onToolCall = vi.fn(async () => '');

    const result = await provider().client.chat(USER, { tools: [READ_TOOL], onToolCall });

    expect(result).toEqual({ text: 'plain answer', toolsDropped: true });
    expect(requests[0].body).toHaveProperty('tools');
    expect(requests[1].body).not.toHaveProperty('tools');
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it('asks for the answer without tools once the round budget is used up', async () => {
    const { requests } = script(
      toolCallReply('c1', 'vault_read', '{"path":"a.md"}'),
      toolCallReply('c2', 'vault_read', '{"path":"b.md"}'),
      toolCallReply('c3', 'vault_read', '{"path":"c.md"}'),
      completion('What I found so far.'),
    );
    const onToolCall = vi.fn(async () => 'x');

    const result = await provider().client.chat(USER, {
      tools: [READ_TOOL],
      onToolCall,
      maxToolRounds: 2,
    });

    expect(requests).toHaveLength(4);
    expect(onToolCall).toHaveBeenCalledTimes(2);
    // The closing round keeps the declarations but forbids a call.
    expect(requests[3].body?.['tool_choice']).toBe('none');
    expect(result.text).toBe('What I found so far.');
    expect(result.toolBudgetExhausted).toBe(true);
    expect(result.toolTrace).toHaveLength(4);
  });

  it('treats a 400 after a tool ran as an error, not as "no tool support"', async () => {
    script(toolCallReply('c1', 'vault_read', '{"path":"a.md"}'), textReply('context too long', 400));

    await expect(
      provider().client.chat(USER, { tools: [READ_TOOL], onToolCall: async () => 'x' }),
    ).rejects.toThrow(/400/);
  });

  it('ignores tool calls when the caller cannot run them', async () => {
    const { requests } = script(completion('answer'));

    await provider().client.chat(USER, { tools: [READ_TOOL] });

    expect(requests[0].body).not.toHaveProperty('tools');
  });
});

describe('OpenAiCompatProvider streaming', () => {
  const frame = (content: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

  it('forwards deltas as they arrive, whatever way the frames are cut', async () => {
    const whole = frame('Hel') + ': keep-alive\n\n' + frame('lo') + 'data: {broken\n\n' + frame('!') + 'data: [DONE]\n\n';
    const cut = Math.floor(whole.length / 3);
    const { requests } = script(
      streamReply([whole.slice(0, cut), whole.slice(cut, cut * 2), whole.slice(cut * 2)]),
    );
    const deltas: string[] = [];
    const { client, debug } = provider();

    const result = await client.chat(USER, { onDelta: (delta) => deltas.push(delta) });

    expect(result).toEqual({ text: 'Hello!' });
    expect(deltas).toEqual(['Hel', 'lo', '!']);
    expect(requests[0].body?.['stream']).toBe(true);
    expect(requests[0].headers['accept']).toBe('text/event-stream');
    expect(debug.all()[0].responseBody).toContain('3 chunk(s)');
  });

  it('keeps a last frame that arrives without its line break', async () => {
    script(streamReply([frame('one'), frame('two').trimEnd()]));
    const result = await provider().client.chat(USER, { onDelta: () => undefined });
    expect(result.text).toBe('onetwo');
  });

  it('stops reading at [DONE]', async () => {
    script(streamReply([frame('kept'), 'data: [DONE]\n', frame('late')]));
    const result = await provider().client.chat(USER, { onDelta: () => undefined });
    expect(result.text).toBe('kept');
  });

  it('reports an HTTP error and an empty stream', async () => {
    script(textReply('too many requests', 429), streamReply(['data: [DONE]\n\n']));
    const { client } = provider();

    const http = await failure(client.chat(USER, { onDelta: () => undefined }));
    expect(http.message).toBe('HTTP 429: too many requests');
    expect((await failure(client.chat(USER, { onDelta: () => undefined }))).code).toBe('bad-reply');
  });
});
