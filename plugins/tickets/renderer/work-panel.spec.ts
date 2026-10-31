// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RunInfo } from '../main/fleet/protocol';
import {
  phaseWithoutPoolKeys,
  type BoardColumn,
  type BoardSnapshot,
  type PipelinePhase,
  type TicketCard,
} from '../shared/tickets';
import { createGroupFoldStore, workListNode } from './work-panel';

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
  it('shows Running before Ideas, hides Needs you and Shaping while empty', () => {
    const list = workListNode(deps(), board({ inbox: [card('T-0001', 'inbox')], build: [card('T-0002', 'build')] }), [], createGroupFoldStore(null), () => undefined);
    expect(titles(list)).toEqual(['Running', 'Ideas']);
    expect(list.querySelectorAll('.work-row')).toHaveLength(2);
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

  it('a checkpoint after the plan column reads as a plan to approve', () => {
    const list = workListNode(deps(), board({ 'plan-review': [card('T-0004', 'plan-review')] }), [], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-group-needs .work-row')!;
    expect(row.querySelector('.work-kind')?.textContent).toBe('Plan to approve');
    expect(row.querySelector('.work-row-line')?.textContent).toBe('plan ready');
  });

  it('an interactive ticket shapes: the group shows, with the dialog not started', () => {
    const list = workListNode(deps(), board({ inbox: [card('T-0005', 'inbox', { interactive: true })] }), [], createGroupFoldStore(null), () => undefined);
    expect(titles(list)).toEqual(['Shaping', 'Running', 'Ideas']);
    expect(list.querySelector('.work-group-shaping .work-row-sub')?.textContent).toBe('Dialog not started');
  });

  it('marks a prioritized idea as queued and gives ideas their track chip', () => {
    const placed = {
      // Same priority and stamp: newest id first inside Ideas.
      inbox: [card('T-0006', 'inbox', { track: 'auto' }), card('T-0007', 'inbox', { track: 'shape' })],
      prioritized: [card('T-0008', 'prioritized')],
    };
    const list = workListNode(deps(), board(placed), [], createGroupFoldStore(null), () => undefined);
    const rows = [...list.querySelectorAll<HTMLElement>('.work-group-ideas .work-row')];
    // Same priority and stamp: newest id first — the prioritized one leads.
    expect(rows[0]!.dataset['id']).toBe('T-0008');
    expect(rows[0]!.querySelector('.work-row-queued')?.textContent).toBe('Queued');
    expect(rows[0]!.querySelector('.work-track')?.textContent).toBe('Triage');
    expect(rows[1]!.querySelector('.work-track')?.textContent).toBe('Shape');
    expect(rows[2]!.querySelector('.work-track')?.textContent).toBe('Auto');
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
    expect(titles(list)).toEqual(['Running', 'Ideas', 'Done this week']);
    expect(list.querySelector('.work-done-row')).toBeNull();
    folds.setFolded('done', false);
    const open = workListNode(deps(), snap, [], folds, rerender);
    const rows = [...open.querySelectorAll<HTMLElement>('.work-done-row')];
    expect(rows.map((r) => r.dataset['id'])).toEqual(['T-0014', 'T-0015']);
    expect(rows[0]!.querySelector('.work-done-title')?.textContent).toBe('Fix the palette race');
    expect(rows[1]!.querySelector('.work-done-title')?.textContent).toBe('T-0015');
  });

  it('says how to start when the board is empty', () => {
    const list = workListNode(deps(), board({}), [], createGroupFoldStore(null), () => undefined);
    expect(list.querySelector('.work-empty')?.textContent).toBe('No tickets yet — capture one with +');
  });
});
