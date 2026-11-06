// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import {
  phaseWithoutPoolKeys,
  type BoardColumn,
  type BoardSnapshot,
  type PipelinePhase,
  type TicketCard,
} from '../shared/tickets';
import { createGroupFoldStore, workListLivePaint, workListNode } from './work-panel';

/** req-75 W1b: the Work list's DOM over the default eight-phase pipeline —
 *  the canvas's five groups, the rows' chips and the fold store. */

const phase = (id: string, handover: string): PipelinePhase =>
  phaseWithoutPoolKeys({ id, title: id[0]!.toUpperCase() + id.slice(1), wip: null, claim: false, handover });

const PIPELINE: readonly PipelinePhase[] = [
  phase('inbox', 'manual'),
  phase('prioritized', 'manual'),
  phase('plan', 'agent plan-default'),
  phase('plan-review', 'manual'),
  phase('build', 'agent build-default'),
  phase('review', 'manual'),
  phase('commit', 'agent commit-default'),
  phase('done', 'none'),
];

const card = (id: string, at: string, opts: { track?: 'auto' | 'shape' | null; interactive?: boolean } = {}): TicketCard =>
  ({
    id,
    path: `tickets/${at}/${id}.md`,
    phase: at,
    worker: 'opencode',
    meta: {
      title: `Ticket ${id}`,
      priority: 'normal',
      track: opts.track ?? null,
      parkedReason: null,
      claimedBy: null,
      interactive: opts.interactive ?? false,
      entered: { inbox: '2026-10-30T10:00:00Z' },
    },
    blocked: [],
    blocks: [],
    issues: [],
  }) as unknown as TicketCard;

const board = (
  placed: Record<string, readonly TicketCard[]>,
  recentDone: BoardSnapshot['recentDone'] = [],
): BoardSnapshot =>
  ({
    columns: PIPELINE.map((p): BoardColumn => ({ phase: p, unknown: false, tickets: placed[p.id] ?? [] })),
    checkpoints: ['plan-review', 'review', 'done'],
    recentDone,
  }) as unknown as BoardSnapshot;

const api = { ui: { icon: () => document.createElement('span') } } as unknown as DreyPluginApi;

const deps = () => ({
  api,
  openTicket: vi.fn(),
  setPriority: vi.fn(),
  setTrack: vi.fn(),
  openMenu: vi.fn(),
  clearFilter: vi.fn(),
});

const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage;
};

const titles = (list: HTMLElement): string[] =>
  [...list.querySelectorAll('.work-group-title')].map((n) => n.textContent ?? '');

