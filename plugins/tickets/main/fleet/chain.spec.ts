import { describe, expect, it } from 'vitest';
import { phaseWithoutPoolKeys, type BoardColumn, type PipelinePhase, type TicketCard } from '../../shared/tickets';
import {
  checkpointPhaseIds,
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
      worker: null,
      priority: 'normal',
      rank: 5000,
      branch: `t/${id}`,
      claimedBy: null,
      claimedAt: null,
      run: null,
      references: [],
      parkedReason: null,
      parkedAt: null,
      entered: {},
    },
    pinned: false,
    worker: 'opencode',
    issues: [],
    ...over,
  };
}

const PLAN = phase('plan', { handover: 'agent plan-default', worker: 'opencode', workers: 2 });
const PLAN_REVIEW = phase('plan-review');
const BUILD = phase('build', { handover: 'agent build-default', workers: 4, claim: true });

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
    liveByColumn: {},
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

  it('serves the pool column own queue first, bounded by the worker count', () => {
    const own = [card('T-0010'), card('T-0011'), card('T-0012')].map((c) => ({ ...c, phase: 'plan', path: `tickets/plan/${c.id}.md` }));
    const plan = planDispatch(input({ columns: input().columns.map((c) => (c.phase.id === 'plan' ? column(PLAN, own) : c)) }));
    // plan has workers: 2 — T-0010 and T-0011 go, nothing is pulled from prioritized
    expect(plan.map((p) => `${p.workingPhase}:${p.card.id}`)).toEqual(['plan:T-0010', 'plan:T-0011']);
  });

  it('tops up from the previous manual column when own queue is short', () => {
    const plan = planDispatch(input());
    // plan's own queue has T-0002 (1 of 2 slots); the pull takes prioritized's top
    expect(plan.map((p) => `${p.workingPhase}:${p.card.id}`)).toEqual(['plan:T-0002', 'plan:T-0001']);
    expect(plan[1]!.fromPhase).toBe('prioritized');
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
    expect(plan.map((p) => p.workingPhase)).toEqual(['plan', 'build']);
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
    expect(playing.map((p) => `${p.workingPhase}:${p.card.id}`)).toEqual(['plan:T-0023', 'plan:T-0001']);
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
