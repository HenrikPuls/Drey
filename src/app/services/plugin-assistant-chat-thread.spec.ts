import {
  ChatThread,
  emptyThread,
  hasSummary,
  historyForAsk,
  parseChatThread,
  serializeChatThread,
  sidecarPathFor,
// The sidecar thread model moved into the assistant plugin (ADR-0044
// stage 7); the Angular runner ignores `plugins/**` sources, so plugin
// specs live under `src/app/services/` and import the plugin sources.
} from '../../../plugins/assistant/shared/chat-thread';

describe('sidecarPathFor', () => {
  it('hides the sidecar next to its note', () => {
    expect(sidecarPathFor('daily/2026-09-26.md')).toBe('daily/.2026-09-26.chat.json');
    expect(sidecarPathFor('inbox.md')).toBe('.inbox.chat.json');
    expect(sidecarPathFor('a/b/c.MD')).toBe('a/b/.c.chat.json');
  });
});

describe('parseChatThread', () => {
  it('round-trips a serialized thread', () => {
    const thread = {
      version: 1 as const,
      notePath: 'daily/x.md',
      cards: [{ id: 'a', role: 'summary' as const, text: 'Kurz.', at: '2026-09-26T06:12:00' }],
    };
    expect(parseChatThread(serializeChatThread(thread), 'daily/x.md')).toEqual(thread);
  });

  it('degrades to an empty thread on unparseable or foreign content', () => {
    expect(parseChatThread('not json', 'a.md')).toEqual(emptyThread('a.md'));
    expect(parseChatThread('[]', 'a.md').cards).toEqual([]);
  });

  it('drops blank cards and defaults an unknown role to answer', () => {
    const thread = parseChatThread(
      JSON.stringify({ cards: [{ text: '  ' }, { text: 'hi', role: 'nonsense' }] }),
      'a.md',
    );
    expect(thread.cards).toEqual([{ id: 'card-1', role: 'answer', text: 'hi', at: '' }]);
  });

  it('reports whether a summary card exists', () => {
    expect(hasSummary(emptyThread('a.md'))).toBe(false);
    expect(
      hasSummary({
        version: 1,
        notePath: 'a.md',
        cards: [{ id: '1', role: 'summary', text: 'x', at: '' }],
      }),
    ).toBe(true);
  });
});

describe('historyForAsk', () => {
  const thread = (...roles: [ChatThread['cards'][number]['role'], string][]): ChatThread => ({
    version: 1,
    notePath: 'a.md',
    cards: roles.map(([role, text], i) => ({ id: `c${i}`, role, text, at: '' })),
  });

  it('maps question cards to user turns and summary/answer to assistant turns', () => {
    const messages = historyForAsk(
      thread(['summary', 'About X.'], ['question', 'Why?'], ['answer', 'Because.']),
    );
    expect(messages).toEqual([
      { role: 'assistant', content: 'Note summary: About X.' },
      { role: 'user', content: 'Why?' },
      { role: 'assistant', content: 'Because.' },
    ]);
  });

  it('drops a dangling trailing question so no two user turns are sent in a row', () => {
    const messages = historyForAsk(thread(['question', 'first'], ['answer', 'a'], ['question', 'x']));
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('caps to the most recent turns but keeps a leading summary', () => {
    const cards: [ChatThread['cards'][number]['role'], string][] = [['summary', 's']];
    for (let i = 0; i < 10; i++) {
      cards.push(['question', `q${i}`], ['answer', `a${i}`]);
    }
    const messages = historyForAsk(thread(...cards), 5);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toEqual({ role: 'assistant', content: 'Note summary: s' });
    expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: 'a9' });
  });

  it('is empty for a fresh thread', () => {
    expect(historyForAsk(emptyThread('a.md'))).toEqual([]);
  });
});
