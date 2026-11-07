import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a spec builds the real catalog; the plugin itself gets it as `api.i18n`
import { i18n } from '../../../shared/i18n';
import type { BoardSnapshot } from '../shared/tickets';
import { cardOfDocument, isTicketPath, logSectionRange, phaseOfTicketPath, showsTicketDocument, ticketIdOfPath, ticketIdOfText, ticketTabTitle } from './ticket-header';

describe('isTicketPath', () => {
  it('takes ticket files in any phase folder, archive included', () => {
    expect(isTicketPath('tickets/50-build/T-0042.md')).toBe(true);
    expect(isTicketPath('tickets/inbox/T-10000.md')).toBe(true);
    expect(isTicketPath('tickets/archive/T-0001.md')).toBe(true);
  });

  it('leaves meta files, stray names and other notes alone', () => {
    expect(isTicketPath('tickets/_meta/pipeline.md')).toBe(false);
    expect(isTicketPath('tickets/_meta/T-0042.md')).toBe(false);
    expect(isTicketPath('tickets/50-build/notes.md')).toBe(false);
    expect(isTicketPath('notes/T-0042.md')).toBe(false);
    expect(isTicketPath(null)).toBe(false);
  });
});

describe('phaseOfTicketPath', () => {
  it('strips the folder number', () => {
    expect(phaseOfTicketPath('tickets/40-plan-review/T-0042.md')).toBe('plan-review');
    expect(phaseOfTicketPath('tickets/inbox/T-0042.md')).toBe('inbox');
  });
});

describe('logSectionRange', () => {
  const TICKET = [
    '---',
    'id: T-0042',
    '---',
    '',
    '## Description',
    '',
    'Text.',
    '',
    '## Log',
    '',
    "- '2026-10-17T14:32:00Z' owner — created in inbox",
    "- '2026-10-17T15:01:12Z' owner — inbox -> prioritized",
    '',
  ].join('\n');

  it('spans from the end of the heading to the last Log line', () => {
    const range = logSectionRange(TICKET)!;
    expect(TICKET.slice(0, range.from).endsWith('## Log')).toBe(true);
    expect(TICKET.slice(range.to)).toBe('\n');
    expect(TICKET.slice(range.from, range.to)).toContain('inbox -> prioritized');
  });

  it('stops at the next level-1/2 heading, not at a level-3 one', () => {
    const text = '## Log\n\n- a\n### Note\n- b\n## Later\n\nx\n';
    const range = logSectionRange(text)!;
    expect(text.slice(range.from, range.to)).toBe('\n\n- a\n### Note\n- b');
  });

  it('ignores a "## Log" inside a code fence and an empty Log', () => {
    expect(logSectionRange('```\n## Log\n- a\n```\n')).toBeNull();
    expect(logSectionRange('## Log\n\n')).toBeNull();
    expect(logSectionRange('## Description\n\nx\n')).toBeNull();
  });
});

describe('ticketTabTitle', () => {
  it('reads T-0121 · Title from the title the model gives', () => {
    expect(ticketTabTitle(i18n, 'T-0121', 'Voice capture')).toBe('T-0121 · Voice capture');
  });

  it('shows the id alone for a ticket without a known title, never a path-derived guess', () => {
    expect(ticketTabTitle(i18n, 'T-0121', null)).toBe('T-0121');
    expect(ticketTabTitle(i18n, 'T-0121', '  ')).toBe('T-0121');
  });
});

describe('the dricket document path (E12-12)', () => {
  it('recognises tickets/<prefix>/<shard>/t-N/ticket.md and names its display id', () => {
    expect(isTicketPath('tickets/t/0000/t-63/ticket.md')).toBe(true);
    expect(ticketIdOfPath('tickets/t/0000/t-63/ticket.md')).toBe('T-0063');
    expect(ticketIdOfPath(['tickets', 't', '0001', 't-1204', 'ticket.md'].join(String.fromCharCode(92)))).toBe('T-1204');
  });

  it('keeps the files-backend shape and rejects look-alikes', () => {
    expect(ticketIdOfPath('tickets/50-build/T-0042.md')).toBe('T-0042');
    expect(isTicketPath('tickets/t/0009/t-63/ticket.md')).toBe(false);
    expect(isTicketPath('tickets/t/0000/t-63/notes.md')).toBe(false);
    expect(isTicketPath('notes/t/0000/t-63/ticket.md')).toBe(false);
  });
});

