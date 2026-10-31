import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatToolCall, ToolSpec } from '../../shared/llm';
import { ModelReply, RequestRound, runToolLoop } from './tool-loop';

const USER: ChatMessage[] = [{ role: 'user', content: 'question' }];

const READ: ToolSpec = {
  name: 'vault_read',
  description: 'Reads a note',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
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

describe('runToolLoop delta forwarding', () => {
  it('forwards the deltas of every round, interim text before a tool call included', async () => {
    const replies: ModelReply[] = [
      { ...calls(call('c1', 'vault_read', '{"path":"a.md"}')), text: 'Let me check.' },
      says('It says hi.'),
    ];
    let round = 0;
    const request: RequestRound = async (_convo, _mode, _first, emit) => {
      if (round === 0) {
        emit('Let me ');
        emit('check.');
      } else {
        emit('It ');
        emit('says hi.');
      }
      return replies[round++];
    };
    const onDelta = vi.fn();

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall: async () => 'note body', onDelta },
      request,
    );

    expect(result.text).toBe('It says hi.');
    // Every streamed delta, in order — and no full-text repeat of the
    // final round on top.
    expect(onDelta.mock.calls).toEqual([
      ['Let me '],
      ['check.'],
      ['It '],
      ['says hi.'],
    ]);
  });

  it('delivers a non-streamed final round as exactly one call with the full text', async () => {
    const replies: ModelReply[] = [
      calls(call('c1', 'vault_read', '{"path":"a.md"}')),
      says('The answer.'),
    ];
    let round = 0;
    const request: RequestRound = (_convo, _mode, _first, _emit) =>
      Promise.resolve(replies[round++]);
    const onDelta = vi.fn();

    const result = await runToolLoop(
      USER,
      { tools: [READ], onToolCall: async () => 'note body', onDelta },
      request,
    );

    expect(result.text).toBe('The answer.');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('The answer.');
  });

  it('forwards the final text once when only an earlier round streamed', async () => {
    const replies: ModelReply[] = [
      { ...calls(call('c1', 'vault_read', '{"path":"a.md"}')), text: 'Looking…' },
      says('The answer.'),
    ];
    let round = 0;
    const request: RequestRound = async (_convo, _mode, _first, emit) => {
      // Only the tool round streams here (the fallback after a refused
      // streamed request looks exactly like this).
      if (round === 0) {
        emit('Looking…');
      }
      return replies[round++];
    };
    const onDelta = vi.fn();

    await runToolLoop(USER, { tools: [READ], onToolCall: async () => 'x', onDelta }, request);

    expect(onDelta.mock.calls).toEqual([['Looking…'], ['The answer.']]);
  });

  it('forwards nothing for a silent empty reply, streamed or not', async () => {
    const replies: ModelReply[] = [calls(call('c1', 'vault_read', '{}')), says(''), says('')];
    let round = 0;
    const request: RequestRound = (_convo, _mode, _first, _emit) =>
      Promise.resolve(replies[round++]);
    const onDelta = vi.fn();

    await runToolLoop(USER, { tools: [READ], onToolCall: async () => 'x', onDelta }, request);

    expect(onDelta).not.toHaveBeenCalled();
  });
});
