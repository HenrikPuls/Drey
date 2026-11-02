import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../fleet/protocol';
import type { BoardColumn, BoardSnapshot, PipelinePhase, TicketCard } from '../contracts/tickets';
import type { ChainEntry } from '../contracts/chain';
import { NOTIFY_WINDOW_MS } from '../contracts/chain';
import type { ScoutReport } from '../contracts/scout';
import { needsOf, notifyNeedsOf, reportNeedOf } from './needs';

/**
 * req-66: the remote's "Needs you" list — waiting runs, red gates and
 * failed runs whose ticket has not moved on, and checkpoint tickets
 * without a live run, in that order. E8 adds the pure report-card packer
 * the port builds a scout ticket's parsed `## Report` into; E9 adds the
 * Bescheid fold (`notifyNeedsOf`) — the merged chain plus the entered
 * stamps decide which notify rules still wait for the owner.
 */

const card = (id: string, phase: string, entered: string | null = null, form?: 'scout'): TicketCard =>
  ({
    id,
    path: `tickets/${phase}/${id}.md`,
    phase,
    meta: { title: `Ticket ${id}`, entered: entered === null ? {} : { [phase]: entered }, form },
  }) as unknown as TicketCard;

const column = (id: string, tickets: readonly TicketCard[]): BoardColumn => ({
  phase: { id, title: id } as PipelinePhase,
  tickets,
  unknown: false,
});

const board = (columns: readonly BoardColumn[], checkpoints: readonly string[] = []): BoardSnapshot =>
  ({ columns, checkpoints }) as unknown as BoardSnapshot;

const run = (patch: Partial<RunInfo>): RunInfo => ({
  id: 'r1',
  ticketId: 'T-0001',
  provider: 'opencode',
  state: 'running',
  pid: 1,
  startedAt: '2026-10-30T10:00:00Z',
  endedAt: null,
  sessionRef: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: null,
  lastActivity: '2026-10-30T10:00:00Z',
  steerCount: 0,
  lastSteerRung: null,
  worktreePath: 'x',
  branch: 't/T-0001',
  gateFailure: null,
  ...patch,
});

describe('needsOf', () => {
  it('lists a waiting question with its form and a permission request', () => {
    const snap = board([column('build', [card('T-0001', 'build'), card('T-0002', 'build')])]);
    const questions = [{ key: 'q0', question: 'Fold?', options: [{ label: 'Yes' }], multiple: false }];
    const items = needsOf(snap, [
      run({ id: 'p', ticketId: 'T-0002', waiting: { kind: 'permission', text: 'bash: npm test', since: '2026-10-30T10:01:00Z', requestId: 'x' } }),
      run({ id: 'q', waiting: { kind: 'question', text: 'Fold?', since: '2026-10-30T10:05:00Z', questions } }),
    ]);
    expect(items.map((i) => [i.kind, i.ticketId, i.runId])).toEqual([
      ['question', 'T-0001', 'q'],
      ['permission', 'T-0002', 'p'],
    ]);
    expect(items[0]!.questions).toEqual(questions);
    expect(items[0]!.title).toBe('Ticket T-0001');
    expect(items[0]!.phase).toBe('build');
  });

  it('a live run without a wait needs nothing', () => {
    expect(needsOf(board([column('build', [card('T-0001', 'build')])]), [run({})])).toEqual([]);
  });

  it('reports a red gate and a failed run while the ticket stays in the run phase', () => {
    const snap = board([column('build', [card('T-0001', 'build'), card('T-0002', 'build')])]);
    const items = needsOf(snap, [
      run({ id: 'f', ticketId: 'T-0002', state: 'failed', phase: 'build', lastError: 'boom', endedAt: '2026-10-30T11:00:00Z' }),
      run({ id: 'g', state: 'done', phase: 'build', gateResult: 'red', gateFailure: 'typecheck: 2 errors' }),
    ]);
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['red-gate', 'typecheck: 2 errors'],
      ['failed', 'boom'],
    ]);
  });

  it('drops a red gate once the ticket moved on, and judges only the latest run', () => {
    const moved = board([column('review', [card('T-0001', 'review')])]);
    expect(needsOf(moved, [run({ state: 'done', phase: 'build', gateResult: 'red' })])).toEqual([]);

    const snap = board([column('build', [card('T-0001', 'build')])]);
    const retried = needsOf(snap, [
      run({ id: 'old', state: 'done', phase: 'build', gateResult: 'red', startedAt: '2026-10-30T09:00:00Z' }),
      run({ id: 'new', state: 'done', phase: 'build', gateResult: 'green', startedAt: '2026-10-30T10:00:00Z' }),
    ]);
    expect(retried).toEqual([]);
  });

  it('lists checkpoint tickets oldest first, skipping one with a live run and runs of unknown tickets', () => {
    const snap = board(
      [
        column('plan', []),
        column('plan-review', [
          card('T-0003', 'plan-review', '2026-10-30T12:00:00Z'),
          card('T-0004', 'plan-review', '2026-10-30T08:00:00Z'),
          card('T-0005', 'plan-review'),
        ]),
      ],
      ['plan-review'],
    );
    const items = needsOf(snap, [run({ ticketId: 'T-0005' }), run({ ticketId: 'T-9999', state: 'failed' })]);
    expect(items.map((i) => [i.kind, i.ticketId, i.since])).toEqual([
      ['checkpoint', 'T-0004', '2026-10-30T08:00:00Z'],
      ['checkpoint', 'T-0003', '2026-10-30T12:00:00Z'],
    ]);
  });

  it('still lists a scout ticket in a checkpoint column — the port adds the report card on top', () => {
    const snap = board([column('plan-review', [card('T-0004', 'plan-review', '2026-10-30T08:00:00Z', 'scout')])], ['plan-review']);
    expect(needsOf(snap, []).map((i) => [i.kind, i.ticketId])).toEqual([['checkpoint', 'T-0004']]);
  });
});

