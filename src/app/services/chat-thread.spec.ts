import {
  emptyThread,
  hasSummary,
  parseChatThread,
  serializeChatThread,
  sidecarPathFor,
} from '../../../shared/chat-thread';

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
