import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../fleet/protocol';
import type { BoardColumn, BoardSnapshot, PipelinePhase, TicketCard } from '../contracts/tickets';
import type { ScoutReport } from '../contracts/scout';
import { needsOf, reportNeedOf } from './needs';

/**
 * req-66: the remote's "Needs you" list — waiting runs, red gates and
 * failed runs whose ticket has not moved on, and checkpoint tickets
 * without a live run, in that order. E8 adds the pure report-card packer
 * the port builds a scout ticket's parsed `## Report` into.
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
