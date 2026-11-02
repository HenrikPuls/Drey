import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIORITY_CONFIG,
  ageOf,
  branchForTicket,
  archivedTicketIds,
  nextTicketId,
  openTicketCount,
  parsePriorityConfig,
  phaseDirectoryName,
  priorityClass,
  priorityWeight,
  stripPhasePrefix,
  ticketOfBranch,
  titleFromDescription,
  type BoardSnapshot,
  type TicketCard,
} from './tickets';

describe('branch rule', () => {
  it('is deterministic both ways', () => {
    expect(branchForTicket('T-0042')).toBe('t/T-0042');
    expect(ticketOfBranch('t/T-0042')).toBe('T-0042');
    expect(ticketOfBranch('feature/T-0042')).toBeNull();
    expect(ticketOfBranch('t/nope')).toBeNull();
  });
});

describe('numbered phase folders (T-0041)', () => {
  it('stripPhasePrefix removes a leading number dash, tolerates the rest', () => {
    expect(stripPhasePrefix('10-inbox')).toBe('inbox');
    expect(stripPhasePrefix('35-qa')).toBe('qa');
    expect(stripPhasePrefix('100-done')).toBe('done');
    expect(stripPhasePrefix('inbox')).toBe('inbox');
    expect(stripPhasePrefix('_meta')).toBe('_meta');
    expect(stripPhasePrefix('archive')).toBe('archive');
  });

  it('phaseDirectoryName derives the pipeline position × 10, two digits', () => {
    expect(phaseDirectoryName(1, 'inbox')).toBe('10-inbox');
    expect(phaseDirectoryName(4, 'plan-review')).toBe('40-plan-review');
    expect(phaseDirectoryName(8, 'done')).toBe('80-done');
    expect(phaseDirectoryName(10, 'extra')).toBe('100-extra');
  });
});

describe('nextTicketId', () => {
  it('mints max + 1, zero-padded to four digits', () => {
    expect(nextTicketId([])).toBe('T-0001');
    expect(nextTicketId(['T-0003', 'T-0007'])).toBe('T-0008');
  });

  it('never reuses a burned id and grows past four digits', () => {
    expect(nextTicketId(['T-9999'])).toBe('T-10000');
    expect(nextTicketId(['T-0002', 'T-10000'])).toBe('T-10001');
  });

  it('ignores non-id strings', () => {
    expect(nextTicketId(['readme', 'T-0001'])).toBe('T-0002');
  });

  it('counts archived ids, so an archived id is never minted again', () => {
    const archived = archivedTicketIds(['tickets/archive/T-0053.md', 'tickets/10-inbox/T-0050.md', 'tickets/archive/x/T-0099.md', 'notes/T-0060.md']);
    expect(archived).toEqual(['T-0053']);
    expect(nextTicketId(['T-0050', ...archived])).toBe('T-0054');
  });
});

describe('ageOf', () => {
  const now = Date.parse('2026-10-17T14:00:00Z');

  it('formats coarse ages', () => {
    expect(ageOf('2026-10-17T13:59:30Z', now)).toBe('now');
    expect(ageOf('2026-10-17T13:30:00Z', now)).toBe('30m');
    expect(ageOf('2026-10-17T10:00:00Z', now)).toBe('4h');
    expect(ageOf('2026-10-13T14:00:00Z', now)).toBe('4d');
  });

  it('is empty for missing or unreadable stamps', () => {
    expect(ageOf(null, now)).toBe('');
    expect(ageOf('not a date', now)).toBe('');
  });
});

describe('openTicketCount', () => {
  const column = (id: string, n: number) => ({
    phase: { id, title: id, wip: null, claim: false, handover: 'manual' },
    unknown: false,
    tickets: Array.from({ length: n }, (_, i) => ({
      id: `T-${i}`,
      path: `tickets/${id}/T-${i}.md`,
      phase: id,
      meta: {
        id: `T-${i}`,
        title: null,
        repo: null,
      repos: [],
        priority: 'normal' as const,
        rank: 5000,
        branch: `t/T-${i}`,
        claimedBy: null,
        claimedAt: null,
        run: null,
        references: [],
        blockedBy: [],
        parkedReason: null,
        parkedAt: null,
      interactive: false,
        entered: {},
      },
      blocked: [],
      blocks: [],
      issues: [],
    })),
  });

  it('counts everything outside the last phase', () => {
    const snapshot = {
      columns: [column('inbox', 2), column('build', 1), column('done', 5)],
    } as unknown as BoardSnapshot;
    expect(openTicketCount(snapshot)).toBe(3);
  });

  it('is zero without columns', () => {
    expect(openTicketCount({ columns: [] } as unknown as BoardSnapshot)).toBe(0);
  });
});