describe('reportNeedOf', () => {
  const report: ScoutReport = {
    writtenAt: '2026-11-02T14:32:00Z',
    by: 'pia',
    summary: 'The repo carries two index implementations.',
    decisions: [
      { key: 'D1', question: 'Which storage should back the index?', recommendation: 'SQLite', resolved: false },
      { key: 'D2', question: 'Migrate existing data?', recommendation: 'yes, one migration script', resolved: true },
    ],
  };

  it('packs a parsed report as a report need, the report riding along', () => {
    expect(reportNeedOf(card('T-0004', 'plan'), 'plan', report)).toEqual({
      kind: 'report',
      ticketId: 'T-0004',
      title: 'Ticket T-0004',
      phase: 'plan',
      runId: null,
      text: '1 of 2 decisions open — Which storage should back the index?',
      since: '2026-11-02T14:32:00Z',
      report,
    });
  });

  it('maps a report whose written stamp did not parse to a null since', () => {
    const item = reportNeedOf(card('T-0004', 'plan'), 'plan', { ...report, writtenAt: '' });
    expect(item.since).toBeNull();
    expect(item.text).toBe('1 of 2 decisions open — Which storage should back the index?');
  });
});

describe('notifyNeedsOf', () => {
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  const H = 60 * 60_000;

  const pipeline: readonly PipelinePhase[] = [
    { id: 'plan', title: 'Plan' },
    { id: 'design', title: 'Design' },
    { id: 'build', title: 'Build' },
    { id: 'verify', title: 'Verify' },
  ] as unknown as readonly PipelinePhase[];

  /** One column per pipeline phase; the card's own phase names its column. */
  const notifyBoard = (cards: readonly TicketCard[]): BoardSnapshot =>
    ({
      pipeline,
      columns: pipeline.map((phase) => ({
        phase,
        tickets: cards.filter((c) => c.phase === phase.id),
        unknown: false,
      })),
      checkpoints: [],
    }) as unknown as BoardSnapshot;

  const chainCard = (id: string, phase: string, chain: readonly ChainEntry[], entered: Record<string, string>): TicketCard =>
    ({
      id,
      path: `tickets/${phase}/${id}.md`,
      phase,
      meta: { title: `Ticket ${id}`, entered, chain },
    }) as unknown as TicketCard;

  const notifyPlan: ChainEntry = { kind: 'notify', phase: 'plan' };

  it('lands a card while the ticket sits in the gate following the notified one', () => {
    const board = notifyBoard([chainCard('T-0001', 'design', [notifyPlan], { design: '2026-11-02T11:00:00Z' })]);
    expect(notifyNeedsOf(board, NOW)).toEqual([
      {
        kind: 'notify',
        ticketId: 'T-0001',
        title: 'Ticket T-0001',
        phase: 'design',
        runId: null,
        text: 'the Plan gate completed',
        since: '2026-11-02T11:00:00Z',
      },
    ]);
  });

  it('shows nothing before the gate completes and nothing for a ticket without a delta', () => {
    // The ticket still sits in the notified gate — the following gate has
    // no stamp yet.
    const current = notifyBoard([chainCard('T-0001', 'plan', [notifyPlan], { plan: '2026-11-02T11:00:00Z' })]);
    expect(notifyNeedsOf(current, NOW)).toEqual([]);
    // No delta — the standard flow carries no notify rules.
    const standard = notifyBoard([chainCard('T-0001', 'design', [], { design: '2026-11-02T11:00:00Z' })]);
    expect(notifyNeedsOf(standard, NOW)).toEqual([]);
  });

  it('drops the card once the ticket leaves the following gate', () => {
    const board = notifyBoard([chainCard('T-0001', 'build', [notifyPlan], { design: '2026-11-02T11:00:00Z', build: '2026-11-02T11:30:00Z' })]);
    expect(notifyNeedsOf(board, NOW)).toEqual([]);
  });

  it('caps the card at the freshness window', () => {
    const fresh = notifyBoard([chainCard('T-0001', 'design', [notifyPlan], { design: new Date(NOW - 23 * H).toISOString() })]);
    expect(notifyNeedsOf(fresh, NOW)).toHaveLength(1);
    const stale = notifyBoard([chainCard('T-0001', 'design', [notifyPlan], { design: new Date(NOW - 25 * H).toISOString() })]);
    expect(notifyNeedsOf(stale, NOW)).toEqual([]);
    // Exactly at the window's end the news is out.
    const edge = notifyBoard([chainCard('T-0001', 'design', [notifyPlan], { design: new Date(NOW - NOTIFY_WINDOW_MS).toISOString() })]);
    expect(notifyNeedsOf(edge, NOW)).toEqual([]);
  });

  it('a stamp that does not parse still shows the card — the move-on check bounds it', () => {
    const board = notifyBoard([chainCard('T-0001', 'design', [notifyPlan], { design: 'not a stamp' })]);
    expect(notifyNeedsOf(board, NOW)).toEqual([
      expect.objectContaining({ kind: 'notify', since: 'not a stamp' }),
    ]);
  });

  it('fires for an inserted revisit gate carrying the notify option', () => {
    // Skip the upfront design gate, revisit it after build with a Bescheid.
    const delta: ChainEntry[] = [
      { kind: 'skip', phase: 'design' },
      { kind: 'insert', phase: 'design', anchor: 'build', position: 'after', persona: null, notify: true },
    ];
    const waiting = notifyBoard([chainCard('T-0001', 'build', delta, { build: '2026-11-02T11:00:00Z' })]);
    expect(notifyNeedsOf(waiting, NOW)).toEqual([]);
    const done = notifyBoard([chainCard('T-0001', 'verify', delta, { build: '2026-11-02T11:00:00Z', verify: '2026-11-02T11:30:00Z' })]);
    expect(notifyNeedsOf(done, NOW)).toEqual([
      expect.objectContaining({ kind: 'notify', phase: 'verify', text: 'the Design gate completed' }),
    ]);
  });

  it('fires on a skipped gate too — the ticket still passes through it', () => {
    const delta: ChainEntry[] = [
      { kind: 'skip', phase: 'design' },
      { kind: 'notify', phase: 'design' },
    ];
    const board = notifyBoard([chainCard('T-0001', 'build', delta, { design: '2026-11-02T10:00:00Z', build: '2026-11-02T11:00:00Z' })]);
    expect(notifyNeedsOf(board, NOW)).toEqual([
      expect.objectContaining({ kind: 'notify', text: 'the Design gate completed' }),
    ]);
  });

  it('never fires on the chain\'s last gate — its completion lands outside the chain', () => {
    const board = notifyBoard([
      chainCard('T-0001', 'verify', [{ kind: 'notify', phase: 'verify' }], { verify: '2026-11-02T11:00:00Z' }),
    ]);
    expect(notifyNeedsOf(board, NOW)).toEqual([]);
  });
});