describe('a checkout inside a larger vault (D-25)', () => {
  const PREFIXED = 'work/store/tickets/t/0000/t-30/ticket.md';
  const board = { vaultId: 'meta', columns: [{ tickets: [{ id: 'T-0030', path: 'tickets/inbox/T-0030.md', phase: 'inbox' }] }] } as unknown as BoardSnapshot;

  it('the header draws: the id, the card, no phase from the folders', () => {
    expect(ticketIdOfPath(PREFIXED)).toBe('T-0030');
    expect(showsTicketDocument(board, 'big', PREFIXED)).toBe(true);
    expect(cardOfDocument(board, PREFIXED)?.id).toBe('T-0030');
    expect(phaseOfTicketPath(PREFIXED)).toBeNull();
  });

  it('a stray document of a ticket the board does not list stays a plain note', () => {
    expect(showsTicketDocument(board, 'big', 'work/store/tickets/t/0000/t-31/ticket.md')).toBe(false);
  });

  it('the files shape stays bound to the root of the board vault', () => {
    expect(ticketIdOfPath('work/tickets/50-build/T-0042.md')).toBeNull();
  });
});

describe('phaseOfTicketPath on a store document (D-23)', () => {
  it('reads no phase from prefix and shard, so the card decides', () => {
    expect(phaseOfTicketPath('tickets/t/0000/t-30/ticket.md')).toBeNull();
  });
});

describe('ticketIdOfText (D-23)', () => {
  it('reads both forms and names the display id', () => {
    expect(ticketIdOfText('---\nid: t-30\ntitle: x\n---\n')).toBe('T-0030');
    expect(ticketIdOfText('---\nid: t-1204\n---\n')).toBe('T-1204');
    expect(ticketIdOfText('---\nid: T-0042\n---\n')).toBe('T-0042');
    expect(ticketIdOfText("---\nid: 'T-0042'\n---\n")).toBe('T-0042');
  });

  it('agrees with the id the store path names', () => {
    const path = 'tickets/t/0000/t-30/ticket.md';
    expect(ticketIdOfText('---\nid: t-30\n---\n')).toBe(ticketIdOfPath(path));
  });

  it('is undefined without an id of either form', () => {
    expect(ticketIdOfText('---\nid: x-3\n---\n')).toBeUndefined();
    expect(ticketIdOfText('# no frontmatter\n')).toBeUndefined();
  });
});

describe('cardOfDocument (D-23)', () => {
  const files = { id: 'T-0042', path: 'tickets/50-build/T-0042.md', phase: 'build' };
  const stored = { id: 'T-0030', path: 'tickets/inbox/T-0030.md', phase: 'inbox' };
  const board = { columns: [{ tickets: [files, stored] }] } as unknown as BoardSnapshot;

  it('finds a files card by its path', () => {
    expect(cardOfDocument(board, 'tickets/50-build/T-0042.md')).toBe(files);
    expect(cardOfDocument(board, 'tickets/40-other/T-0042.md')).toBeNull();
  });

  it("finds a store card by the path's id: a dricket card's path is a stand-in", () => {
    expect(cardOfDocument(board, 'tickets/t/0000/t-30/ticket.md')).toBe(stored);
    expect(cardOfDocument(board, 'tickets/t/0000/t-31/ticket.md')).toBeNull();
  });

  it('finds nothing without a board or a path', () => {
    expect(cardOfDocument(null, 'tickets/t/0000/t-30/ticket.md')).toBeNull();
    expect(cardOfDocument(board, null)).toBeNull();
  });
});

describe('showsTicketDocument (D-23)', () => {
  const board = {
    vaultId: 'board',
    columns: [{ tickets: [{ id: 'T-0063' }] }],
  } as unknown as BoardSnapshot;

  it('shows a files-backend ticket only in the board vault', () => {
    expect(showsTicketDocument(board, 'board', 'tickets/50-build/T-0042.md')).toBe(true);
    expect(showsTicketDocument(board, 'other', 'tickets/50-build/T-0042.md')).toBe(false);
  });

  it('shows a store document from the checkout vault when the board lists the ticket', () => {
    expect(showsTicketDocument(board, 'checkout', 'tickets/t/0000/t-63/ticket.md')).toBe(true);
    expect(showsTicketDocument(board, 'checkout', ['tickets', 't', '0000', 't-63', 'ticket.md'].join(String.fromCharCode(92)))).toBe(true);
  });

  it('keeps a stray store-shaped file plain when the board does not know the ticket', () => {
    expect(showsTicketDocument(board, 'checkout', 'tickets/t/0000/t-64/ticket.md')).toBe(false);
  });

  it('shows nothing without a board or off a ticket path', () => {
    expect(showsTicketDocument(null, 'board', 'tickets/50-build/T-0042.md')).toBe(false);
    expect(showsTicketDocument({ ...board, vaultId: null } as unknown as BoardSnapshot, null, 'tickets/50-build/T-0042.md')).toBe(false);
    expect(showsTicketDocument(board, 'board', 'tickets/_meta/pipeline.md')).toBe(false);
    expect(showsTicketDocument(board, 'board', null)).toBe(false);
  });
});