describe('titleFromDescription (req-75 W5b)', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(titleFromDescription('\n\n  Fix the flare  \nsecond line')).toBe('Fix the flare');
  });

  it('returns the short line unchanged — no ellipsis', () => {
    expect(titleFromDescription('Outline panel should scroll')).toBe('Outline panel should scroll');
  });

  it('cuts at 80 characters on a word boundary and appends the ellipsis', () => {
    const title = titleFromDescription('word '.repeat(30).trim());
    expect(title).toBe(`${'word '.repeat(15)}word…`);
    expect(title.length).toBe(80);
  });

  it('hard-cuts a single word longer than 80 characters', () => {
    expect(titleFromDescription(`x${'a'.repeat(90)}`)).toBe(`x${'a'.repeat(79)}…`);
  });

  it('is empty for empty or whitespace-only text', () => {
    expect(titleFromDescription('')).toBe('');
    expect(titleFromDescription(' \n\t\n  ')).toBe('');
  });
});


describe('priority vocabulary (M111)', () => {
  it('defaults to the four-word list with normal as the default read', () => {
    expect(DEFAULT_PRIORITY_CONFIG.order).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(DEFAULT_PRIORITY_CONFIG.default).toBe('normal');
  });

  it('absent priorities read silently as the default vocabulary', () => {
    expect(parsePriorityConfig(undefined)).toEqual({ config: DEFAULT_PRIORITY_CONFIG, issues: [] });
    expect(parsePriorityConfig(null)).toEqual({ config: DEFAULT_PRIORITY_CONFIG, issues: [] });
  });

  it('parses a configured list in weight order; the middle entry is the default read', () => {
    const { config, issues } = parsePriorityConfig(['critical', 'high', 'medium', 'low']);
    expect(issues).toEqual([]);
    expect(config.order).toEqual(['critical', 'high', 'medium', 'low']);
    expect(config.default).toBe('medium');
    const odd = parsePriorityConfig(['p0', 'p1', 'p2']).config;
    expect(odd.default).toBe('p1');
  });

  it('forgives a non-list and an empty list with a noise finding and the default vocabulary', () => {
    expect(parsePriorityConfig('urgent')).toEqual({
      config: DEFAULT_PRIORITY_CONFIG,
      issues: [{ level: 'noise', message: 'priorities must be a list of ids — the default vocabulary applies' }],
    });
    const empty = parsePriorityConfig([]);
    expect(empty.config).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(empty.issues).toEqual([{ level: 'noise', message: 'priorities is empty — the default vocabulary applies' }]);
  });

  it('drops unreadable ids and duplicates with a noise finding each', () => {
    const { config, issues } = parsePriorityConfig(['critical', 'Critical', 3, 'critical', 'low']);
    expect(config.order).toEqual(['critical', 'low']);
    expect(issues.map((i) => i.level)).toEqual(['noise', 'noise', 'noise']);
    expect(issues[0]!.message).toContain('"Critical"');
    expect(issues[2]!.message).toContain('twice');
  });

  it('weights by configured index; an unknown id sorts last', () => {
    const config = parsePriorityConfig(['critical', 'high', 'medium', 'low']).config;
    expect(priorityWeight('critical', config)).toBe(0);
    expect(priorityWeight('low', config)).toBe(3);
    expect(priorityWeight('urgent', config)).toBe(4);
    expect(priorityWeight('whatever', config)).toBe(4);
    expect(priorityWeight('low')).toBe(3);
  });

  it('the jump class is the upper half of the vocabulary — urgent/high in the default list', () => {
    expect(priorityClass('urgent')).toBe(0);
    expect(priorityClass('high')).toBe(0);
    expect(priorityClass('normal')).toBe(1);
    expect(priorityClass('low')).toBe(1);
    const three = parsePriorityConfig(['p0', 'p1', 'p2']).config;
    expect(priorityClass('p0', three)).toBe(0);
    expect(priorityClass('p1', three)).toBe(1);
    expect(priorityClass('p2', three)).toBe(1);
    expect(priorityClass('unknown')).toBe(1);
  });
});
