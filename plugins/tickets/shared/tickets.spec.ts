import { describe, expect, it } from 'vitest';
import {
  ageOf,
  branchForTicket,
  nextTicketId,
  openTicketCount,
  ticketOfBranch,
  type BoardSnapshot,
} from './tickets';

describe('branch rule', () => {
  it('is deterministic both ways', () => {
    expect(branchForTicket('T-0042')).toBe('t/T-0042');
    expect(ticketOfBranch('t/T-0042')).toBe('T-0042');
    expect(ticketOfBranch('feature/T-0042')).toBeNull();
    expect(ticketOfBranch('t/nope')).toBeNull();
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
        priority: 'normal' as const,
        rank: 5000,
        branch: `t/T-${i}`,
        claimedBy: null,
        claimedAt: null,
        run: null,
        references: [],
        parkedReason: null,
        parkedAt: null,
        entered: {},
      },
      pinned: false,
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
