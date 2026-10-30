import { describe, expect, it } from 'vitest';
import {
  ageOf,
  averageDwellMs,
  branchForTicket,
  dwellMs,
  nextTicketId,
  openTicketCount,
  spanWords,
  phaseDirectoryName,
  stripPhasePrefix,
  ticketOfBranch,
  timeOnBoardMs,
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
      pinned: false,
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

describe('cycle-time metrics (M85)', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');

  function timedCard(entered: Record<string, string>): TicketCard {
    return {
      id: 'T-0001',
      path: 'tickets/plan/T-0001.md',
      phase: 'plan',
      meta: {
        id: 'T-0001',
        title: null,
        repo: null,
        repos: [],
        worker: null,
        priority: 'normal',
        rank: 5000,
        branch: null,
        claimedBy: null,
        claimedAt: null,
        run: null,
        references: [],
        blockedBy: [],
        parkedReason: null,
        parkedAt: null,
      interactive: false,
        entered,
      },
      pinned: false,
      worker: 'opencode',
      blocked: [],
      blocks: [],
      issues: [],
    };
  }

  it('spanWords reads like a human wrote it', () => {
    expect(spanWords(30_000)).toBe('now');
    expect(spanWords(5 * 60_000)).toBe('5m');
    expect(spanWords(3 * 3_600_000)).toBe('3h');
    expect(spanWords(50 * 3_600_000)).toBe('2d');
    expect(spanWords(-1)).toBe('');
  });

  it('dwell reads the column stamp; time on board takes the earliest', () => {
    const card = timedCard({
      inbox: '2026-10-16T12:00:00Z',
      plan: '2026-10-18T10:00:00Z',
    });
    expect(dwellMs(card, 'plan', now)).toBe(2 * 3_600_000);
    expect(dwellMs(card, 'build', now)).toBeNull();
    expect(timeOnBoardMs(card, now)).toBe(48 * 3_600_000);
  });

  it('the column average ignores unstampable tickets and returns null when none', () => {
    const tickets = [
      timedCard({ plan: '2026-10-18T09:00:00Z' }),
      timedCard({ plan: '2026-10-18T11:00:00Z' }),
      timedCard({}),
    ];
    expect(averageDwellMs(tickets, 'plan', now)).toBe(2 * 3_600_000);
    expect(averageDwellMs(tickets, 'build', now)).toBeNull();
  });
});
