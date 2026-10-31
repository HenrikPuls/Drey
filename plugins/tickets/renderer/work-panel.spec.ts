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

/** req-75 W1: the Work list's DOM over the default eight-phase pipeline. */

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

const card = (id: string, at: string): TicketCard =>
  ({
    id,
    path: `tickets/${at}/${id}.md`,
    phase: at,
    worker: 'opencode',
    meta: { title: `Ticket ${id}`, priority: 'normal', parkedReason: null, claimedBy: null, entered: { inbox: '2026-10-30T10:00:00Z' } },
    blocked: [],
    blocks: [],
    issues: [],
  }) as unknown as TicketCard;

const board = (placed: Record<string, readonly TicketCard[]>): BoardSnapshot =>
  ({
    columns: PIPELINE.map((p): BoardColumn => ({ phase: p, unknown: false, tickets: placed[p.id] ?? [] })),
    checkpoints: ['plan-review', 'review', 'done'],
  }) as unknown as BoardSnapshot;

const api = { ui: { icon: () => document.createElement('span') } } as unknown as DreyPluginApi;

const deps = () => ({
  api,
  openTicket: vi.fn(),
  move: vi.fn(),
  accept: vi.fn(),
  setPriority: vi.fn(),
  startDialog: vi.fn(),
  openRunModal: vi.fn(),
  openMenu: vi.fn(),
  answer: vi.fn(),
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
  it('hides Needs you while nothing waits, and shows the ideas and the work in progress', () => {
    const list = workListNode(deps(), board({ inbox: [card('T-0001', 'inbox')], build: [card('T-0002', 'build')] }), [], createGroupFoldStore(null), () => undefined);
    expect(titles(list)).toEqual(['Ideas', 'In progress']);
    expect(list.querySelectorAll('.work-row')).toHaveLength(2);
  });

  it('puts a finished ticket under Needs you with Accept', () => {
    const d = deps();
    const list = workListNode(d, board({ done: [card('T-0003', 'done')] }), [], createGroupFoldStore(null), () => undefined);
    expect(titles(list)[0]).toBe('Needs you');
    const accept = [...list.querySelectorAll<HTMLButtonElement>('.work-action')].find((b) => b.textContent === 'Accept')!;
    accept.click();
    expect(d.accept).toHaveBeenCalledOnce();
    expect(d.openTicket).not.toHaveBeenCalled();
  });

  it('marks a prioritized idea as queued', () => {
    const list = workListNode(deps(), board({ inbox: [card('T-0004', 'inbox')], prioritized: [card('T-0005', 'prioritized')] }), [], createGroupFoldStore(null), () => undefined);
    const queued = [...list.querySelectorAll<HTMLElement>('.work-row')].filter((row) => row.querySelector('.work-row-queued') !== null);
    expect(queued.map((row) => row.dataset['id'])).toEqual(['T-0005']);
  });

  it('opens the ticket on a row click and the menu on the ⋯ button', () => {
    const d = deps();
    const list = workListNode(d, board({ inbox: [card('T-0006', 'inbox')] }), [], createGroupFoldStore(null), () => undefined);
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
    const list = workListNode(deps(), board({ inbox: [card('T-0007', 'inbox')] }), [], folds, rerender);
    list.querySelector<HTMLButtonElement>('.work-group-ideas .work-group-head')!.click();
    expect(rerender).toHaveBeenCalledOnce();
    expect(createGroupFoldStore(storage).isFolded('ideas')).toBe(true);
    const folded = workListNode(deps(), board({ inbox: [card('T-0007', 'inbox')] }), [], folds, rerender);
    expect(folded.querySelector('.work-group-ideas .work-row')).toBeNull();
  });

  it('a question from a live run sits under Needs you with Answer', () => {
    const d = deps();
    const run = {
      id: 'r1',
      ticketId: 'T-0008',
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
    const list = workListNode(d, board({ build: [card('T-0008', 'build')] }), [run], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-group-needs .work-row')!;
    expect(row.querySelector('.work-row-line')?.textContent).toBe('Asks: Which file?');
    row.querySelector<HTMLButtonElement>('.work-action')!.click();
    expect(d.openTicket).toHaveBeenCalledOnce();
  });

  it('a shaped question answers from the row: options, one tap sends (req-75 W2)', () => {
    const d = deps();
    const run = {
      id: 'r2',
      ticketId: 'T-0009',
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
    const list = workListNode(d, board({ build: [card('T-0009', 'build')] }), [run], createGroupFoldStore(null), () => undefined);
    const row = list.querySelector<HTMLElement>('.work-group-needs .work-row')!;
    // The status line is the question itself, not the raw turn text.
    expect(row.querySelector('.work-row-line')?.textContent).toBe('Asks: Which database?');
    const options = [...row.querySelectorAll<HTMLButtonElement>('.work-option')];
    expect(options.map((b) => b.textContent)).toEqual(['SQLiterecommended', 'Postgres']);
    expect(options[0]!.title).toBe('no server');
    expect(options[0]!.className).toContain('work-option-recommended');
    options[1]!.click();
    expect(d.answer).toHaveBeenCalledOnce();
    expect(d.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'T-0009' }), run, '2. Postgres');
    // A tap disables the row's buttons until the send settles.
    expect(options[0]!.disabled).toBe(true);
    expect([...row.querySelectorAll<HTMLButtonElement>('.work-action')].every((b) => b.disabled)).toBe(true);
  });

  it('says how to start when the board is empty', () => {
    const list = workListNode(deps(), board({}), [], createGroupFoldStore(null), () => undefined);
    expect(list.querySelector('.work-empty')?.textContent).toBe('No tickets yet — capture one with +');
  });
});
