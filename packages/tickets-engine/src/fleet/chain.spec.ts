import { describe, expect, it } from 'vitest';
import {
  phaseWithoutPoolKeys,
  priorityClass,
  type BoardColumn,
  type PipelinePhase,
  type PriorityConfig,
  type TicketCard,
} from '../contracts/tickets';
import {
  checkpointPhaseIds,
  dispatchable,
  columnPromptRef,
  columnWorkerPin,
  isAutoPhase,
  nextPhaseIdOf,
  planDispatch,
  type PlanDispatchInput,
} from './chain';

/**
 * The chain's pure rules (M85, ADR-0077): which columns run themselves,
 * where the owner's checkpoints sit, and what the orchestrator
 * dispatches next.
 */

function phase(id: string, over: Partial<PipelinePhase> = {}): PipelinePhase {
  return phaseWithoutPoolKeys({
    id,
    title: id,
    wip: null,
    claim: false,
    handover: 'manual',
    ...over,
  });
}

function column(phase: PipelinePhase, tickets: readonly TicketCard[] = []): BoardColumn {
  return { phase, unknown: false, tickets };
}

function card(id: string, over: Partial<TicketCard> = {}): TicketCard {
  return {
    id,
    path: `tickets/plan/${id}.md`,
    phase: 'plan',
    meta: {
      id,
      title: `Ticket ${id}`,
      repo: 'drey',
      repos: ['drey'],
      worker: null,
      persona: null,
      track: null,
      priority: 'normal',
      rank: 5000,
      branch: `t/${id}`,
      claimedBy: null,
      claimedAt: null,
      run: null,
      references: [],
      blockedBy: [],
      parkedReason: null,
      parkedAt: null,
      interactive: false,
      entered: {},
    },
    worker: 'opencode',
    blocked: [],
    blocks: [],
    issues: [],
    ...over,
  };
}

const PLAN = phase('plan', { handover: 'agent plan-default', worker: 'opencode' });
const PLAN_REVIEW = phase('plan-review');
const BUILD = phase('build', { handover: 'agent build-default', claim: true });

function input(over: Partial<PlanDispatchInput> = {}): PlanDispatchInput {
  return {
    master: 'run',
    columns: [
      column(phase('inbox')),
      column(phase('prioritized'), [card('T-0001', { phase: 'prioritized', path: 'tickets/prioritized/T-0001.md' })]),
      column(PLAN, [card('T-0002', { phase: 'plan', path: 'tickets/plan/T-0002.md' })]),
      column(PLAN_REVIEW, [card('T-0003', { phase: 'plan-review', path: 'tickets/plan-review/T-0003.md' })]),
      column(BUILD),
      column(phase('done')),
    ],
    modes: {},
    poolSize: { opencode: 2, 'claude-code': 1 },
    liveByPool: { opencode: 0, 'claude-code': 0 },
    poolOf: () => 'opencode',
    busyTickets: new Set(),
    ...over,
  };
}

describe('column config', () => {
  it('an automatic column is one whose handover is agent', () => {
    expect(isAutoPhase(PLAN)).toBe(true);
    expect(isAutoPhase(PLAN_REVIEW)).toBe(false);
  });

  it('the column worker pin prefers the worker: key over the handover @pin', () => {
    expect(columnWorkerPin(PLAN)).toBe('opencode');
    expect(
      columnWorkerPin(phase('review', { handover: 'agent review-default@claude-code', worker: 'opencode' })),
    ).toBe('opencode');
    expect(columnWorkerPin(phase('review', { handover: 'agent review-default@claude-code' }))).toBe('claude-code');
    expect(columnWorkerPin(phase('review'))).toBeNull();
  });

  it('the prompt ref prefers the prompt: key over the handover ref', () => {
    expect(columnPromptRef(PLAN)).toBe('plan-default');
    expect(columnPromptRef(phase('plan', { prompt: 'plan-heavy', handover: 'agent plan-default' }))).toBe('plan-heavy');
  });
});

