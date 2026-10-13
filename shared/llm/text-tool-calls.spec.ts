import { describe, expect, it } from 'vitest';
import { parseTextToolCalls } from './text-tool-calls';

const OFFERED = new Set(['vault_read', 'vault_search']);

describe('parseTextToolCalls', () => {
  it('reads a tagged call and keeps the prose beside it', () => {
    const parsed = parseTextToolCalls(
      'Let me look.\n<tool_call>\n{"name": "vault_read", "arguments": {"path": "a.md"}}\n</tool_call>',
      OFFERED,
    );

    expect(parsed?.text).toBe('Let me look.');
    expect(parsed?.calls).toEqual([
      {
        id: 'text-call-0',
        type: 'function',
        function: { name: 'vault_read', arguments: '{"path":"a.md"}' },
      },
    ]);
  });

  it('reads several tagged calls, also when the last tag is not closed', () => {
    const parsed = parseTextToolCalls(
      '<tool_call>{"name":"vault_search","arguments":{"query":"x"}}</tool_call>' +
        '<tool_call>{"name":"vault_read","arguments":{"path":"a.md"}}',
      OFFERED,
    );

    expect(parsed?.calls.map((call) => call.function.name)).toEqual(['vault_search', 'vault_read']);
  });

  it('reads a reply that is nothing but a JSON call, fenced or bare', () => {
    const fenced = parseTextToolCalls(
      '```json\n{"name":"vault_read","parameters":{"path":"a.md"}}\n```',
      OFFERED,
    );
    const bare = parseTextToolCalls(
      '{"function":{"name":"vault_read","arguments":"{\\"path\\":\\"a.md\\"}"}}',
      OFFERED,
    );

    expect(fenced?.calls[0]?.function.arguments).toBe('{"path":"a.md"}');
    expect(bare?.calls[0]?.function.arguments).toBe('{"path":"a.md"}');
  });

  it('leaves a call to a tool that was not offered alone', () => {
    expect(
      parseTextToolCalls('<tool_call>{"name":"vault_write","arguments":{}}</tool_call>', OFFERED),
    ).toBeNull();
  });

  it('leaves ordinary replies alone', () => {
    expect(parseTextToolCalls('The note says hi.', OFFERED)).toBeNull();
    expect(parseTextToolCalls('{"kind":"answer","text":"hi"}', OFFERED)).toBeNull();
    expect(
      parseTextToolCalls(
        'You could call it like this:\n```json\n{"name":"vault_read","arguments":{}}\n```',
        OFFERED,
      ),
    ).toBeNull();
  });
});
