import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import {
  phaseWithoutPoolKeys,
  type BoardColumn,
  type BoardSnapshot,
  type PipelinePhase,
  type TicketCard,
  type TicketPriority,
} from '../shared/tickets';
import { checkpointActionOf, ideaPhaseIds, queueTargetOf, statusLineOf, workGroups } from './work-groups';

/**
 * req-75 W1: the Work panel's three groups over the default eight-phase
 * pipeline — inbox/prioritized are ideas, plan and build are the
 * machine's, plan-review/review/done are the owner's checkpoints.
 */

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

const card = (
  id: string,
  at: string,
  opts: { priority?: TicketPriority; created?: string; blocked?: readonly string[] } = {},
): TicketCard =>
  ({
    id,
    path: `tickets/${at}/${id}.md`,
    phase: at,
    meta: {
      title: `Ticket ${id}`,
      priority: opts.priority ?? 'normal',
      parkedReason: null,
      entered: { inbox: opts.created ?? '2026-10-30T10:00:00Z' },
    },
    blocked: opts.blocked ?? [],
    blocks: [],
    issues: [],
  }) as unknown as TicketCard;

const board = (placed: Record<string, readonly TicketCard[]>, extra: readonly BoardColumn[] = []): BoardSnapshot =>
  ({
    columns: [
      ...PIPELINE.map((p): BoardColumn => ({ phase: p, unknown: false, tickets: placed[p.id] ?? [] })),
      ...extra,
    ],
    checkpoints: ['plan-review', 'review', 'done'],
  }) as unknown as BoardSnapshot;

const run = (patch: Partial<RunInfo>): RunInfo =>
  ({
    id: 'r1',
    ticketId: 'T-0001',
    provider: 'opencode',
    state: 'running',
    startedAt: '2026-10-30T10:00:00Z',
    endedAt: null,
    gateFailure: null,
    ...patch,
  }) as RunInfo;

const ids = (rows: readonly { card: TicketCard }[]): string[] => rows.map((r) => r.card.id);

describe('ideaPhaseIds / queueTargetOf', () => {
  it('ideas are the first phase plus the manual phases before the first machine phase', () => {
    expect(ideaPhaseIds(PIPELINE)).toEqual(['inbox', 'prioritized']);
    expect(ideaPhaseIds([phase('inbox', 'manual'), phase('build', 'ci'), phase('done', 'none')])).toEqual(['inbox']);
    expect(ideaPhaseIds([phase('inbox', 'manual'), phase('done', 'none')])).toEqual(['inbox']);
    expect(ideaPhaseIds([])).toEqual([]);
  });

  it('queues into the last idea phase, or the first machine phase when inbox is the only idea phase', () => {
    expect(queueTargetOf(PIPELINE, 'inbox')).toBe('prioritized');
    expect(queueTargetOf(PIPELINE, 'prioritized')).toBeNull();
    const short = [phase('inbox', 'manual'), phase('build', 'agent build-default'), phase('done', 'none')];
    expect(queueTargetOf(short, 'inbox')).toBe('build');
    expect(queueTargetOf([phase('inbox', 'manual'), phase('done', 'none')], 'inbox')).toBeNull();
  });
});

