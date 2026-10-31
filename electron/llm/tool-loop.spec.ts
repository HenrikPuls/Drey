import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatToolCall, ToolCallEvent, ToolSpec } from '../../shared/llm';
import {
  ModelReply,
  RequestRound,
  TOOL_RESULT_MAX_CHARS,
  ToolMode,
  runToolLoop,
  toChatToolCall,
} from './tool-loop';

const USER: ChatMessage[] = [{ role: 'user', content: 'question' }];

const READ: ToolSpec = {
  name: 'vault_read',
  description: 'Reads a note',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, start_line: { type: 'integer' } },
    required: ['path'],
  },
};

const call = (id: string, name: string, args: string): ChatToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const calls = (...toolCalls: ChatToolCall[]): ModelReply => ({
  text: '',
  toolCalls,
  truncated: false,
});
const says = (text: string): ModelReply => ({ text, toolCalls: [], truncated: false });

/** A provider that hands out the scripted replies in order and records how it was asked. */
function scripted(...replies: Array<ModelReply | 'tools-rejected'>): {
  request: RequestRound;
  modes: ToolMode[];
  convos: ChatMessage[][];
} {
  const modes: ToolMode[] = [];
  const convos: ChatMessage[][] = [];
  const queue = [...replies];
  const request: RequestRound = (convo, mode) => {
    modes.push(mode);
    convos.push([...convo]);
    const reply = queue.shift();
    return reply === undefined
      ? Promise.reject(new Error('unexpected request'))
      : Promise.resolve(reply);
  };
  return { request, modes, convos };
}

