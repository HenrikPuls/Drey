import { describe, expect, it } from 'vitest';
import { createAnthropicEventSink, createOpenAiChunkSink } from './stream-assembly';

describe('createOpenAiChunkSink', () => {
  it('merges tool-call fragments by index: id and name once, arguments concatenated', () => {
    const sink = createOpenAiChunkSink();
    expect(
      sink.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'vault_read', arguments: '' } }] } }] }),
    ).toBeNull();
    expect(
      sink.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
    ).toBeNull();
    // A repeated id or name fragment never overwrites what arrived first.
    expect(
      sink.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'other', function: { arguments: 'th":"a.md"}' } }] } }] }),
    ).toBeNull();

    expect(sink.result()).toEqual({
      text: '',
      toolCalls: [
        { id: 'call-1', type: 'function', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } },
      ],
      truncated: false,
    });
  });

  it('keeps several calls apart, ordered by index even when the frames are not', () => {
    const sink = createOpenAiChunkSink();
    sink.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 't2', arguments: '{}' } }] } }] });
    sink.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 't1', arguments: '{}' } }] } }] });

    const { toolCalls } = sink.result();
    expect(toolCalls.map((call) => call.id)).toEqual(['a', 'b']);
  });

  it('stringifies object arguments and defaults id and empty arguments', () => {
    const sink = createOpenAiChunkSink();
    // A loose server: no id, no index, arguments as an object in one fragment.
    sink.push({ choices: [{ delta: { tool_calls: [{ function: { name: 'vault_read', arguments: { path: 'a.md' } } }] } }] });
    // And one that names the tool but never sends arguments at all.
    sink.push({ choices: [{ delta: { tool_calls: [{ index: 5, id: 'x', function: { name: 't' } }] } }] });

    expect(sink.result().toolCalls).toEqual([
      { id: 'call-0', type: 'function', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } },
      { id: 'x', type: 'function', function: { name: 't', arguments: '{}' } },
    ]);
  });

  it('returns text deltas as they arrive and assembles the text', () => {
    const sink = createOpenAiChunkSink();
    expect(sink.push({ choices: [{ delta: { content: 'Hel' } }] })).toBe('Hel');
    expect(sink.push({ choices: [{ delta: { content: 'lo' } }] })).toBe('lo');
    expect(sink.push({ choices: [{ delta: {} }] })).toBeNull();

    expect(sink.result().text).toBe('Hello');
  });

  it('records finish_reason "length" and ignores other reasons', () => {
    const cut = createOpenAiChunkSink();
    cut.push({ choices: [{ delta: { content: 'x' } }] });
    cut.push({ choices: [{ delta: {}, finish_reason: 'length' }] });
    expect(cut.result().truncated).toBe(true);

    const done = createOpenAiChunkSink();
    done.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    done.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(done.result().truncated).toBe(false);
  });

  it('skips unknown frames without breaking', () => {
    const sink = createOpenAiChunkSink();
    expect(sink.push('junk')).toBeNull();
    expect(sink.push({})).toBeNull();
    expect(sink.push({ choices: [] })).toBeNull();
    expect(sink.push({ choices: [{ delta: { tool_calls: ['nope', null, 7] } }] })).toBeNull();
    expect(sink.push({ unrelated: true })).toBeNull();
    expect(sink.result()).toEqual({ text: '', toolCalls: [], truncated: false });
  });
});

describe('createAnthropicEventSink', () => {
  const startText = (index: number): unknown => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  });
  const startTool = (index: number, id: string, name: string): unknown => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  });
  const textDelta = (index: number, text: string): unknown => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  });
  const jsonDelta = (index: number, partialJson: string): unknown => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  });

  it('assembles text and a tool call across their delta events', () => {
    const sink = createAnthropicEventSink();
    expect(sink.push({ type: 'message_start', message: {} })).toBeNull();
    expect(sink.push(startText(0))).toBeNull();
    expect(sink.push(textDelta(0, 'Let me'))).toBe('Let me');
    expect(sink.push(textDelta(0, ' look.'))).toBe(' look.');
    expect(sink.push(startTool(1, 'tu-1', 'vault_read'))).toBeNull();
    expect(sink.push(jsonDelta(1, '{"pa'))).toBeNull();
    expect(sink.push(jsonDelta(1, 'th":"a.md"}'))).toBeNull();
    expect(sink.push({ type: 'content_block_stop', index: 1 })).toBeNull();
    expect(sink.push({ type: 'message_stop' })).toBeNull();

    expect(sink.result()).toEqual({
      text: 'Let me look.',
      toolCalls: [
        { id: 'tu-1', type: 'function', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } },
      ],
      truncated: false,
    });
  });

  it('keeps two text blocks in order and merges json per block index', () => {
    const sink = createAnthropicEventSink();
    sink.push(startText(0));
    sink.push(startTool(1, 'a', 't1'));
    sink.push(startText(2));
    sink.push(textDelta(0, 'one'));
    sink.push(textDelta(2, 'two'));
    sink.push(startTool(3, 'b', 't2'));
    sink.push(jsonDelta(3, '{"x"'));
    sink.push(jsonDelta(1, '{"p":1}'));
    sink.push(jsonDelta(3, ':2}'));

    const { text, toolCalls } = sink.result();
    expect(text).toBe('onetwo');
    expect(toolCalls).toEqual([
      { id: 'a', type: 'function', function: { name: 't1', arguments: '{"p":1}' } },
      { id: 'b', type: 'function', function: { name: 't2', arguments: '{"x":2}' } },
    ]);
  });

  it('maps stop_reason max_tokens onto truncated', () => {
    const sink = createAnthropicEventSink();
    sink.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    expect(sink.result().truncated).toBe(false);

    sink.push({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } });
    expect(sink.result().truncated).toBe(true);
  });

  it('defaults id, name, empty json and a missing index, and skips unknown events', () => {
    const sink = createAnthropicEventSink();
    expect(sink.push('junk')).toBeNull();
    expect(sink.push({ type: 'ping' })).toBeNull();
    // A tool_use start that never carried id or name defaults both.
    expect(sink.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', input: {} } })).toBeNull();
    // A text delta without index (and without its start) lands in block 0.
    expect(sink.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })).toBe('hi');

    expect(sink.result()).toEqual({
      text: 'hi',
      toolCalls: [{ id: 'call-0', type: 'function', function: { name: '', arguments: '{}' } }],
      truncated: false,
    });
  });

  it('creates a tool block on demand when a json delta arrives without its start', () => {
    const sink = createAnthropicEventSink();
    sink.push(jsonDelta(4, '{}'));
    const { toolCalls } = sink.result();
    expect(toolCalls).toEqual([
      { id: 'call-0', type: 'function', function: { name: '', arguments: '{}' } },
    ]);
  });
});
