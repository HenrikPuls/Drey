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
import type { NeedItem } from '../shared/remote-protocol';
import {
  ageWords,
  checkpointActionOf,
  ideaPhaseIds,
  needKindLabel,
  queueTargetOf,
  runningStepOf,
  statusLineOf,
  workGroups,
  workListSignature,
} from './work-groups';

/**
 * req-75 W1b: the Work panel's four groups over the default eight-phase
 * pipeline — inbox/prioritized are ideas, plan and build are the
 * machine's, plan-review/review/done are the owner's checkpoints. The
 * Done-this-week group is the snapshot's recentDone, not built here.
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
  opts: {
    priority?: TicketPriority;
    created?: string;
    blocked?: readonly string[];
    blocks?: readonly string[];
    interactive?: boolean;
  } = {},
): TicketCard =>
  ({
    id,
    path: `tickets/${at}/${id}.md`,
    phase: at,
    meta: {
      title: `Ticket ${id}`,
      priority: opts.priority ?? 'normal',
      parkedReason: null,
      interactive: opts.interactive ?? false,
      entered: { inbox: opts.created ?? '2026-10-30T10:00:00Z' },
    },
    blocked: opts.blocked ?? [],
    blocks: opts.blocks ?? [],
    issues: [],
  }) as unknown as TicketCard;

const board = (placed: Record<string, readonly TicketCard[]>, extra: readonly BoardColumn[] = []): BoardSnapshot =>
  ({
    columns: [
      ...PIPELINE.map((p): BoardColumn => ({ phase: p, unknown: false, tickets: placed[p.id] ?? [] })),
      ...extra,
    ],
    checkpoints: ['plan-review', 'review', 'done'],
    recentDone: [],
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
    expect(ids(groups.shaping)).toEqual([]);
    expect(ids(groups.running)).toEqual(['T-0005', 'T-0003']);
  });

  it('the interactive reservation and a live dialog run both shape the ticket', () => {
    const snap = board({
      inbox: [card('T-0001', 'inbox', { interactive: true })],
      build: [card('T-0002', 'build'), card('T-0003', 'build')],
    });
    const groups = workGroups(snap, [run({ id: 'a', ticketId: 'T-0002', interactive: 'plan' })]);
    // Closest to done first, like Running.
    expect(ids(groups.shaping)).toEqual(['T-0002', 'T-0001']);
    expect(ids(groups.running)).toEqual(['T-0003']);
    expect(ids(groups.ideas)).toEqual([]);
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

  it('Running: live runs on top, then the queue — dependencies before priority', () => {
    const snap = board({
      plan: [card('T-0010', 'plan', { priority: 'urgent' })],
      build: [
        card('T-0011', 'build', { priority: 'urgent', blocked: ['T-0012'] }),
        card('T-0012', 'build', { priority: 'low', blocks: ['T-0011'] }),
        card('T-0013', 'build', { priority: 'high' }),
        card('T-0014', 'build', { priority: 'low' }),
      ],
    });
    const groups = workGroups(snap, [run({ ticketId: 'T-0014' })]);
    // T-0014 runs; T-0012 blocks the urgent T-0011 and goes before it
    // with its urgency; T-0010 (urgent, plan) before T-0013 (high).
    expect(ids(groups.running)).toEqual(['T-0014', 'T-0012', 'T-0011', 'T-0010', 'T-0013']);
  });

  it('ideas put a blocker before what it blocks, whatever the priority', () => {
    const snap = board({
      inbox: [
        card('T-0020', 'inbox', { priority: 'urgent', blocked: ['T-0021'] }),
        card('T-0021', 'inbox', { priority: 'low', blocks: ['T-0020'] }),
        card('T-0022', 'inbox', { priority: 'high' }),
      ],
    });
    expect(ids(workGroups(snap, []).ideas)).toEqual(['T-0021', 'T-0020', 'T-0022']);
  });

  it('a waiting run puts its ticket into Needs you; a working one stays in Running with its run', () => {
    const snap = board({ build: [card('T-0001', 'build'), card('T-0002', 'build')] });
    const groups = workGroups(snap, [
      run({ id: 'a', ticketId: 'T-0001', waiting: { kind: 'question', text: 'Fold?', since: '2026-10-30T10:05:00Z' } }),
      run({ id: 'b', ticketId: 'T-0002' }),
    ]);
    expect(ids(groups.needs)).toEqual(['T-0001']);
    expect(groups.needs[0]!.need?.kind).toBe('question');
    expect(ids(groups.running)).toEqual(['T-0002']);
    expect(groups.running[0]!.run?.id).toBe('b');
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

  it('keeps tickets of an unknown directory in Running, after the configured phases', () => {
    const limbo: BoardColumn = { phase: phase('limbo', 'manual'), unknown: true, tickets: [card('T-0007', 'limbo')] };
    const groups = workGroups(board({ build: [card('T-0001', 'build')] }, [limbo]), []);
    expect(ids(groups.running)).toEqual(['T-0001', 'T-0007']);
  });
});

describe('workListSignature — what re-renders the Work list (T-0086)', () => {
  it('ignores activity, tokens and clocks — text the live paint refreshes in place', () => {
    const base = workListSignature([run({ ticketId: 'T-0001' })], []);
    const moving = workListSignature(
      [
        run({
          ticketId: 'T-0001',
          activity: 'Reading board.ts',
          tokensIn: 12_000,
          tokensOut: 3_000,
          lastActivity: '2026-10-30T11:00:00Z',
          startedAt: '2026-10-30T09:30:00Z',
          execMs: 4_500,
        }),
      ],
      [],
    );
    expect(moving).toBe(base);
  });

  it('moves on state, column, waiting kind, turn, interactive and held', () => {
    const base = workListSignature([run({ ticketId: 'T-0001' })], []);
    for (const patch of [
      { state: 'stopping' as const },
      { phase: 'review' },
      { waiting: { kind: 'question', text: 'Q', since: '2026-10-30T10:05:00Z' } },
      { turn: 'idle' as const },
      { interactive: 'plan' as const },
      { held: true },
    ]) {
      expect(workListSignature([run({ ticketId: 'T-0001', ...patch })], [])).not.toBe(base);
    }
  });

  it('sorts by run id, so the fleet snapshot\'s order does not matter', () => {
    const a = run({ id: 'a', ticketId: 'T-0001' });
    const b = run({ id: 'b', ticketId: 'T-0002', state: 'stopping' });
    expect(workListSignature([a, b], [])).toBe(workListSignature([b, a], []));
  });

  it('follows the alert keys', () => {
    const base = workListSignature([], ['halted']);
    expect(workListSignature([], ['halted', 'quota:opencode:2026-11-01T00:00:00Z'])).not.toBe(base);
    expect(workListSignature([], [])).not.toBe(base);
  });
});

describe('checkpointActionOf', () => {
  it('approves into the next phase', () => {
    expect(checkpointActionOf(board({}), 'plan-review')).toEqual({ kind: 'approve', to: 'build', label: 'Approve → Build' });
  });
});

describe('needKindLabel', () => {
  const need = (kind: NeedItem['kind'], phase: string): NeedItem =>
    ({ kind, ticketId: 'T-0001', title: 'T', phase, runId: null, text: '', since: null }) as NeedItem;

  it('names the four run-driven kinds', () => {
    const snap = board({});
    expect(needKindLabel(need('question', 'build'), snap)).toBe('Question');
    expect(needKindLabel(need('permission', 'build'), snap)).toBe('Approval');
    expect(needKindLabel(need('red-gate', 'build'), snap)).toBe('Gate red');
    expect(needKindLabel(need('failed', 'build'), snap)).toBe('Run failed');
  });

  it('a checkpoint after the plan column is a plan; the terminal phase is ready; the rest review', () => {
    const snap = board({});
    expect(needKindLabel(need('checkpoint', 'plan-review'), snap)).toBe('Plan to approve');
    expect(needKindLabel(need('checkpoint', 'review'), snap)).toBe('Review');
    expect(needKindLabel(need('checkpoint', 'done'), snap)).toBe('Ready to try');
  });
});

describe('runningStepOf', () => {
  const stepOf = (id: string, snap: BoardSnapshot, runs: readonly RunInfo[] = []): ReturnType<typeof runningStepOf> => {
    const row = workGroups(snap, runs).running.find((r) => r.card.id === id);
    if (row === undefined) {
      throw new Error(`${id} is not in Running`);
    }
    return runningStepOf(row, snap);
  };

  it('names the step by the phase id, with the run’s activity as the line', () => {
    const limbo: BoardColumn = { phase: phase('limbo', 'manual'), unknown: true, tickets: [card('T-0005', 'limbo')] };
    const snap = board(
      {
        plan: [card('T-0001', 'plan')],
        build: [card('T-0002', 'build')],
        commit: [card('T-0003', 'commit')],
      },
      [limbo],
    );
    expect(stepOf('T-0001', snap, [run({ ticketId: 'T-0001', activity: 'Reading daily-note.ts' })])).toEqual({
      step: 'Planning',
      line: 'Reading daily-note.ts',
      live: true,
    });
    expect(stepOf('T-0002', snap, [run({ ticketId: 'T-0002', activity: '  ' })])).toEqual({
      step: 'Building',
      line: '',
      live: true,
    });
    expect(stepOf('T-0003', snap, [run({ ticketId: 'T-0003' })])).toEqual({ step: 'Merging', line: '', live: true });
    // A phase without its own step word keeps its title.
    expect(stepOf('T-0005', snap, [run({ ticketId: 'T-0005' })]).step).toBe('Limbo');
  });

  it('without a run it is queued — behind the first blocker by title, else a free worker', () => {
    const snap = board({
      build: [card('T-0001', 'build', { blocked: ['T-0002'] }), card('T-0003', 'build')],
      review: [card('T-0002', 'review')],
    });
    expect(stepOf('T-0001', snap)).toEqual({ step: 'Queued', line: 'waits for “Ticket T-0002”', live: false });
    expect(stepOf('T-0003', snap)).toEqual({ step: 'Queued', line: 'waits for a free worker', live: false });
    // An unknown blocker falls back to its id.
    const orphan = board({ build: [card('T-0004', 'build', { blocked: ['T-0099'] })] });
    expect(stepOf('T-0004', orphan).line).toBe('waits for “T-0099”');
  });
});

describe('ageWords', () => {
  const NOW = Date.parse('2026-10-31T12:00:00Z');

  it('steps through now, minutes, hours, yesterday and days', () => {
    expect(ageWords(null, NOW)).toBe('');
    expect(ageWords('not a stamp', NOW)).toBe('');
    expect(ageWords('2026-10-31T11:59:30Z', NOW)).toBe('now');
    expect(ageWords('2026-10-31T11:56:00Z', NOW)).toBe('4 min');
    expect(ageWords('2026-10-31T09:00:00Z', NOW)).toBe('3 h');
    expect(ageWords('2026-10-30T09:00:00Z', NOW)).toBe('yesterday');
    expect(ageWords('2026-10-27T00:00:00Z', NOW)).toBe('4 d');
  });
});

describe('statusLineOf (Needs-you lines)', () => {
  it('says why it waits, after the kind chip', () => {
    const snap = board({
      build: [card('T-0001', 'build')],
      'plan-review': [card('T-0003', 'plan-review')],
      review: [card('T-0005', 'review')],
      done: [card('T-0004', 'done')],
    });
    const groups = workGroups(snap, [
      run({ ticketId: 'T-0001', waiting: { kind: 'question', text: 'Which file?', since: '2026-10-30T10:05:00Z' } }),
    ]);
    const line = (id: string): string => {
      const row = groups.needs.find((r) => r.card.id === id);
      if (row === undefined) {
        throw new Error(`${id} is not in Needs you`);
      }
      return statusLineOf(row, snap);
    };
    expect(line('T-0001')).toBe('Which file?');
    expect(line('T-0003')).toBe('plan ready');
    expect(line('T-0005')).toBe('waits for your review');
    expect(line('T-0004')).toBe('checks green');
  });

  it('a shaped question reads as its question (req-75 W2)', () => {
    const snap = board({ build: [card('T-0001', 'build')] });
    const groups = workGroups(snap, [
      run({
        ticketId: 'T-0001',
        waiting: {
          kind: 'question',
          text: 'Which database?\nTicket: the store\nOptions:\n1. SQLite — no server',
          since: '2026-10-30T10:05:00Z',
          shaped: {
            question: 'Which database?',
            context: 'the store',
            where: null,
            why: null,
            options: [{ n: 1, label: 'SQLite', consequence: 'no server' }],
            recommended: null,
            recommendationWhy: null,
          },
        },
      }),
    ]);
    expect(statusLineOf(groups.needs[0]!, snap)).toBe('Which database?');
  });
});
