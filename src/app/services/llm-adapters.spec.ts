import {
  buildOpenAiUserContent,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAiTools,
} from '../../../shared/llm';
import { ChatMessage, ToolSpec } from '../../../shared/llm';

const spec: ToolSpec = {
  name: 'vault_read',
  description: 'Read one file from the vault.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

describe('toOpenAiTools', () => {
  it('wraps the canonical spec in the OpenAI function envelope', () => {
    expect(toOpenAiTools([spec])).toEqual([
      {
        type: 'function',
        function: {
          name: 'vault_read',
          description: 'Read one file from the vault.',
          parameters: spec.parameters,
        },
      },
    ]);
  });
});

describe('toAnthropicTools', () => {
  it('renames parameters to input_schema', () => {
    expect(toAnthropicTools([spec])).toEqual([
      {
        name: 'vault_read',
        description: 'Read one file from the vault.',
        input_schema: spec.parameters,
      },
    ]);
  });
});

describe('buildOpenAiUserContent', () => {
  it('returns the plain string when there are no attachments', () => {
    expect(buildOpenAiUserContent('hello')).toBe('hello');
    expect(buildOpenAiUserContent('hello', [])).toBe('hello');
  });

  it('builds image parts (data URLs) before the text', () => {
    const content = buildOpenAiUserContent('what is this?', [
      { kind: 'image', mediaType: 'image/png', base64: 'QUJD' },
    ]);
    expect(content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      { type: 'text', text: 'what is this?' },
    ]);
  });
});

describe('toAnthropicMessages', () => {
  it('lifts system messages into the top-level system string', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'system', content: 'Be kind.' },
      { role: 'user', content: 'Hi' },
    ];
    const { system, messages: out } = toAnthropicMessages(messages);
    expect(system).toBe('Be brief.\n\nBe kind.');
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
  });

  it('merges the tool exchange into alternating roles with tool blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search the vault' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'vault_search', arguments: '{"text":"mill"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'daily/2026-09-10.md:12 — Mill' },
      { role: 'assistant', content: 'Found it.' },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out[1].content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'vault_search', input: { text: 'mill' } },
    ]);
    expect(out[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [{ type: 'text', text: 'daily/2026-09-10.md:12 — Mill' }],
      },
    ]);
  });

  it('merges consecutive same-role messages instead of letting them alternate-break', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('puts image blocks on the final user turn only, before the text', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'what is this?' },
    ];
    const attachments = [{ kind: 'image' as const, mediaType: 'image/jpeg', base64: 'QUJD' }];
    const { messages: out } = toAnthropicMessages(messages, attachments);
    expect(out[2].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(out[0].content).toEqual([{ type: 'text', text: 'earlier' }]);
  });

  it('parses tool input leniently: unparseable arguments become an empty object', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'x', arguments: 'not json' } },
        ],
      },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    expect(out[0].content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });
});
