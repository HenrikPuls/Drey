import { describe, expect, it } from 'vitest';
import {
  appendMission,
  appendOwner,
  appendProposal,
  appendQuestion,
  appendSources,
  appendSplit,
  decideSplit,
  chatFileName,
  decideProposal,
  newSessionText,
  parseSessionFile,
  sessionSlug,
} from './chat-session';

const AT = new Date('2026-11-02T09:01:00Z');

describe('session file naming and creation', () => {
  it('mints a stamp-slug name', () => {
    expect(chatFileName(AT, 'Costs export!')).toBe('20261102-090100-costs-export.md');
    expect(sessionSlug('   ')).toBe('chat');
  });

  it('creates the strict canonical header', () => {
    expect(newSessionText('Quote "fix"', AT)).toBe(
      `---\ntitle: "Quote \\"fix\\""\ncreated: '2026-11-02T09:01:00.000Z'\n---\n\n`,
    );
  });
});

describe('append and parse round-trip', () => {
  function built(): string {
    let text = newSessionText('The chat', AT);
    text = appendOwner(text, AT, 'Move T-0086 to review');
    text = appendMission(text, AT, 'Done.', 'The owner wants T-0086 moved.');
    const proposal = appendProposal(text, AT, 'Move T-0086 from build to review', {
      kind: 'transition',
      id: 'T-0086',
      from: 'build',
      to: 'review',
    });
    text = decideProposal(proposal.text, AT, proposal.id, 'confirmed', 'tickets/30-review/T-0086.md')!;
    return text;
  }

  it('round-trips messages, thoughts and the decided proposal', () => {
    const session = parseSessionFile(built(), 'tickets/_meta/chat/20261102-090100-the-chat.md')!;
    expect(session.title).toBe('The chat');
    expect(session.messages).toEqual([
      { role: 'owner', text: 'Move T-0086 to review', at: '2026-11-02T09:01:00.000Z', thought: null },
      { role: 'mission', text: 'Done.', at: '2026-11-02T09:01:00.000Z', thought: 'The owner wants T-0086 moved.' },
    ]);
    expect(session.proposals).toEqual([
      {
        id: 'p-1',
        state: 'confirmed',
        summary: 'Move T-0086 from build to review',
        command: { kind: 'transition', id: 'T-0086', from: 'build', to: 'review' },
        at: '2026-11-02T09:01:00.000Z',
        decidedAt: '2026-11-02T09:01:00.000Z',
        outcome: 'tickets/30-review/T-0086.md',
      },
    ]);
  });

  it('mints sequential proposal ids and refuses decisions twice', () => {
    const first = appendProposal(newSessionText('x', AT), AT, 'one', {
      kind: 'setPriority',
      id: 'T-0086',
      priority: 'high',
    });
    expect(first.id).toBe('p-1');
    const second = appendProposal(first.text, AT, 'two', { kind: 'setPriority', id: 'T-0086', priority: 'low' });
    expect(second.id).toBe('p-2');
    const decided = decideProposal(second.text, AT, 'p-1', 'dismissed', null)!;
    expect(decideProposal(decided, AT, 'p-1', 'confirmed', null)).toBeNull();
    const session = parseSessionFile(decided, 'f');
    expect(session!.proposals.map((p) => p.state)).toEqual(['dismissed', 'pending']);
  });

  it('returns null for a file without a frontmatter fence', () => {
    expect(parseSessionFile('no frontmatter', 'f')).toBeNull();
  });

  it('forgives a hand-edited line instead of failing', () => {
    const text = `${built()}- not a machine line\n- '2026-11-02T10:00:00Z' owner — hand appended\n`;
    const session = parseSessionFile(text, 'f')!;
    expect(session.messages).toHaveLength(3);
    expect(session.messages[2]!.text).toBe('hand appended');
  });

  it('drops a proposal whose command block is broken', () => {
    const text = `${newSessionText('x', AT)}- '2026-11-02T09:01:00Z' proposal p-1 pending — Sneaky\n  \`\`\`json\n  {"kind":"archive","id":"T-0086"}\n  \`\`\`\n`;
    const session = parseSessionFile(text, 'f')!;
    expect(session.proposals).toEqual([]);
  });
});

describe('shape cards (E10-3)', () => {
  it('round-trips an answer card, a split proposal, its decision and the sources', () => {
    const at = new Date('2026-11-04T09:00:00Z');
    let text = newSessionText('Shape', at, 'T-0130');
    text = appendQuestion(text, at, 'Where should the report live?', [
      { label: 'docs/security/', recommended: true },
      { label: 'Tickets repo', recommended: false },
    ]);
    text = appendSources(text, at, ['CLAUDE.md', 'src/capture.ts']);
    text = appendSources(text, at, ['CLAUDE.md', 'ADR-0073.md']);
    text = appendSplit(text, at, 'Each part ships on its own', 3);
    const open = parseSessionFile(text, 'x.md')!;
    expect(open.sources).toEqual(['CLAUDE.md', 'src/capture.ts', 'ADR-0073.md']);
    expect(open.messages.map((m) => m.kind)).toEqual(['question', 'split']);
    expect(open.messages[0]!.options).toEqual([
      { label: 'docs/security/', recommended: true },
      { label: 'Tickets repo', recommended: false },
    ]);
    expect(open.messages[1]).toMatchObject({ text: 'Each part ships on its own', parts: 3, decision: null });

    const decided = decideSplit(text, at, 'keep', 'Keep as one ticket')!;
    expect(parseSessionFile(decided, 'x.md')!.messages[1]!.decision).toBe('keep');
    expect(decideSplit(decided, at, 'split', 'Split into 3 tickets')).toBeNull();
    expect(decideSplit(newSessionText('Plain', at), at, 'keep', 'x')).toBeNull();
  });

  it('skips a question with fewer than two readable choices', () => {
    const text = `---\ntitle: "x"\ncreated: '2026-11-04T09:00:00Z'\n---\n\n- '2026-11-04T09:00:01Z' question — Which?\n  \`\`\`json\n  {"options":[{"label":"A"}]}\n  \`\`\`\n`;
    expect(parseSessionFile(text, 'x.md')!.messages).toEqual([]);
  });
});
