// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import type { NeedItem } from '../shared/remote-protocol';
import type { ShapedQuestion } from '../shared/question-shape';
import type { BoardColumn, BoardSnapshot, PipelinePhase, TicketCard } from '../shared/tickets';
import type { Ctx, State } from './context';
import { bodyKey } from './dom';
import { boardView, needsView } from './views';

/** T-0053: the phone client's paint key — what the user would see,
 *  serialized. Data churn no visible part of the page renders (a run's
 *  token tick, the connection flag the header chip carries) must not
 *  change it; a visible change must. */

beforeAll(() => {
  // jsdom has no layout: the board view's chip-scroll frame would throw after the test.
  Element.prototype.scrollIntoView ??= () => undefined;
});

const card = (id: string, title: string): TicketCard =>
  ({ id, meta: { title, run: null, claimedBy: null, entered: { inbox: '2026-10-30T08:00:00Z', build: '2026-10-30T08:00:00Z' } }, blocked: [], issues: [] }) as unknown as TicketCard;

const column = (id: string, tickets: TicketCard[]): BoardColumn =>
  ({ phase: { id, title: id[0]!.toUpperCase() + id.slice(1), handover: 'manual' } as PipelinePhase, tickets, unknown: false });

const boardOf = (cards: TicketCard[]): BoardSnapshot =>
  ({ columns: [column('inbox', cards), column('build', [])], checkpoints: [] }) as unknown as BoardSnapshot;

const run = (patch: Partial<RunInfo> = {}): RunInfo =>
  ({
    id: 'run-1',
    ticketId: 'T-1',
    state: 'running',
    startedAt: '2026-10-30T09:00:00Z',
    tokensIn: 48_213,
    tokensOut: 6_120,
    activity: 'editing dom.ts',
    ...patch,
  }) as RunInfo;

const question: NeedItem = { kind: 'question', ticketId: 'T-1', title: 'Flicker on load', phase: 'inbox', runId: 'run-1', text: 'Fold the folders?', since: '2026-10-30T09:40:00Z' };

const stateOf = (patch: Partial<State> = {}): State => ({
  actor: 'owner@phone',
  deviceName: 'phone',
  readOnly: false,
  board: boardOf([card('T-1', 'Flicker on load')]),
  fleet: { runs: [run({ waiting: { kind: 'question', text: 'Fold the folders?', since: '2026-10-30T09:40:00Z' } })], chain: null },
  needs: [question],
  connected: false,
  ticket: null,
  stream: null,
  ...patch,
});

const ctxOf = (state: State): Ctx => ({
  api: {} as Ctx['api'],
  state,
  go: () => undefined,
  reload: () => undefined,
  act: async () => true,
});

describe('bodyKey', () => {
  it('is stable across rebuilds of the same state', () => {
    const ctx = ctxOf(stateOf());
    expect(bodyKey(needsView(ctx))).toBe(bodyKey(needsView(ctxOf(stateOf()))));
    expect(bodyKey(boardView(ctx, 'inbox'))).toBe(bodyKey(boardView(ctxOf(stateOf()), 'inbox')));
  });

  it('ignores the connection flag — the header chip carries it, not the page', () => {
    const offline = ctxOf(stateOf({ connected: false }));
    const online = ctxOf(stateOf({ connected: true }));
    expect(bodyKey(needsView(offline))).toBe(bodyKey(needsView(online)));
    expect(bodyKey(boardView(offline, 'inbox'))).toBe(bodyKey(boardView(online, 'inbox')));
  });

  it('ignores a live run\'s tick while the run itself is on the page', () => {
    const ticked = stateOf({ fleet: { runs: [run({ tokensIn: 51_004, activity: 'reading app.ts', waiting: { kind: 'question', text: 'Fold the folders?', since: '2026-10-30T09:40:00Z' } })], chain: null } });
    expect(bodyKey(needsView(ctxOf(stateOf())))).toBe(bodyKey(needsView(ctxOf(ticked))));
    expect(bodyKey(boardView(ctxOf(stateOf()), 'inbox'))).toBe(bodyKey(boardView(ctxOf(ticked), 'inbox')));
  });

  it('moves when a card title changes', () => {
    const retitled = stateOf({ board: boardOf([card('T-1', 'Flicker on every wake')]), needs: [{ ...question, title: 'Flicker on every wake' }] });
    expect(bodyKey(boardView(ctxOf(stateOf()), 'inbox'))).not.toBe(bodyKey(boardView(ctxOf(retitled), 'inbox')));
  });

  it('moves when the needs list changes', () => {
    expect(bodyKey(needsView(ctxOf(stateOf())))).not.toBe(bodyKey(needsView(ctxOf(stateOf({ needs: [] })))));
  });

  it('a shaped need answers with one tap on an option (req-75 W2)', () => {
    const shaped: ShapedQuestion = {
      question: 'Which database?',
      context: 'the store',
      where: null,
      why: null,
      options: [
        { n: 1, label: 'SQLite', consequence: 'no server' },
        { n: 2, label: 'Postgres', consequence: 'one server' },
      ],
      recommended: 1,
      recommendationWhy: 'local first',
    };
    const posted: Array<[string, unknown]> = [];
    const ctx: Ctx = {
      ...ctxOf(stateOf({ needs: [{ ...question, text: 'Which database?\nOptions:\n1. …\n2. …', shaped }] })),
      api: {
        post: async (url: string, body: unknown) => {
          posted.push([url, body]);
          return { ok: true };
        },
      } as unknown as Ctx['api'],
    };
    const view = needsView(ctx);
    const need = view.body.find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('need'))!;
    // The raw turn text is gone; the shape and its options render instead.
    expect(need.querySelector('.need-text')).toBeNull();
    expect(need.querySelector('.q-shaped .q-text')?.textContent).toBe('Which database?');
    expect(need.querySelector('.q-rec')?.textContent).toBe('Recommendation: 1 — local first');
    const options = [...need.querySelectorAll<HTMLButtonElement>('button.option')];
    expect(options).toHaveLength(2);
    // The dot row (T-0084): a leading dot per option, the rest unchanged.
    expect(options[0]!.querySelector('.option-dot')).not.toBeNull();
    expect(options[0]!.querySelector('.option-dot')?.nextSibling?.textContent).toBe('SQLite');
    expect(options[0]!.className).toContain('option-rec');
    options[1]!.click();
    expect(posted).toEqual([['/api/runs/run-1/send', { text: '2. Postgres' }]]);
    expect(options.every((b) => b.disabled)).toBe(true);
  });
});