describe('workGroups', () => {
  it('places every ticket in exactly one group', () => {
    const snap = board({
      inbox: [card('T-0001', 'inbox')],
      prioritized: [card('T-0002', 'prioritized')],
      plan: [card('T-0003', 'plan')],
      'plan-review': [card('T-0004', 'plan-review')],
      build: [card('T-0005', 'build')],
      done: [card('T-0006', 'done')],
    });
    const groups = workGroups(snap, []);
    expect(ids(groups.needs)).toEqual(['T-0004', 'T-0006']);
    expect(ids(groups.ideas).sort()).toEqual(['T-0001', 'T-0002']);
    expect(ids(groups.progress)).toEqual(['T-0005', 'T-0003']);
  });

  it('orders ideas by priority, newest first within a priority', () => {
    const snap = board({
      inbox: [
        card('T-0001', 'inbox', { created: '2026-10-01T00:00:00Z' }),
        card('T-0002', 'inbox', { created: '2026-10-03T00:00:00Z' }),
        card('T-0003', 'inbox', { priority: 'low', created: '2026-10-09T00:00:00Z' }),
      ],
      prioritized: [card('T-0004', 'prioritized', { priority: 'urgent', created: '2026-09-01T00:00:00Z' })],
    });
    const groups = workGroups(snap, []);
    expect(ids(groups.ideas)).toEqual(['T-0004', 'T-0002', 'T-0001', 'T-0003']);
    expect(groups.ideas.map((r) => r.queued)).toEqual([true, false, false, false]);
  });

  it('a waiting run puts its ticket into Needs you; a working one stays in progress with its run', () => {
    const snap = board({ build: [card('T-0001', 'build'), card('T-0002', 'build')] });
    const groups = workGroups(snap, [
      run({ id: 'a', ticketId: 'T-0001', waiting: { kind: 'question', text: 'Fold?', since: '2026-10-30T10:05:00Z' } }),
      run({ id: 'b', ticketId: 'T-0002' }),
    ]);
    expect(ids(groups.needs)).toEqual(['T-0001']);
    expect(groups.needs[0]!.need?.kind).toBe('question');
    expect(ids(groups.progress)).toEqual(['T-0002']);
    expect(groups.progress[0]!.run?.id).toBe('b');
  });

  it('a red gate in the phase it ran needs you; one whose ticket moved on does not', () => {
    const snap = board({ build: [card('T-0001', 'build')], review: [card('T-0002', 'review')] });
    const groups = workGroups(snap, [
      run({ id: 'a', ticketId: 'T-0001', state: 'done', phase: 'build', gateResult: 'red', gateFailure: 'npm test failed' }),
      run({ id: 'b', ticketId: 'T-0002', state: 'done', phase: 'build', gateResult: 'red', gateFailure: 'old' }),
    ]);
    expect(groups.needs.map((r) => [r.card.id, r.need?.kind])).toEqual([
      ['T-0001', 'red-gate'],
      ['T-0002', 'checkpoint'],
    ]);
  });

  it('accepts terminal tickets even when the terminal phase is not a checkpoint', () => {
    const snap = { ...board({ done: [card('T-0009', 'done')] }), checkpoints: [] } as BoardSnapshot;
    const groups = workGroups(snap, []);
    expect(ids(groups.needs)).toEqual(['T-0009']);
    expect(checkpointActionOf(snap, 'done')).toEqual({ kind: 'accept', label: 'Accept' });
  });

  it('keeps tickets of an unknown directory in progress, after the configured phases', () => {
    const limbo: BoardColumn = { phase: phase('limbo', 'manual'), unknown: true, tickets: [card('T-0007', 'limbo')] };
    const groups = workGroups(board({ build: [card('T-0001', 'build')] }, [limbo]), []);
    expect(ids(groups.progress)).toEqual(['T-0001', 'T-0007']);
  });
});

describe('checkpointActionOf / statusLineOf', () => {
  it('approves into the next phase', () => {
    expect(checkpointActionOf(board({}), 'plan-review')).toEqual({ kind: 'approve', to: 'build', label: 'Approve → Build' });
  });

  it('says why a row waits, or where it stands', () => {
    const snap = board({
      inbox: [card('T-0001', 'inbox', { blocked: ['T-0009'] })],
      prioritized: [card('T-0002', 'prioritized')],
      'plan-review': [card('T-0003', 'plan-review')],
      done: [card('T-0004', 'done')],
    });
    const groups = workGroups(snap, []);
    const line = (id: string): string =>
      statusLineOf([...groups.needs, ...groups.ideas, ...groups.progress].find((r) => r.card.id === id)!, snap);
    expect(line('T-0001')).toBe('Blocked by T-0009');
    expect(line('T-0002')).toBe('Queued for the fleet');
    expect(line('T-0003')).toBe('Plan-review — waits for your review');
    expect(line('T-0004')).toBe('Done — accept it into the archive');
  });
});