describe('checkpoints', () => {
  it('a manual column between automatic ones is the owner checkpoint', () => {
    const checkpoints = checkpointPhaseIds(input().columns);
    expect(checkpoints.has('plan-review')).toBe(true); // between plan and build
    expect(checkpoints.has('prioritized')).toBe(false); // inbox is manual too
  });

  describe('the one state list (req-99a)', () => {
    const columns = (): BoardColumn[] => [
      column(phase('inbox'), [card('T-0001', { phase: 'inbox' })]),
      column(phase('shaping'), [card('T-0002', { phase: 'shaping' })]),
      column(phase('prioritized'), [card('T-0003', { phase: 'prioritized' })]),
      column(phase('building', { handover: 'agent build-default', claim: true }), [card('T-0004', { phase: 'building' })]),
      column(phase('ready'), [card('T-0005', { phase: 'ready' })]),
      column(phase('done')),
    ];

    it('Ready to try is the owner checkpoint (the terminal column follows it); Inbox, Shaping and Prioritized are plain queues', () => {
      expect([...checkpointPhaseIds(columns())]).toEqual(['ready', 'done']);
    });

    it('the machine works Building only: it never pulls from a manual column', () => {
      const plan = planDispatch(input({ columns: columns() }));
      expect(plan.map((p) => [p.card.id, p.workingPhase])).toEqual([['T-0004', 'building']]);
    });
  });

  describe('the pipeline of E12-9c', () => {
    const columns = (): BoardColumn[] => [
      column(phase('inbox'), [card('T-0001', { phase: 'inbox' })]),
      column(phase('plan', { handover: 'agent plan-default', claim: true }), [card('T-0002', { phase: 'plan' })]),
      column(phase('build', { handover: 'agent build-default', claim: true }), [card('T-0003', { phase: 'build' })]),
      column(phase('review'), [card('T-0004', { phase: 'review' })]),
      column(phase('sign-off'), [card('T-0005', { phase: 'sign-off' })]),
      column(phase('done')),
    ];

    it('Review and Sign Off are both the owner checkpoints (the terminal column is one as before); Inbox is a plain queue', () => {
      expect([...checkpointPhaseIds(columns())]).toEqual(['review', 'sign-off', 'done']);
    });

    it('a manual column after a checkpoint is one too, but a manual run before the first agent column is not', () => {
      const cols = [column(phase('inbox')), column(phase('triage')), column(phase('plan', { handover: 'agent plan-default' })), column(phase('done'))];
      expect([...checkpointPhaseIds(cols)]).toEqual(['done']); // triage is a queue; only the terminal column follows a worker
    });

    it('the old default pipeline keeps its checkpoints (only the terminal column: commit is an agent column)', () => {
      const old = [
        column(phase('inbox')),
        column(phase('prioritized')),
        column(phase('build', { handover: 'agent build-default', claim: true })),
        column(phase('commit', { handover: 'agent commit-default' })),
        column(phase('done')),
      ];
      expect([...checkpointPhaseIds(old)]).toEqual(['done']);
    });

    it('the machine works Plan and Build only: it never pulls from Inbox, Review or Sign Off', () => {
      const plan = planDispatch(input({ columns: columns() }));
      expect(plan.map((p) => [p.card.id, p.workingPhase]).sort()).toEqual([
        ['T-0002', 'plan'],
        ['T-0003', 'build'],
      ]);
    });
  });
});

describe('nextPhaseIdOf', () => {
  it('walks the pipeline and stops at the end', () => {
    const columns = input().columns;
    expect(nextPhaseIdOf(columns, 'plan')).toBe('plan-review');
    expect(nextPhaseIdOf(columns, 'done')).toBeNull();
    expect(nextPhaseIdOf(columns, 'nope')).toBeNull();
  });
});

