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
import { TAG_AUTO_PALETTE } from '../../../shared/tag-style';
import {
  checkpointActionOf,
  dependencyRank,
  ideaPhaseIds,
  queueTargetOf,
  rowStatusOf,
  statusLineOf,
  workGroups,
} from './work-groups';

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

  it('In progress shows live runs first, then the closest to done (T-0084)', () => {
    const snap = board({
      plan: [card('T-0001', 'plan')],
      commit: [card('T-0002', 'commit')],
      build: [card('T-0003', 'build')],
    });
    expect(ids(workGroups(snap, []).progress)).toEqual(['T-0002', 'T-0003', 'T-0001']);
    const groups = workGroups(snap, [run({ id: 'r', ticketId: 'T-0001' })]);
    expect(ids(groups.progress)).toEqual(['T-0001', 'T-0002', 'T-0003']);
    expect(statusLineOf(groups.progress[0]!, snap)).toBe('opencode working');
  });

  it('a detached run line names the provider and the detachment', () => {
    const snap = board({ build: [card('T-0001', 'build')] });
    const groups = workGroups(snap, [run({ id: 'r', ticketId: 'T-0001', state: 'detached' })]);
    expect(statusLineOf(groups.progress[0]!, snap)).toBe('opencode detached');
  });

  it('rows carry a phase colour: explicit, palette by position, unknown after the configured (T-0084)', () => {
    const colored = phaseWithoutPoolKeys({
      id: 'build',
      title: 'Build',
      wip: null,
      claim: false,
      handover: 'agent build-default',
      color: '#c96442',
    });
    const base = board({ plan: [card('T-0002', 'plan')], build: [card('T-0001', 'build')] });
    const snap: BoardSnapshot = {
      ...base,
      columns: base.columns.map((c) => (c.phase.id === 'build' ? { ...c, phase: colored } : c)),
    };
    const groups = workGroups(snap, []);
    const colorOf = (id: string): string => [...groups.progress].find((r) => r.card.id === id)!.phaseColor;
    expect(colorOf('T-0001')).toBe('#c96442'); // the explicit key wins
    expect(colorOf('T-0002')).toBe(TAG_AUTO_PALETTE[2]); // plan sits at position 2
    const limbo: BoardColumn = { phase: phase('limbo', 'manual'), unknown: true, tickets: [card('T-0007', 'limbo')] };
    const withUnknown = workGroups(board({ build: [card('T-0001', 'build')] }, [limbo]), []);
    expect(withUnknown.progress.find((r) => r.card.id === 'T-0007')!.phaseColor).toBe(TAG_AUTO_PALETTE[8]);
  });
});

describe('dependencyRank (T-0084)', () => {
  const blockers = (map: Record<string, readonly string[]>) => (id: string): readonly string[] => map[id] ?? [];

  it('a ticket sorts below its in-list blocker; ready ones keep today\'s order', () => {
    const items = ['b', 'a', 'c'];
    const ranked = dependencyRank(items, (x) => x, blockers({ b: ['a'] }));
    expect(ranked).toEqual(['a', 'b', 'c']);
  });

  it('chains and duplicates resolve transitively', () => {
    const ranked = dependencyRank(['c', 'a', 'b'], (x) => x, blockers({ c: ['a', 'a'], b: ['c'] }));
    expect(ranked).toEqual(['a', 'c', 'b']);
  });

  it('a blocker outside the list is ignored — another group\'s ticket or an unknown id', () => {
    const ranked = dependencyRank(['a', 'b'], (x) => x, blockers({ a: ['T-9999'], b: ['a-not-in-list'] }));
    expect(ranked).toEqual(['a', 'b']);
  });

  it('a cycle keeps today\'s order: the earliest remaining row breaks the stall', () => {
    const ranked = dependencyRank(['a', 'b', 'c'], (x) => x, blockers({ a: ['b'], b: ['a'] }));
    expect(ranked).toEqual(['c', 'a', 'b']);
  });

  it('workGroups ranks inside every group but not across groups', () => {
    const snap = board({
      inbox: [
        card('T-0100', 'inbox', { priority: 'urgent', created: '2026-10-28T00:00:00Z', blocked: ['T-0200'] }),
        card('T-0200', 'inbox', { created: '2026-10-29T00:00:00Z' }),
      ],
      'plan-review': [card('T-0300', 'plan-review')],
      build: [card('T-0400', 'build', { blocked: ['T-0300'] })],
      commit: [card('T-0500', 'commit', { blocked: ['T-0400'] })],
    });
    const groups = workGroups(snap, []);
    // Ideas: the urgent one waits on the later idea — the blocker leads.
    expect(ids(groups.ideas)).toEqual(['T-0200', 'T-0100']);
    expect(groups.ideas[1]!.card.blocked).toEqual(['T-0200']);
    // In progress: commit (T-0500) sits closest to done but waits on
    // T-0400 — the blocker leads. T-0400's own blocker sits in Needs
    // you, another group: no reorder across groups.
    expect(ids(groups.progress)).toEqual(['T-0400', 'T-0500']);
  });
});

describe('rowStatusOf (T-0084)', () => {
  const statusOf = (groups: ReturnType<typeof workGroups>, id: string): string =>
    rowStatusOf([...groups.needs, ...groups.ideas, ...groups.progress].find((r) => r.card.id === id)!);

  it('a need decides first: waiting, failed, review', () => {
    const snap = board({ build: [card('T-0001', 'build'), card('T-0002', 'build'), card('T-0003', 'build')] });
    const groups = workGroups(snap, [
      run({ id: 'q', ticketId: 'T-0001', waiting: { kind: 'permission', text: 'rm -rf', since: '2026-10-30T10:05:00Z' } }),
      run({ id: 'g', ticketId: 'T-0002', state: 'done', phase: 'build', gateResult: 'red', gateFailure: 'tests' }),
    ]);
    expect(statusOf(groups, 'T-0001')).toBe('waiting');
    expect(statusOf(groups, 'T-0002')).toBe('failed');
  });

  it('a checkpoint needs review; blocked beats running beats queued beats parked beats idle', () => {
    const parked = { ...card('T-0006', 'inbox'), meta: { ...card('T-0006', 'inbox').meta, parkedReason: 'later' } } as TicketCard;
    const snap = board({
      'plan-review': [card('T-0001', 'plan-review')],
      build: [card('T-0002', 'build', { blocked: ['T-0001'] }), card('T-0003', 'build')],
      prioritized: [card('T-0004', 'prioritized')],
      inbox: [parked, card('T-0005', 'inbox')],
    });
    const groups = workGroups(snap, [run({ id: 'r', ticketId: 'T-0002' }), run({ id: 'r3', ticketId: 'T-0003' })]);
    expect(statusOf(groups, 'T-0001')).toBe('review');
    expect(statusOf(groups, 'T-0002')).toBe('blocked'); // even with a live run
    expect(statusOf(groups, 'T-0003')).toBe('running');
    expect(statusOf(groups, 'T-0004')).toBe('queued');
    expect(statusOf(groups, 'T-0005')).toBe('idle');
    expect(statusOf(groups, 'T-0006')).toBe('parked');
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
    expect(line('T-0003')).toBe('Waits for your review');
    expect(line('T-0004')).toBe('Done — accept it into the archive');
  });

  it('a plain row has no line — the phase chip owns the phase (T-0084)', () => {
    const snap = board({ inbox: [card('T-0001', 'inbox')] });
    const groups = workGroups(snap, []);
    expect(statusLineOf(groups.ideas[0]!, snap)).toBe('');
  });
});
