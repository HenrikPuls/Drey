import { REPLAY_RESULT_MAX_CHARS, buildReplayMessages } from './chat-replay';
import { ChatNoteTurn } from './chat-note';

/**
 * The post-hoc task pair in the replay (57b/57c, ADR-0058): when the app
 * showed the user a task list the model never asked a tool for, the
 * persisted synthetic `tasks_list` call must NOT replay as a call — the
 * model would learn it made a call it did not make, and a `tool` message
 * whose id has no call is a 400 on strict endpoints. The pair replays as
 * a text note after the answer instead.
 */

function turn(overrides: Partial<ChatNoteTurn>): ChatNoteTurn {
  return {
    role: 'user',
    at: null,
    meta: {},
    text: '',
    attachments: [],
    tool: [],
    context: [],
    contextStatus: null,
    start: 0,
    ...overrides,
  };
}

describe('chat-replay — the post-hoc tasks_list pair', () => {
  it('replays the pair as a text note after the answer, not as a call', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({ role: 'user', text: 'What are Henrike\'s tasks?' }),
        turn({
          role: 'assistant',
          text: 'Henrike has two open tasks.',
          tool: [
            { kind: 'call', id: 'tasks-posthoc-1790000000000', name: 'tasks_list', arguments: '{"posthoc":true}' },
            { kind: 'result', id: 'tasks-posthoc-1790000000000', content: '{"title":"Call the harbour","done":false}' },
          ],
        }),
      ],
      async () => null,
    );

    expect(messages).toEqual([
      { role: 'user', content: "What are Henrike's tasks?" },
      {
        role: 'assistant',
        content:
          'Henrike has two open tasks.\n\n' +
          '[After your answer, the app showed the user this task list — you did not call a tool for it: ' +
          '{"title":"Call the harbour","done":false}]',
      },
    ]);
  });

  it('recognizes the pair by EITHER marker — the id prefix or posthoc:true in object arguments', async () => {
    const byIdPrefix = await buildReplayMessages(
      [
        turn({
          role: 'assistant',
          text: 'Here you go.',
          tool: [
            { kind: 'call', id: 'tasks-posthoc-1', name: 'tasks_list', arguments: '{}' },
            { kind: 'result', id: 'tasks-posthoc-1', content: '[]' },
          ],
        }),
      ],
      async () => null,
    );
    expect(JSON.stringify(byIdPrefix.messages)).not.toContain('"tool_calls"');
    expect(byIdPrefix.messages[0]?.content).toContain('you did not call a tool for it');

    const byArgsFlag = await buildReplayMessages(
      [
        turn({
          role: 'assistant',
          text: 'Here you go.',
          tool: [
            { kind: 'call', id: 'call-7', name: 'tasks_list', arguments: { posthoc: true } },
            { kind: 'result', id: 'call-7', content: '[]' },
          ],
        }),
      ],
      async () => null,
    );
    expect(JSON.stringify(byArgsFlag.messages)).not.toContain('"tool_calls"');
    expect(byArgsFlag.messages[0]?.content).toContain('you did not call a tool for it');
  });

  it('still replays a REAL tasks_list pair as a call', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({
          role: 'assistant',
          text: 'Let me look.',
          tool: [
            { kind: 'call', id: 'call-1', name: 'tasks_list', arguments: '{"includeDone":false}' },
            { kind: 'result', id: 'call-1', content: '{"title":"Call the harbour","done":false}' },
          ],
        }),
      ],
      async () => null,
    );

    expect(messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'tasks_list', arguments: '{"includeDone":false}' } },
      ] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"title":"Call the harbour","done":false}' },
      { role: 'assistant', content: 'Let me look.' },
    ]);
  });

  it('caps the note through the replayed-result rule', async () => {
    const long = 'x'.repeat(REPLAY_RESULT_MAX_CHARS + 100);
    const { messages } = await buildReplayMessages(
      [
        turn({
          role: 'assistant',
          text: 'answer',
          tool: [
            { kind: 'call', id: 'tasks-posthoc-2', name: 'tasks_list', arguments: '{"posthoc":true}' },
            { kind: 'result', id: 'tasks-posthoc-2', content: long },
          ],
        }),
      ],
      async () => null,
    );

    const content = messages[0]?.content ?? '';
    expect(content).toContain('shortened in the history');
    expect(content.length).toBeLessThan(REPLAY_RESULT_MAX_CHARS + 400);
  });

  it('keeps a following real-call turn intact', async () => {
    const { messages } = await buildReplayMessages(
      [
        turn({ role: 'user', text: 'q1' }),
        turn({
          role: 'assistant',
          text: 'a1',
          tool: [
            { kind: 'call', id: 'tasks-posthoc-3', name: 'tasks_list', arguments: '{"posthoc":true}' },
            { kind: 'result', id: 'tasks-posthoc-3', content: '{"title":"t"}' },
          ],
        }),
        turn({ role: 'user', text: 'q2' }),
        turn({
          role: 'assistant',
          text: 'a2',
          tool: [
            { kind: 'call', id: 'call-9', name: 'vault_read', arguments: '{"path":"a.md"}' },
            { kind: 'result', id: 'call-9', content: 'note body' },
          ],
        }),
      ],
      async () => null,
    );

    expect(messages).toEqual([
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content:
          'a1\n\n[After your answer, the app showed the user this task list — you did not call a tool for it: {"title":"t"}]',
      },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call-9', type: 'function', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call-9', content: 'note body' },
      { role: 'assistant', content: 'a2' },
    ]);
  });
});