describe('planDispatch', () => {
  it('does nothing while the master is halted', () => {
    expect(planDispatch(input({ master: 'halted' }))).toEqual([]);
  });

  it('serves the column own queue, bounded by the provider pool', () => {
    const own = [card('T-0010'), card('T-0011'), card('T-0012')].map((c) => ({ ...c, phase: 'plan', path: `tickets/plan/${c.id}.md` }));
    const plan = planDispatch(input({ columns: input().columns.map((c) => (c.phase.id === 'plan' ? column(PLAN, own) : c)) }));
    // the opencode pool has 2 slots — T-0010 and T-0011 go, nothing is pulled from prioritized
    expect(plan.map((p) => `${p.workingPhase}:${p.card.id}`)).toEqual(['plan:T-0010', 'plan:T-0011']);
  });

  it('never tops up from the previous manual column — the owner feeds the pool', () => {
    const plan = planDispatch(input());
    // plan's own queue has T-0002 (1 of 2 slots); prioritized stays the
    // owner's queue — the machine never touches it.
    expect(plan.map((p) => `${p.workingPhase}:${p.card.id}`)).toEqual(['plan:T-0002']);
  });

  it('never pulls across an owner checkpoint', () => {
    const plan = planDispatch(input({ columns: input().columns.map((c) => (c.phase.id === 'build' ? column(BUILD, []) : c)) }));
    // build's own queue is empty, but plan-review is the checkpoint — nothing may be pulled
    expect(plan.filter((p) => p.workingPhase === 'build')).toEqual([]);
  });

  it('never pulls across an automatic column', () => {
    // review with a worker would sit behind build (automatic) — the
    // pull skips it: build feeds review by its completions.
    const review = phase('review', { handover: 'agent review-default' });
    const columns = [
      column(PLAN, [card('T-0002')]),
      column(PLAN_REVIEW),
      column(BUILD, [card('T-0004', { phase: 'build', path: 'tickets/build/T-0004.md' })]),
      column(review),
      column(phase('done')),
    ];
    const plan = planDispatch(input({ columns }));
    expect(plan.map((p) => p.workingPhase)).toEqual(['build', 'plan']); // rightmost first (req-63)
  });

  it('skips held columns and busy, claimed and blemished tickets', () => {
    const columns = input().columns.map((c) =>
      c.phase.id === 'plan'
        ? column(PLAN, [
            card('T-0020', { meta: { ...card('T-0020').meta, claimedBy: 'owner@box' } }),
            card('T-0021', { meta: { ...card('T-0021').meta, run: { pid: 1, 'started-at': 'x', stream: 'R-1' } } }),
            card('T-0022', { issues: [{ level: 'error', message: 'broken' }] }),
            card('T-0023'),
          ])
        : c,
    );
    const plan = planDispatch(input({ columns, modes: { plan: 'held' } }));
    expect(plan).toEqual([]);
    const playing = planDispatch(input({ columns }));
    expect(playing.map((p) => `${p.workingPhase}:${p.card.id}`)).toEqual(['plan:T-0023']);
  });

  it('never dispatches a ticket the owner reserved for an interactive dialog (req-65)', () => {
    const columns = input().columns.map((c) =>
      c.phase.id === 'plan'
        ? column(PLAN, [
            card('T-0040', { meta: { ...card('T-0040').meta, interactive: true } }),
            card('T-0041'),
          ])
        : c,
    );
    const plan = planDispatch(input({ columns }));
    expect(plan.map((p) => p.card.id)).toEqual(['T-0041']);
  });

  it('skips an automatic terminal column — a green gate would have nowhere to move', () => {
    const done = phase('done', { handover: 'agent done-default' });
    const columns = [...input().columns.slice(0, -1), column(done, [card('T-0030', { phase: 'done', path: 'tickets/done/T-0030.md' })])];
    expect(planDispatch(input({ columns })).map((p) => p.workingPhase)).not.toContain('done');
  });

  it('a column in cooldown dispatches nothing until it is over', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    const cooling = input({
      cooldownUntil: { plan: '2026-10-18T12:01:00Z' },
      nowMs: now,
    });
    expect(planDispatch(cooling)).toEqual([]);
    const cooled = input({
      cooldownUntil: { plan: '2026-10-18T11:59:00Z' },
      nowMs: now,
    });
    expect(planDispatch(cooled).map((p) => p.workingPhase)).toContain('plan');
  });
});

