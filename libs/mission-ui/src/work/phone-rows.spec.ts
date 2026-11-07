import { describe, expect, it } from 'vitest';
import { McI18n } from '../i18n/i18n.service';
import { phoneGroupsFiltered, phoneGroupsOf, todayCostTextOf, todayOfPersonas } from './phone-rows';
import { groupsOf, withoutNeedCopies, type McBoard, type McLiveRunSlice, type McNeed } from './work.model';

const i18n = new McI18n();
const t = i18n.t.bind(i18n);
const NOW = Date.parse('2026-11-07T14:10:00Z');

const ticket = (id: string, phase: string, title: string, minutesAgo = 0) => ({
  id,
  phase,
  meta: { id, title, entered: { [phase]: new Date(NOW - minutesAgo * 60_000).toISOString() } },
  blocked: [],
});
const column = (id: string, title: string, tickets: ReturnType<typeof ticket>[]) => ({ phase: { id, title }, tickets });

const BOARD = {
  columns: [
    column('inbox', 'Inbox', [ticket('T-1', 'inbox', 'Idea')]),
    column('plan', 'Shaping', [ticket('T-2', 'plan', 'Plan me', 12), ticket('T-3', 'plan', 'Quiet plan', 60)]),
    column('prioritized', 'Prioritized', [ticket('T-4', 'prioritized', 'Next')]),
    column('build', 'Building', [ticket('T-5', 'build', 'Asks', 4), ticket('T-6', 'build', 'Stuck', 30), ticket('T-7', 'build', 'Waits')]),
    column('review', 'Ready to try', [ticket('T-8', 'review', 'Try me', 20)]),
    column('done', 'Done', []),
  ],
  recentDone: [{ id: 'T-9', title: 'Shipped' }],
} as unknown as McBoard;

const NEEDS: McNeed[] = [
  { kind: 'question', ticketId: 'T-5', title: 'Asks', summary: 'Which?' },
  { kind: 'checkpoint', ticketId: 'T-2', title: 'Plan me', summary: '' },
  { kind: 'checkpoint', ticketId: 'T-8', title: 'Try me', summary: '' },
];
const RUNS: McLiveRunSlice[] = [
  { ticketId: 'T-5', stuck: false, startedAt: new Date(NOW - 4 * 60_000).toISOString(), lastActivity: new Date(NOW).toISOString() },
  { ticketId: 'T-6', stuck: true, startedAt: new Date(NOW - 30 * 60_000).toISOString(), lastActivity: new Date(NOW - 9 * 60_000).toISOString() },
];

const groups = () => {
  const all = groupsOf(NEEDS, BOARD, []);
  return phoneGroupsOf(all, withoutNeedCopies(all), BOARD.recentDone ?? [], RUNS, NOW, t);
};

describe('the phone Work list (board 10c)', () => {
  it('orders the groups: what needs you, what runs, then the folded rest', () => {
    expect(groups().map((g) => [g.title, g.rows.length, g.startsOpen])).toEqual([
      ['Needs you', 3, true],
      ['Running', 2, true],
      ['Shaping', 1, true],
      ['Prioritized', 1, false],
      ['Inbox', 1, false],
      ['Done this week', 1, false],
    ]);
  });

  it('words a row: id, state, what it waits for, how long', () => {
    const [needs, running] = groups();
    expect(needs!.rows.map((row) => row.meta)).toEqual([
      'T-5 · Building · question · 4 min',
      'T-2 · Shaping · plan to accept · 12 min',
      'T-8 · Ready to try · 20 min',
    ]);
    expect(running!.rows.map((row) => row.meta)).toEqual(['T-6 · Building · stuck 9 min', 'T-7 · Building · queued']);
  });

  it('sends only a plan waiting in Shaping to the plan to accept', () => {
    expect(groups()[0]!.rows.map((row) => row.plan)).toEqual([false, true, false]);
  });

  it('the search narrows by id or title and opens what it finds', () => {
    const found = phoneGroupsFiltered(groups(), 'next');
    expect(found.map((g) => [g.title, g.startsOpen, g.rows.length])).toEqual([['Prioritized', true, 1]]);
    expect(phoneGroupsFiltered(groups(), '  ').length).toBe(6);
  });
});

describe("today's cost (boards 10c, 10i)", () => {
  it('sums what is known and never reads a missing figure as zero', () => {
    expect(todayOfPersonas([{ dailyCost: 1.1, budget: 5 }, { budget: 10 }, { dailyCost: 3 }])).toEqual({ cost: 4.1, budget: 15 });
    expect(todayOfPersonas([{}])).toEqual({ cost: null, budget: null });
    expect(todayOfPersonas(null)).toBeNull();
  });

  it('writes it, the whole budget without cents', () => {
    expect(todayCostTextOf({ cost: 4.1, budget: 15 }, t)).toBe('$4.10 of $15 today');
    expect(todayCostTextOf({ cost: 4.1, budget: null }, t)).toBe('$4.10 today');
    expect(todayCostTextOf({ cost: null, budget: 15 }, t)).toBeNull();
    expect(todayCostTextOf(null, t)).toBeNull();
  });
});
