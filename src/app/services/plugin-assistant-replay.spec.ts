import { buildReplayMessages } from '../../../plugins/assistant/shared/chat-replay';
import { ChatNoteTurn } from '../../../plugins/assistant/shared/chat-note';

function turn(overrides: Partial<ChatNoteTurn>): ChatNoteTurn {
  return {
    role: 'user',
    at: null,
    meta: {},
    text: '',
    attachments: [],
    tool: [],
    start: 0,
    ...overrides,
  };
}

describe('chat-replay — full-history builder (bug-10b)', () => {
  it('replays user and assistant turns as plain messages', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({ role: 'user', text: 'first question' }),
        turn({ role: 'assistant', text: 'first answer' }),
        turn({ role: 'user', text: 'second question' }),
        turn({ role: 'assistant', text: 'second answer' }),
      ],
      async () => null,
    );
    expect(messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ]);
  });

  it('pops trailing dangling user turns (a crashed generation)', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({ role: 'user', text: 'q1' }),
        turn({ role: 'assistant', text: 'a1' }),
        turn({ role: 'user', text: 'asked but never answered' }),
      ],
      async () => null,
    );
    expect(messages).toHaveLength(2);
  });

  it('re-reads note attachments fresh and inlines them as FILE sections', async () => {
    const reads: string[] = [];
    const { messages } = await buildReplayMessages(
      [
        turn({
          role: 'user',
          text: 'summarise',
          attachments: [{ kind: 'note', path: 'daily/a.md' }],
        }),
        turn({ role: 'assistant', text: 'done' }),
      ],
      async (path) => {
        reads.push(path);
        return `# body of ${path}`;
      },
    );
    expect(reads).toEqual(['daily/a.md']);
    expect(messages[0].content).toBe('summarise\n\nFILE (daily/a.md):\n# body of daily/a.md');
  });

  it('warns and skips a missing attachment instead of failing', async () => {
    const { messages, warnings } = await buildReplayMessages(
      [
        turn({
          role: 'user',
          text: 'q',
          attachments: [{ kind: 'note', path: 'gone.md' }],
        }),
        turn({ role: 'assistant', text: 'a' }),
      ],
      async () => null,
    );
    expect(warnings).toEqual(['attachment not found: gone.md']);
    expect(messages[0].content).toBe(
      'q\n\n[attachment gone.md could not be read — it is missing or unreadable]',
    );
  });

  it('replays tool calls/results as real provider-loop message pairs', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({ role: 'user', text: 'search the vault' }),
        turn({
          role: 'assistant',
          text: 'I found 3 hits …',
          tool: [
            { kind: 'call', id: 't1', name: 'vault_search', arguments: { query: 'sailing' } },
            { kind: 'result', id: 't1', content: '3 hits' },
          ],
        }),
      ],
      async () => null,
    );
    expect(messages).toEqual([
      { role: 'user', content: 'search the vault' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 't1',
            type: 'function',
            function: { name: 'vault_search', arguments: '{"query":"sailing"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: '3 hits' },
      { role: 'assistant', content: 'I found 3 hits …' },
    ]);
  });

  it('replays an applied edit with its document and a discarded one without', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({ role: 'user', text: 'fix it' }),
        turn({
          role: 'assistant',
          text: '[Proposed a change to `daily/a.md`]',
          tool: [
            { kind: 'edit', path: 'daily/a.md', applied: true, after: '# fixed doc' },
          ],
        }),
        turn({ role: 'user', text: 'and again' }),
        turn({
          role: 'assistant',
          text: '[Proposed a change to `daily/b.md`]',
          tool: [{ kind: 'edit', path: 'daily/b.md', applied: false }],
        }),
      ],
      async () => null,
    );
    expect(messages[1].content).toBe('[Applied change to daily/a.md]\n# fixed doc');
    expect(messages[3].content).toBe(
      '[A proposed change to daily/b.md was discarded by the user]',
    );
  });

  it('degrades past image attachments to path mentions', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({
          role: 'user',
          text: 'what is this?',
          attachments: [{ kind: 'image', path: 'attachments/a.png', alt: 'photo' }],
        }),
        turn({ role: 'assistant', text: 'a boat.' }),
      ],
      async () => null,
    );
    expect(messages[0].content).toBe('what is this?\n\n[image attached: attachments/a.png]');
  });
});