describe('planDispatch — provider pools and column priority (req-63)', () => {
  const inPlan = (id: string, priority: TicketCard['meta']['priority'] = 'normal'): TicketCard =>
    card(id, { phase: 'plan', path: `tickets/plan/${id}.md`, meta: { ...card(id).meta, priority } });
  const inBuild = (id: string, priority: TicketCard['meta']['priority'] = 'normal'): TicketCard =>
    card(id, { phase: 'build', path: `tickets/build/${id}.md`, meta: { ...card(id).meta, priority } });
  const board = (plan: readonly TicketCard[], build: readonly TicketCard[]): BoardColumn[] => [
    column(PLAN, plan),
    column(phase('review'), []),
    column(BUILD, build),
    column(phase('done')),
  ];
  // build sits right of a manual column here, but it is fed by the owner's
  // moves — what matters is that both automatic columns compete for slots.
  const one = { opencode: 1, 'claude-code': 1 } as const;
  const ids = (input: PlanDispatchInput): string[] => planDispatch(input).map((p) => p.card.id);

  it('an idle slot serves the rightmost column first at equal priority', () => {
    expect(ids(input({ columns: board([inPlan('T-0101')], [inBuild('T-0102')]), poolSize: one }))).toEqual(['T-0102']);
  });

  it('a high ticket in an earlier column beats a normal one further right', () => {
    const columns = board([inPlan('T-0111', 'high')], [inBuild('T-0112')]);
    expect(ids(input({ columns, poolSize: one }))).toEqual(['T-0111']);
  });

  it('inside the high class the column rank decides, not urgent over high', () => {
    const columns = board([inPlan('T-0121', 'urgent')], [inBuild('T-0122', 'high')]);
    expect(ids(input({ columns, poolSize: one }))).toEqual(['T-0122']);
  });

  it('low and normal share a class — the column rank decides', () => {
    const columns = board([inPlan('T-0131', 'normal')], [inBuild('T-0132', 'low')]);
    expect(ids(input({ columns, poolSize: one }))).toEqual(['T-0132']);
  });

  it('the rest of a column keeps its own order behind the more important ones', () => {
    const columns = board([inPlan('T-0141'), inPlan('T-0142', 'high')], [inBuild('T-0143'), inBuild('T-0144')]);
    expect(ids(input({ columns, poolSize: { opencode: 4, 'claude-code': 1 } }))).toEqual([
      'T-0142',
      'T-0143',
      'T-0144',
      'T-0141',
    ]);
  });

  it('live runs take pool slots — the owner\'s on-demand runs included', () => {
    const columns = board([inPlan('T-0151')], [inBuild('T-0152')]);
    expect(ids(input({ columns, liveByPool: { opencode: 2, 'claude-code': 0 } }))).toEqual([]);
    expect(ids(input({ columns, liveByPool: { opencode: 1, 'claude-code': 0 } }))).toEqual(['T-0152']);
  });

  it('two providers fill their pools independently', () => {
    const columns = board([inPlan('T-0161'), inPlan('T-0162')], [inBuild('T-0163'), inBuild('T-0164')]);
    const plan = planDispatch(
      input({
        columns,
        poolSize: one,
        poolOf: (_card, phase) => (phase.id === 'build' ? 'claude-code' : 'opencode'),
      }),
    );
    expect(plan.map((p) => `${p.pool}:${p.card.id}`)).toEqual(['claude-code:T-0163', 'opencode:T-0161']);
  });

  it('an unresolvable assignment is planned without a slot so the dispatch can say why', () => {
    const columns = board([inPlan('T-0171')], [inBuild('T-0172')]);
    const plan = planDispatch(
      input({ columns, poolSize: one, poolOf: (card) => (card.id === 'T-0172' ? null : 'opencode') }),
    );
    expect(plan.map((p) => `${p.pool ?? 'none'}:${p.card.id}`)).toEqual(['none:T-0172', 'opencode:T-0171']);
  });

  it('priorityClass groups urgent with high and normal with low', () => {
    expect([priorityClass('urgent'), priorityClass('high'), priorityClass('normal'), priorityClass('low')]).toEqual([
      0, 0, 1, 1,
    ]);
  });

  it('priorityClass follows the handed vocabulary — the middle is the default class, unknown ids wait', () => {
    const vocab: PriorityConfig = { order: ['p0', 'p1', 'p2'], default: 'p1' };
    expect([priorityClass('p0', vocab), priorityClass('p1', vocab), priorityClass('p2', vocab)]).toEqual([0, 1, 1]);
    expect(priorityClass('p9', vocab)).toBe(1);
  });

  it('the dispatch classes split at the configured vocabulary, not a hard-coded list', () => {
    const columns = board([inPlan('T-0181', 'p0')], [inBuild('T-0182', 'p1')]);
    const vocab: PriorityConfig = { order: ['p0', 'p1', 'p2'], default: 'p1' };
    // The vault's three-word vocabulary: p0 jumps, p1 waits — the earlier
    // column's p0 wins over the rightmost column's p1.
    expect(ids(input({ columns, poolSize: one, priorities: vocab }))).toEqual(['T-0181']);
    // Without the vocabulary both are unknown words — one class, the
    // rightmost column's ticket goes first as always.
    expect(ids(input({ columns, poolSize: one }))).toEqual(['T-0182']);
  });
});

describe('a ticket parked at a manual step (E10-6)', () => {
  it('is never dispatchable, and takes no slot from the plan', () => {
    const parked = card('T-0300', { meta: { ...card('T-0300').meta, awaiting: 'you' } });
    const free = card('T-0301');
    expect(dispatchable(parked, new Set())).toBe(false);
    expect(dispatchable(free, new Set())).toBe(true);
    const columns = [column(phase('inbox')), column(PLAN, [parked, free]), column(phase('done', { handover: 'none' }))];
    const plan = planDispatch({
      master: 'run',
      columns,
      modes: {},
      poolSize: { opencode: 1, 'claude-code': 0 },
      liveByPool: { opencode: 0, 'claude-code': 0 },
      poolOf: () => 'opencode',
      busyTickets: new Set(),
    });
    expect(plan.map((p) => p.card.id)).toEqual(['T-0301']);
  });
});