describe('runToolLoop', () => {
  it('runs a call, feeds the result back and returns the trace', async () => {
    const { request, convos } = scripted(
      calls(call('c1', 'vault_read', '{"path":"a.md"}')),
      says('It says hi.'),
    );
    const onToolCall = vi.fn(async () => 'note body');
    const events: ToolCallEvent[] = [];

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall, onToolEvent: (event) => events.push(event) },
      request,
    );

    expect(onToolCall).toHaveBeenCalledExactlyOnceWith('vault_read', '{"path":"a.md"}', undefined);
    expect(result.text).toBe('It says hi.');
    expect(result.toolTrace?.map((turn) => turn.role)).toEqual(['assistant', 'tool']);
    expect(convos[1]?.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'note body' });
    expect(events.map((event) => [event.phase, event.name, event.ok])).toEqual([
      ['start', 'vault_read', undefined],
      ['end', 'vault_read', true],
    ]);
  });

  it('refuses a tool that was not offered, and names the ones that were', async () => {
    const { request } = scripted(calls(call('c1', 'vault_write', '{}')), says('ok'));
    const onToolCall = vi.fn(async () => 'written');

    const result = await runToolLoop(USER, { tools: [READ], onToolCall }, request);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.toolTrace?.[1]?.content).toBe(
      'Error: there is no tool "vault_write" — the tools you can call are: vault_read.',
    );
  });

  it('returns broken or incomplete arguments to the model instead of running the tool', async () => {
    const { request, convos } = scripted(
      calls(call('c1', 'vault_read', '{"path":')),
      calls(call('c2', 'vault_read', '{}')),
      says('ok'),
    );
    const onToolCall = vi.fn(async () => 'x');

    const result = await runToolLoop(USER, { tools: [READ], onToolCall }, request);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.toolTrace?.[1]?.content).toMatch(/not valid JSON/);
    expect(result.toolTrace?.[3]?.content).toMatch(/needs the argument "path"/);
    // The unparseable arguments do not travel back to the endpoint.
    expect(convos[1]?.[1]?.tool_calls?.[0]?.function.arguments).toBe('{}');
  });

  it('repairs a number sent as a string', async () => {
    const { request } = scripted(
      calls(call('c1', 'vault_read', '{"path":"a.md","start_line":"12"}')),
      says('ok'),
    );
    const onToolCall = vi.fn(async () => 'x');

    await runToolLoop(USER, { tools: [READ], onToolCall }, request);

    expect(onToolCall).toHaveBeenCalledWith('vault_read', '{"path":"a.md","start_line":12}', undefined);
  });

  it('turns a throwing tool into an error result', async () => {
    const { request } = scripted(calls(call('c1', 'vault_read', '{"path":"a.md"}')), says('ok'));
    const events: ToolCallEvent[] = [];

    const result = await runToolLoop(
      USER,
      {
        tools: [READ],
        onToolCall: () => Promise.reject(new Error('index unavailable')),
        onToolEvent: (event) => events.push(event),
      },
      request,
    );

    expect(result.text).toBe('ok');
    expect(result.toolTrace?.[1]?.content).toBe('Error: vault_read failed — index unavailable');
    expect(events.at(-1)?.ok).toBe(false);
  });

  it('lets a cancellation through', async () => {
    const { request } = scripted(calls(call('c1', 'vault_read', '{"path":"a.md"}')));
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

    await expect(
      runToolLoop(USER, { tools: [READ], onToolCall: () => Promise.reject(abort) }, request),
    ).rejects.toBe(abort);
  });

  it('caps a long result and says how to see the rest', async () => {
    const { request } = scripted(calls(call('c1', 'vault_read', '{"path":"a.md"}')), says('ok'));

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall: async () => 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500) },
      request,
    );

    const content = result.toolTrace?.[1]?.content ?? '';
    expect(content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 200);
    expect(content).toMatch(/narrow the call/);
  });

  it('does not run the calls of a reply the output limit cut off', async () => {
    const { request } = scripted(
      { ...calls(call('c1', 'vault_read', '{"path":"a.md"}')), truncated: true },
      says('ok'),
    );
    const onToolCall = vi.fn(async () => 'x');

    const result = await runToolLoop(USER, { tools: [READ], onToolCall }, request);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.toolTrace?.[1]?.content).toMatch(/^Error: your reply was cut off/);
  });

  it('reads a call the model wrote into its reply text', async () => {
    const { request } = scripted(
      says('<tool_call>{"name":"vault_read","arguments":{"path":"a.md"}}</tool_call>'),
      says('It says hi.'),
    );
    const onToolCall = vi.fn(async () => 'note body');

    const result = await runToolLoop(USER, { tools: [READ], onToolCall }, request);

    expect(onToolCall).toHaveBeenCalledExactlyOnceWith('vault_read', '{"path":"a.md"}', undefined);
    expect(result.text).toBe('It says hi.');
  });

  it('asks once for the answer when the budget is used up', async () => {
    const { request, modes, convos } = scripted(
      calls(call('c1', 'vault_read', '{"path":"a.md"}')),
      calls(call('c2', 'vault_read', '{"path":"b.md"}')),
      says('So far: a.'),
    );
    const onToolCall = vi.fn(async () => 'x');

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall, maxToolRounds: 1 },
      request,
    );

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(modes).toEqual(['tools', 'tools', 'closing']);
    expect(convos[2]?.at(-1)?.role).toBe('user');
    expect(result).toMatchObject({ text: 'So far: a.', toolBudgetExhausted: true });
    // The closing instruction is not part of what the chat note keeps.
    expect(result.toolTrace).toHaveLength(2);
  });

  it('asks once for the answer when tools ran and the model said nothing', async () => {
    const { request, modes } = scripted(
      calls(call('c1', 'vault_read', '{"path":"a.md"}')),
      says(''),
      says('Here it is.'),
    );

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall: async () => 'x' },
      request,
    );

    expect(modes).toEqual(['tools', 'tools', 'closing']);
    expect(result.text).toBe('Here it is.');
    expect(result.toolBudgetExhausted).toBeUndefined();
  });

  it('hands back an empty text with the trace when even the closing round is silent', async () => {
    const { request } = scripted(
      calls(call('c1', 'vault_read', '{"path":"a.md"}')),
      says(''),
      says(''),
    );

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall: async () => 'x' },
      request,
    );

    expect(result.text).toBe('');
    expect(result.toolTrace).toHaveLength(2);
  });

  it('goes on without tools when the endpoint rejects them, and says so', async () => {
    const { request, modes } = scripted('tools-rejected', says('plain answer'));

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall: async () => 'x' },
      request,
    );

    expect(modes).toEqual(['tools', 'plain']);
    expect(result).toEqual({ text: 'plain answer', toolsDropped: true });
  });

  it('sends a plain request when the caller cannot run tools', async () => {
    const { request, modes } = scripted(says('answer'));

    await runToolLoop(USER, { tools: [READ] }, request);

    expect(modes).toEqual(['plain']);
  });

  it('fails on a reply with neither text nor calls', async () => {
    const { request } = scripted(says(''));

    await expect(runToolLoop(USER, {}, request)).rejects.toThrow(/no message content/);
  });

  it('adds up the usage of every round', async () => {
    const { request } = scripted(
      {
        ...calls(call('c1', 'vault_read', '{"path":"a.md"}')),
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      { ...says('ok'), usage: { inputTokens: 20, outputTokens: 3 } },
    );

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall: async () => 'x' },
      request,
    );

    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 5 });
  });
});

describe('toChatToolCall', () => {
  it('fills in a missing id and serialises object arguments', () => {
    expect(toChatToolCall({ function: { name: 'vault_read', arguments: { path: 'a.md' } } }, 2)).toEqual(
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'vault_read', arguments: '{"path":"a.md"}' },
      },
    );
  });
});
