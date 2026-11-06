import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a spec builds the real catalog; the plugin itself gets it as `api.i18n`
import { i18n } from '../../../shared/i18n';
import { isTicketPath, logSectionRange, phaseOfTicketPath, ticketIdOfPath, ticketTabTitle } from './ticket-header';

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
