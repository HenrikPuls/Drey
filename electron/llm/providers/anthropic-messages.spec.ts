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
import { AnthropicMessagesProvider } from './anthropic-messages';

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: {} }));

interface LlmSlice {
  enabled: boolean;
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

const DEFAULT_LLM: LlmSlice = {
  enabled: true,
  baseUrl: 'https://api.example.test/',
  apiKey: 'sk-ant-very-secret-0001',
  model: 'some-model',
};

function provider(llm: Partial<LlmSlice> = {}): { client: AnthropicMessagesProvider; debug: LlmDebugLog } {
  const config = { get: () => ({ llm: { ...DEFAULT_LLM, ...llm } }) } as unknown as AppConfigStore;
  const debug = new LlmDebugLog();
  return { client: new AnthropicMessagesProvider('anthropic', config, debug), debug };
}

const TURNS: ChatMessage[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Hello' },
];

const READ_TOOL: ToolSpec = {
  name: 'vault_read',
  description: 'Reads a note',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const textBlock = (text: string): Record<string, unknown> => ({ type: 'text', text });
const toolUse = (id: string, input: unknown): Record<string, unknown> => ({
  type: 'tool_use',
  id,
  name: 'vault_read',
  input,
});

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

describe('AnthropicMessagesProvider.listModels', () => {
  it('asks GET /v1/models with the key header, masked in the debug log', async () => {
    const { requests } = script(jsonReply({ data: [{ id: 'm-1' }, { id: null }] }));
    const { client, debug } = provider();

    await expect(client.listModels()).resolves.toEqual(['m-1']);

    expect(requests[0].url).toBe('https://api.example.test/v1/models');
    expect(requests[0].headers['x-api-key']).toBe('sk-ant-very-secret-0001');
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.stringify(debug.all())).not.toContain('sk-ant-very-secret-0001');
  });

  it('refuses without a request when no key is set', async () => {
    const { requests } = script();
    const err = await failure(provider({ apiKey: null }).client.listModels());
    expect(err.code).toBe('auth');
    expect(requests).toHaveLength(0);
  });

  it('tells the user to type the id when the host has no model listing', async () => {
    script(textReply('not found', 404));
    const result = await provider().client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('type the model id instead');
  });

  it('probes the endpoint the Settings screen passes', async () => {
    const { requests } = script(jsonReply({ data: [] }));

    const result = await provider().client.testConnection({
      baseUrl: 'https://other.test/api/anthropic/',
      apiKey: 'typed',
    });

    expect(result.ok).toBe(true);
    expect(requests[0].url).toBe('https://other.test/api/anthropic/v1/models');
    expect(requests[0].headers['x-api-key']).toBe('typed');
  });
});

describe('AnthropicMessagesProvider.chat', () => {
  it('refuses without a request when switched off or without a model', async () => {
    const { requests } = script();
    expect((await failure(provider({ enabled: false }).client.chat(TURNS))).code).toBe('disabled');
    expect((await failure(provider({ model: '' }).client.chat(TURNS))).code).toBe('no-model');
    expect(requests).toHaveLength(0);
  });

  it('logs a call that was not sent for want of a key', async () => {
    const { requests } = script();
    const { client, debug } = provider({ apiKey: null });

    expect((await failure(client.chat(TURNS))).code).toBe('auth');
    expect(requests).toHaveLength(0);
    expect(debug.all()[0].error).toContain('Not sent');
  });

  it('lifts the system prompt out of the messages and always sends an output cap', async () => {
    const { requests } = script(
      jsonReply({
        content: [textBlock('Hi'), textBlock(' there')],
        usage: { input_tokens: 9, output_tokens: 2 },
      }),
    );

    const result = await provider().client.chat(TURNS);

    expect(result).toEqual({ text: 'Hi there', usage: { inputTokens: 9, outputTokens: 2 } });
    expect(requests[0].url).toBe('https://api.example.test/v1/messages');
    const body = requests[0].body ?? {};
    expect(body['system']).toBe('Be brief.');
    expect(body['max_tokens']).toBe(4096);
    expect(body['stream']).toBe(false);
    expect((body['messages'] as Array<{ role: string }>).map((m) => m.role)).toEqual(['user']);
    expect(body).not.toHaveProperty('tools');
  });

  it('honours a caller-given output cap and temperature', async () => {
    const { requests } = script(jsonReply({ content: [textBlock('ok')] }));
    await provider().client.chat(TURNS, { maxOutputTokens: 256, temperature: 0 });
    expect(requests[0].body?.['max_tokens']).toBe(256);
    expect(requests[0].body?.['temperature']).toBe(0);
  });

  it('maps failures onto the error taxonomy', async () => {
    script(
      textReply('', 403),
      textReply('rate limited', 429),
      textReply('not json'),
      jsonReply({ error: { type: 'overloaded_error', message: 'Overloaded' } }),
      jsonReply({ content: [] }),
    );
    const { client } = provider();

    expect((await failure(client.chat(TURNS))).code).toBe('auth');
    expect((await failure(client.chat(TURNS))).message).toBe('HTTP 429: rate limited');
    expect((await failure(client.chat(TURNS))).code).toBe('bad-reply');
    expect((await failure(client.chat(TURNS))).message).toBe('HTTP 200 — Overloaded');
    expect((await failure(client.chat(TURNS))).code).toBe('bad-reply');
  });
});

describe('AnthropicMessagesProvider tool loop', () => {
  it('runs each requested tool and sends the results back as blocks', async () => {
    const { requests } = script(
      jsonReply({ content: [textBlock('Let me look.'), toolUse('tu-1', { path: 'a.md' })] }),
      jsonReply({ content: [textBlock('It says hi.')] }),
    );
    const onToolCall = vi.fn(async () => 'note body');
    const onDelta = vi.fn();

    const result = await provider().client.chat(TURNS, { tools: [READ_TOOL], onToolCall, onDelta });

    expect(onToolCall).toHaveBeenCalledExactlyOnceWith('vault_read', '{"path":"a.md"}');
    expect(result.text).toBe('It says hi.');
    // The trace is in the app's own (OpenAI-shaped) transcript form.
    expect(result.toolTrace).toEqual([
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          { id: 'tu-1', type: 'function', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tu-1', content: 'note body' },
    ]);

    expect(requests[0].body?.['tools']).toEqual([
      { name: 'vault_read', description: 'Reads a note', input_schema: READ_TOOL.parameters },
    ]);
    const replay = JSON.stringify(requests[1].body?.['messages']);
    expect(replay).toContain('"type":"tool_use"');
    expect(replay).toContain('"type":"tool_result"');
    expect(replay).toContain('note body');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('It says hi.');
  });

  it('asks for the answer without tools once the round budget is used up', async () => {
    const { requests } = script(
      jsonReply({ content: [toolUse('a', { path: 'a.md' })] }),
      jsonReply({ content: [toolUse('b', { path: 'b.md' })] }),
      jsonReply({ content: [textBlock('What I found so far.')] }),
    );
    const onToolCall = vi.fn(async () => 'x');

    const result = await provider().client.chat(TURNS, {
      tools: [READ_TOOL],
      onToolCall,
      maxToolRounds: 1,
    });

    expect(requests).toHaveLength(3);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    // The transcript holds tool blocks, so the declarations stay; a call is forbidden.
    expect(requests[2].body?.['tools']).toBeDefined();
    expect(requests[2].body?.['tool_choice']).toEqual({ type: 'none' });
    expect(result.text).toBe('What I found so far.');
    expect(result.toolBudgetExhausted).toBe(true);
    expect(result.toolTrace).toHaveLength(2);
  });

  it('does not run a call that the output limit cut off', async () => {
    script(
      jsonReply({ content: [toolUse('a', { path: 'a.md' })], stop_reason: 'max_tokens' }),
      jsonReply({ content: [textBlock('done')] }),
    );
    const onToolCall = vi.fn(async () => 'x');

    const result = await provider().client.chat(TURNS, { tools: [READ_TOOL], onToolCall });

    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.toolTrace?.[1]?.content).toMatch(/^Error: your reply was cut off/);
  });
});

describe('AnthropicMessagesProvider streaming', () => {
  const delta = (text: string): string =>
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    })}\n\n`;

  it('forwards text deltas and skips every other event', async () => {
    const whole =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      delta('Hel') +
      'event: ping\ndata: {"type":"ping"}\n\n' +
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } })}\n\n` +
      delta('lo') +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const cut = Math.floor(whole.length / 2) + 3;
    const { requests } = script(streamReply([whole.slice(0, cut), whole.slice(cut)]));
    const deltas: string[] = [];

    const result = await provider().client.chat(TURNS, { onDelta: (text) => deltas.push(text) });

    expect(result).toEqual({ text: 'Hello' });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(requests[0].body?.['stream']).toBe(true);
    expect(requests[0].headers['accept']).toBe('text/event-stream');
  });

  it('keeps a last frame that arrives without its line break', async () => {
    script(streamReply([delta('one'), delta('two').trimEnd()]));
    const result = await provider().client.chat(TURNS, { onDelta: () => undefined });
    expect(result.text).toBe('onetwo');
  });

  it('reports an HTTP error and a stream without text', async () => {
    script(textReply('bad key', 401), streamReply(['event: ping\ndata: {"type":"ping"}\n\n']));
    const { client } = provider();

    expect((await failure(client.chat(TURNS, { onDelta: () => undefined }))).code).toBe('auth');
    expect((await failure(client.chat(TURNS, { onDelta: () => undefined }))).code).toBe('bad-reply');
  });
});
