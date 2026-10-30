import { describe, expect, it } from 'vitest';
import { refineTicket, replaceSection, revisionOf } from './ticket-refine';

/** req-66 R5: refining a ticket's sections and header from the remote. */

const TICKET = [
  '---',
  'id: T-0053',
  'title: "Phase chip moves the ticket"',
  'priority: normal',
  '# a comment the owner wrote',
  'rank: 5000',
  "entered-inbox: '2026-10-30T08:00:00Z'",
  '---',
  '',
  '## Description',
  '',
  'The chip is display only.',
  '',
  '## Plan',
  '',
  'Reuse the move list.',
  '',
  '### Acceptance criteria',
  '',
  '- [ ] `npm run test:plugin -- tickets`',
  '',
  '## Log',
  '',
  "- '2026-10-30T08:00:00Z' owner@desk — created in inbox",
  '',
].join('\n');

const NOW = new Date('2026-10-30T12:00:00Z');

describe('replaceSection', () => {
  it('replaces Plan up to its subsection, never into Acceptance criteria', () => {
    const out = replaceSection(TICKET.split('---\n')[2]!, 'plan', 'New plan.\n\n- step one');
    expect(out).toContain('## Plan\n\nNew plan.\n\n- step one\n\n### Acceptance criteria');
    expect(out).toContain('- [ ] `npm run test:plugin -- tickets`');
    expect(out).not.toContain('Reuse the move list.');
  });

  it('adds a missing Acceptance criteria at the end of Plan, a missing Description before the Log', () => {
    const body = '\n## Plan\n\nDo it.\n\n## Log\n\n- x\n';
    expect(replaceSection(body, 'acceptance', '- [ ] `npm test`')).toBe(
      '\n## Plan\n\nDo it.\n\n### Acceptance criteria\n\n- [ ] `npm test`\n\n## Log\n\n- x\n',
    );
    expect(replaceSection('\n## Log\n\n- x\n', 'description', 'Why.')).toBe('\n## Description\n\nWhy.\n\n## Log\n\n- x\n');
    expect(replaceSection('', 'plan', 'P')).toBe('## Plan\n\nP\n');
  });
});

describe('refineTicket', () => {
  it('rewrites the header and sections, keeps comments, logs what changed with the device', () => {
    const out = refineTicket(
      TICKET,
      { header: { title: 'The phase chip moves', priority: 'high' }, sections: { acceptance: '- [ ] `npm test`\n- [ ] Manual check' } },
      'owner@ipad',
      NOW,
    );
    expect(out).toContain('title: "The phase chip moves"');
    expect(out).toContain('priority: high');
    expect(out).toContain('# a comment the owner wrote');
    expect(out).toContain('### Acceptance criteria\n\n- [ ] `npm test`\n- [ ] Manual check\n\n## Log');
    expect(out).toContain("- '2026-10-30T12:00:00Z' owner@ipad — refined (title, priority, acceptance criteria)");
    expect(out).toContain('Reuse the move list.');
    expect(out.startsWith('---\nid: T-0053\n')).toBe(true);
  });

  it('refuses an empty patch and a file without frontmatter', () => {
    expect(() => refineTicket(TICKET, { header: {}, sections: {} }, 'owner@ipad', NOW)).toThrow('nothing to refine');
    expect(() => refineTicket('## Plan\n', { header: {}, sections: { plan: 'x' } }, 'owner@ipad', NOW)).toThrow('frontmatter');
  });

  it('a revision changes with any byte of the file', () => {
    expect(revisionOf(TICKET)).toHaveLength(16);
    expect(revisionOf(TICKET)).not.toBe(revisionOf(`${TICKET} `));
  });
});