describe('workListNode', () => {
  it('draws the fleet alerts above every group; Resume plays the column', () => {
    const onAlertAction = vi.fn();
    const action = { kind: 'play-column' as const, phase: 'build', label: 'Resume' };
    const list = workListNode(
      {
        ...deps(),
        alerts: [{ kind: 'breaker', key: 'breaker:build:', title: 'Build stopped by the circuit breaker', text: '3 red gates in a row', action }],
        onAlertAction,
      },
      board({ build: [card('T-0002', 'build')] }),
      [],
      createGroupFoldStore(null),
      () => undefined,
    );
    expect(list.firstElementChild?.classList.contains('work-alerts')).toBe(true);
    const alert = list.querySelector<HTMLElement>('.work-alert')!;
    expect(alert.dataset['kind']).toBe('breaker');
    expect(alert.querySelector('.work-alert-title')?.textContent).toBe('Build stopped by the circuit breaker');
    alert.querySelector<HTMLButtonElement>('.work-alert-action')!.click();
    expect(onAlertAction).toHaveBeenCalledWith(action);
  });

  it('shows Running before Ideas, hides Needs you and Shaping while empty', () => {
    const list = workListNode(deps(), board({ inbox: [card('T-0001', 'inbox')], build: [card('T-0002', 'build')] }), [], createGroupFoldStore(null), () => undefined);
    expect(titles(list)).toEqual(['Running', 'Inbox']);
    expect(list.querySelectorAll('.work-row')).toHaveLength(2);
  });

  it('marks running rows and counts them in the Running head (T-0084)', () => {
    const runA = {
      id: 'r1',
      ticketId: 'T-0002',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-30T10:00:00Z',
      endedAt: null,
      gateFailure: null,
    } as unknown as RunInfo;
    const list = workListNode(
      deps(),
      board({ inbox: [card('T-0001', 'inbox')], build: [card('T-0002', 'build'), card('T-0003', 'build')] }),
      [runA],
      createGroupFoldStore(null),
      () => undefined,
    );
    expect(list.querySelector('.work-group-running .work-group-count')?.textContent).toBe('2 · 1 running');
    expect(list.querySelector<HTMLElement>('.work-row[data-id="T-0002"]')!.dataset['running']).toBe('true');
    expect(list.querySelector<HTMLElement>('.work-row[data-id="T-0003"]')!.hasAttribute('data-running')).toBe(false);
  });

  it('renders the phase as plain grey words inside the one meta line (E12-11)', () => {
    const list = workListNode(deps(), board({ build: [card('T-0002', 'build')] }), [], createGroupFoldStore(null), () => undefined);
    const phase = list.querySelector<HTMLElement>('.work-row .work-row-meta .work-meta-phase')!;
    expect(phase.title).toBe('Build');
    expect(phase.textContent).toBe('Build');
    expect(list.querySelector('.work-phase-dot, .work-phase-chip')).toBeNull();
  });

  it('a filter hides rows, shows visible/total, and the marker clears it (T-0084)', () => {
    const d = deps();
    const list = workListNode(
      d,
      board({ inbox: [card('T-0001', 'inbox')], prioritized: [card('T-0002', 'prioritized')] }),
      [],
      createGroupFoldStore(null),
      () => undefined,
      { phases: ['prioritized'], statuses: [] },
    );
    // The queued idea is the Prioritized group's (E13-8); Ideas keeps the inbox one.
    expect(list.querySelector('.work-group-prioritized .work-group-count')?.textContent).toBe('1/1');
    expect(list.querySelectorAll('.work-group-prioritized .work-row')).toHaveLength(1);
    expect(list.querySelector('.work-group-ideas .work-group-count')?.textContent).toBe('0/1');
    expect(list.querySelector('.work-group-running .work-group-empty')?.textContent).toBe('Nothing running');
    const hidden = workListNode(
      d,
      board({ inbox: [card('T-0001', 'inbox')] }),
      [],
      createGroupFoldStore(null),
      () => undefined,
      { phases: ['build'], statuses: [] },
    );
    const marker = hidden.querySelector<HTMLButtonElement>('.work-group-ideas .work-hidden-by-filter')!;
    expect(marker.textContent).toBe('Hidden by the filter — clear');
    expect(marker.title).toBe('Show everything again');
    marker.click();
    expect(d.clearFilter).toHaveBeenCalledOnce();
  });

  it('a finished ticket sits under Needs you with its kind chip — the buttons live in the thread now', () => {
    const d = deps();
    const list = workListNode(d, board({ done: [card('T-0003', 'done')] }), [], createGroupFoldStore(null), () => undefined);
    expect(titles(list)[0]).toBe('Needs you');
    const row = list.querySelector<HTMLElement>('.work-group-needs .work-row')!;
    expect(row.querySelector('.work-kind')?.textContent).toBe('Ready to try');
    expect(row.querySelector('.work-row-line')?.textContent).toBe('checks green');
    expect(row.querySelector('.work-action')).toBeNull();
    expect(row.querySelector('button.work-action')).toBeNull();
  });

  it('a checkpoint after the plan column reads as a plan to accept', () => {
    const list = workListNode(deps(), board({ 'plan-review': [card('T-0004', 'plan-review')] }), [], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-group-needs .work-row')!;
    expect(row.querySelector('.work-kind')?.textContent).toBe('Plan to accept');
    expect(row.querySelector('.work-row-line')?.textContent).toBe('plan ready');
  });

  it('an interactive ticket shapes: the group shows, with the dialog not started', () => {
    const list = workListNode(deps(), board({ inbox: [card('T-0005', 'inbox', { interactive: true })] }), [], createGroupFoldStore(null), () => undefined);
    expect(titles(list)).toEqual(['Running', 'Shaping', 'Inbox']);
    // The sub line leads with the phase chip (T-0084), the dialog text follows.
    const sub = list.querySelector('.work-group-shaping .work-row-sub')!;
    expect(sub.querySelector('.work-meta-phase')?.textContent).toBe('Inbox');
    expect(sub.querySelector('.work-row-line')?.textContent).toBe('Dialog not started');
  });

  it('lists the queued ideas under Prioritized, waiting for their persona, and gives ideas their track chip', () => {
    const placed = {
      // Same priority and stamp: newest id first inside Ideas.
      inbox: [card('T-0006', 'inbox', { track: 'auto' }), card('T-0007', 'inbox', { track: 'shape' })],
      prioritized: [card('T-0008', 'prioritized')],
    };
    const list = workListNode(deps(), board(placed), [], createGroupFoldStore(null), () => undefined);
    const queued = [...list.querySelectorAll<HTMLElement>('.work-group-prioritized .work-row')];
    expect(queued.map((row) => row.dataset['id'])).toEqual(['T-0008']);
    expect(queued[0]!.querySelector('.work-row-queued')?.textContent).toBe('Queued');
    const rows = [...list.querySelectorAll<HTMLElement>('.work-group-ideas .work-row')];
    expect(rows.map((row) => row.dataset['id'])).toEqual(['T-0007', 'T-0006']);
    expect(rows[0]!.querySelector('.work-track')?.textContent).toBe('Shape');
    expect(rows[1]!.querySelector('.work-track')?.textContent).toBe('Auto');
  });

  it('every row carries the persona and the cost, and a Prioritized row says who it waits for (E13-8)', () => {
    const withCost = (id: string, at: string, cost: number | null, persona: string | null): TicketCard => {
      const base = card(id, at);
      return {
        ...base,
        meta: { ...base.meta, persona },
        ...(cost === null ? {} : { usage: { tokensIn: 1, tokensOut: 1, cost, runs: 1 } }),
      } as unknown as TicketCard;
    };
    const d = { ...deps(), personaName: (id: string) => id.toUpperCase() };
    const list = workListNode(
      d,
      board({
        inbox: [withCost('T-0001', 'inbox', null, null)],
        prioritized: [withCost('T-0002', 'prioritized', 0.5, 'ben')],
        build: [withCost('T-0003', 'build', 1.2, 'ben')],
      }),
      [],
      createGroupFoldStore(null),
      () => undefined,
    );
    const build = list.querySelector<HTMLElement>('.work-group-running [data-id="T-0003"]')!;
    expect(build.querySelector('.work-row-persona')?.textContent).toBe('BEN');
    expect(build.querySelector('.work-row-cost')?.textContent).toBe('$1.20');
    expect(build.querySelector<HTMLElement>('.work-row-cost')?.title).toBe('So far');
    const queued = list.querySelector<HTMLElement>('.work-group-prioritized [data-id="T-0002"]')!;
    expect(queued.querySelector('.work-row-queued')?.textContent).toBe('waits for BEN');
    expect(queued.querySelector('.work-row-cost')?.textContent).toBe('$0.50');
    // No known cost, no persona: nothing is invented.
    const idea = list.querySelector<HTMLElement>('.work-group-ideas [data-id="T-0001"]')!;
    expect(idea.querySelector('.work-row-cost')).toBeNull();
    expect(idea.querySelector('.work-row-persona')).toBeNull();
  });

  it('shows the first five ideas, then "<n> more" unfolds the rest (remembered)', () => {
    const storage = memoryStorage();
    const folds = createGroupFoldStore(storage);
    const rerender = vi.fn();
    const placed: Record<string, readonly TicketCard[]> = {
      inbox: Array.from({ length: 7 }, (_, i) => card(`T-00${10 + i}`, 'inbox')),
    };
    const list = workListNode(deps(), board(placed), [], folds, rerender);
    expect(list.querySelectorAll('.work-group-ideas .work-row')).toHaveLength(5);
    const more = list.querySelector<HTMLButtonElement>('.work-ideas-more')!;
    expect(more.textContent).toBe('2 more');
    more.click();
    expect(rerender).toHaveBeenCalledOnce();
    const open = workListNode(deps(), board(placed), [], createGroupFoldStore(storage), () => undefined);
    expect(open.querySelectorAll('.work-group-ideas .work-row')).toHaveLength(7);
    expect(open.querySelector('.work-ideas-more')?.textContent).toBe('Show fewer');
  });

  it('a running row carries the dot, the step word and the activity line', () => {
    const run = {
      id: 'r1',
      ticketId: 'T-0009',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-30T10:00:00Z',
      endedAt: null,
      gateFailure: null,
      activity: 'edit electron/capture-hotkey.ts',
    } as unknown as RunInfo;
    const list = workListNode(deps(), board({ build: [card('T-0009', 'build')] }), [run], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-group-running .work-row')!;
    expect(row.querySelector('.work-run-step')?.textContent).toBe('Building');
    expect(row.querySelector('.work-run-line')?.textContent).toBe('edit electron/capture-hotkey.ts');
    expect(row.querySelector('.work-run-dot-queued')).toBeNull();
  });

  it('always mounts the run line span, hidden while the worker says nothing', () => {
    const run = {
      id: 'r4',
      ticketId: 'T-0020',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-31T11:00:00Z',
      endedAt: null,
      gateFailure: null,
    } as unknown as RunInfo;
    const snap = board({ build: [card('T-0020', 'build')] });
    const list = workListNode(deps(), snap, [run], createGroupFoldStore(null), () => undefined);
    const line = list.querySelector<HTMLElement>('.work-group-running .work-run-line')!;
    expect(line.hidden).toBe(true);
    workListLivePaint(list, deps(), snap, [{ ...run, activity: 'reading board.ts' } as RunInfo]);
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe('reading board.ts');
  });

  it('opens the ticket on a row click and the menu on the ⋯ button', () => {
    const d = deps();
    const list = workListNode(d, board({ inbox: [card('T-0010', 'inbox')] }), [], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-row')!;
    row.click();
    expect(d.openTicket).toHaveBeenCalledOnce();
    row.querySelector<HTMLButtonElement>('.work-row-more')!.click();
    expect(d.openMenu).toHaveBeenCalledOnce();
    expect(d.openTicket).toHaveBeenCalledOnce();
  });

  it('folds a group and keeps the fold in the store', () => {
    const storage = memoryStorage();
    const folds = createGroupFoldStore(storage);
    const rerender = vi.fn();
    const list = workListNode(deps(), board({ inbox: [card('T-0011', 'inbox')] }), [], folds, rerender);
    list.querySelector<HTMLButtonElement>('.work-group-ideas .work-group-head')!.click();
    expect(rerender).toHaveBeenCalledOnce();
    expect(createGroupFoldStore(storage).isFolded('ideas')).toBe(true);
    const folded = workListNode(deps(), board({ inbox: [card('T-0011', 'inbox')] }), [], folds, rerender);
    expect(folded.querySelector('.work-group-ideas .work-row')).toBeNull();
  });

  it('a question from a live run sits under Needs you as its kind chip and text', () => {
    const run = {
      id: 'r2',
      ticketId: 'T-0012',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-30T10:00:00Z',
      endedAt: null,
      gateFailure: null,
      steerCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      waiting: { kind: 'question', text: 'Which file?', since: '2026-10-30T10:05:00Z' },
    } as unknown as RunInfo;
    const list = workListNode(deps(), board({ build: [card('T-0012', 'build')] }), [run], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-group-needs .work-row')!;
    expect(row.querySelector('.work-kind')?.textContent).toBe('Question');
    expect(row.querySelector('.work-row-line')?.textContent).toBe('Which file?');
  });

  it('a shaped question shows its question — the option pills live in the thread (req-75 W2)', () => {
    const run = {
      id: 'r3',
      ticketId: 'T-0013',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-30T10:00:00Z',
      endedAt: null,
      gateFailure: null,
      steerCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      waiting: {
        kind: 'question',
        text: 'Which database?\nTicket: the store\nOptions:\n1. SQLite — no server\n2. Postgres — one server',
        since: '2026-10-30T10:05:00Z',
        shaped: {
          question: 'Which database?',
          context: 'the store',
          where: null,
          why: null,
          options: [
            { n: 1, label: 'SQLite', consequence: 'no server' },
            { n: 2, label: 'Postgres', consequence: 'one server' },
          ],
          recommended: 1,
          recommendationWhy: null,
        },
      },
    } as unknown as RunInfo;
    const list = workListNode(deps(), board({ build: [card('T-0013', 'build')] }), [run], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-group-needs .work-row')!;
    expect(row.querySelector('.work-row-line')?.textContent).toBe('Which database?');
    expect(row.querySelectorAll('.tickets-pill')).toHaveLength(0);
  });

  it('Done this week starts folded and unfolds to the archived tickets', () => {
    const folds = createGroupFoldStore(null);
    expect(folds.isFolded('done')).toBe(true);
    const rerender = vi.fn();
    const snap = board({}, [
      { id: 'T-0014', title: 'Fix the palette race', at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
      { id: 'T-0015', title: null, at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString() },
    ]);
    const list = workListNode(deps(), snap, [], folds, rerender);
    expect(titles(list)).toEqual(['Running', 'Inbox', 'Done this week']);
    expect(list.querySelector('.work-done-row')).toBeNull();
    folds.setFolded('done', false);
    const open = workListNode(deps(), snap, [], folds, rerender);
    const rows = [...open.querySelectorAll<HTMLElement>('.work-done-row')];
    expect(rows.map((r) => r.dataset['id'])).toEqual(['T-0014', 'T-0015']);
    expect(rows[0]!.querySelector('.work-row-id')?.textContent).toBe('T-0014');
    expect(rows[0]!.querySelector('.work-done-title')?.textContent).toBe('Fix the palette race');
    expect(rows[1]!.querySelector('.work-done-title')?.textContent).toBe('');
    expect(rows[1]!.querySelector('.work-row-id')?.textContent).toBe('T-0015');
  });

  it('a Done row opens its ticket on click and Enter (E13-21)', () => {
    const folds = createGroupFoldStore(null);
    folds.setFolded('done', false);
    const d = { ...deps(), openArchived: vi.fn() };
    const snap = board({}, [{ id: 'T-0014', title: 'Fix the palette race', at: new Date().toISOString() }]);
    const list = workListNode(d, snap, [], folds, () => undefined);
    const row = list.querySelector<HTMLElement>('.work-done-row')!;
    expect(row.getAttribute('role')).toBe('button');
    row.click();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(d.openArchived.mock.calls).toEqual([['T-0014'], ['T-0014']]);
  });

  it('"Show older" lists the archive beyond this week, searchable, rows open like the others (E13-21)', async () => {
    const folds = createGroupFoldStore(null);
    folds.setFolded('done', false);
    const all = [
      { id: 'T-0014', title: 'Recent', at: new Date().toISOString() },
      { id: 'T-0003', title: 'Fix the login', at: '2026-01-01T00:00:00Z' },
      { id: 'T-0002', title: 'Billing export', at: '2025-12-01T00:00:00Z' },
    ];
    const d = { ...deps(), openArchived: vi.fn(), listArchived: vi.fn(async () => all) };
    const snap = board({}, [all[0]!]);
    let list = workListNode(d, snap, [], folds, () => undefined);
    const more = [...list.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show older')!;
    expect(more).toBeDefined();
    let repaint: () => void = () => undefined;
    const rerender = (): void => repaint();
    list = workListNode(d, snap, [], folds, rerender);
    const wired = [...list.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show older')!;
    const done = new Promise<void>((resolve) => {
      let calls = 0;
      repaint = () => {
        calls += 1;
        if (calls === 2) {
          resolve();
        }
      };
    });
    wired.click();
    await done;
    expect(d.listArchived).toHaveBeenCalledTimes(1);
    const open = workListNode(d, snap, [], folds, () => undefined);
    const ids = (): string[] =>
      [...open.querySelectorAll<HTMLElement>('.work-done-older-rows .work-done-row')].filter((r) => !r.hidden).map((r) => r.dataset['id']!);
    expect(ids()).toEqual(['T-0003', 'T-0002']);
    const search = open.querySelector<HTMLInputElement>('.work-done-search')!;
    search.value = 'LOGIN';
    search.dispatchEvent(new Event('input'));
    expect(ids()).toEqual(['T-0003']);
    open.querySelector<HTMLElement>('.work-done-older-rows .work-done-row:not([hidden])')!.click();
    expect(d.openArchived).toHaveBeenCalledWith('T-0003');
    search.value = 'nothing';
    search.dispatchEvent(new Event('input'));
    expect(ids()).toEqual([]);
    expect(open.querySelector<HTMLElement>('.work-done-older-rows .work-empty')!.hidden).toBe(false);
  });

  it('says how to start when the board is empty', () => {
    const list = workListNode(deps(), board({}), [], createGroupFoldStore(null), () => undefined);
    expect(list.querySelector('.work-empty')?.textContent).toBe('No tickets yet — capture one with +');
  });

  it('leads every row with its ticket id before the title (req-85)', () => {
    const run = {
      id: 'r1',
      ticketId: 'T-0002',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-30T10:00:00Z',
      endedAt: null,
      gateFailure: null,
    } as unknown as RunInfo;
    const folds = createGroupFoldStore(memoryStorage());
    folds.setFolded('done', false);
    const snap = board(
      {
        inbox: [card('T-0001', 'inbox'), card('T-0005', 'inbox', { interactive: true })],
        build: [card('T-0002', 'build')],
        done: [card('T-0003', 'done')],
      },
      [{ id: 'T-0016', title: 'Ledger sync', at: new Date().toISOString() }],
    );
    const list = workListNode(deps(), snap, [run], folds, () => undefined);
    const rows = [...list.querySelectorAll<HTMLElement>('.work-row, .work-done-row')];
    expect(rows.length).toBe(5); // one shaped, one needing, one running, one idea, one done
    for (const row of rows) {
      const id = row.querySelector<HTMLElement>('.work-row-id')!;
      const title = row.querySelector<HTMLElement>('.work-row-title, .work-done-title')!;
      expect(id.textContent).toBe(row.dataset['id']);
      expect(id.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('workListLivePaint — text in place, the bones untouched (T-0086)', () => {
  const liveRun = (patch: Partial<RunInfo> = {}): RunInfo =>
    ({
      id: 'a',
      ticketId: 'T-0021',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-31T11:59:30Z',
      endedAt: null,
      gateFailure: null,
      activity: 'reading a.ts',
      ...patch,
    }) as unknown as RunInfo;

  it('changes a run\'s line and an age in place — same elements, new text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-31T12:00:00Z'));
    try {
      const snap = board({ build: [card('T-0021', 'build')] });
      const list = workListNode(deps(), snap, [liveRun()], createGroupFoldStore(null), () => undefined);
      const row = list.querySelector<HTMLElement>('[data-id="T-0021"]')!;
      const line = row.querySelector<HTMLElement>('.work-run-line')!;
      const age = row.querySelector<HTMLElement>('.work-row-age')!;
      expect(age.textContent).toBe('now');
      vi.setSystemTime(Date.parse('2026-10-31T12:02:00Z'));
      workListLivePaint(list, deps(), snap, [liveRun({ activity: 'editing b.ts' })]);
      expect(list.querySelector('[data-id="T-0021"]')).toBe(row);
      expect(row.querySelector('.work-run-line')).toBe(line);
      expect(line.textContent).toBe('editing b.ts');
      expect(age.textContent).toBe('2 min');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a row whose card is gone from the snapshot — stale bones wait for the re-render', () => {
    const snap = board({ build: [card('T-0022', 'build')] });
    const list = workListNode(deps(), snap, [liveRun({ id: 'b', ticketId: 'T-0022' })], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('[data-id="T-0022"]')!;
    const line = row.querySelector<HTMLElement>('.work-run-line')!;
    workListLivePaint(list, deps(), board({}), [liveRun({ id: 'b', ticketId: 'T-0022', activity: 'gone dark' })]);
    expect(list.querySelector('[data-id="T-0022"]')).toBe(row);
    expect(line.textContent).toBe('reading a.ts');
  });
});
