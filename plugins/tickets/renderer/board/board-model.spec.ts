import { describe, expect, it } from 'vitest';
import type { PlanPartCard } from '../../../../packages/tickets-engine/src/contracts/plan-approval';
import type { RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import { phaseWithoutPoolKeys, type BoardColumn, type BoardSnapshot, type PipelinePhase, type TicketCard } from '../../shared/tickets';
import { boardModelOf, columnCostText, planCandidatesOf } from './board-model';

const phase = (id: string, persona: string | null = null): PipelinePhase => ({
  ...phaseWithoutPoolKeys({ id, title: id[0]!.toUpperCase() + id.slice(1), wip: null, claim: false, handover: 'manual' }),
  persona,
});

const PIPELINE = [phase('inbox'), phase('prioritized'), phase('build', 'ben'), phase('review', 'ralf'), phase('done')];

const card = (
  id: string,
  at: string,
  opts: { persona?: string; parent?: string; cost?: number; blocked?: string[] } = {},
): TicketCard =>
  ({
    id,
    path: `tickets/${at}/${id}.md`,
    phase: at,
    meta: { title: `Ticket ${id}`, persona: opts.persona ?? null, parent: opts.parent ?? null, entered: {} },
    usage: opts.cost === undefined ? undefined : { tokensIn: 1, tokensOut: 1, cost: opts.cost, runs: 1 },
    blocked: opts.blocked ?? [],
    blocks: [],
    issues: [],
  }) as unknown as TicketCard;

const board = (placed: Record<string, readonly TicketCard[]>): BoardSnapshot =>
  ({
    columns: PIPELINE.map((p): BoardColumn => ({ phase: p, unknown: false, tickets: placed[p.id] ?? [] })),
    checkpoints: ['review'],
    recentDone: [{ id: 'T-0001', title: 'Done thing', at: '2026-11-03T10:00:00Z' }],
  }) as unknown as BoardSnapshot;

const run = (patch: Partial<RunInfo>): RunInfo =>
  ({ id: 'r1', ticketId: 'T-0010', persona: 'ben', provider: 'opencode', state: 'running', ...patch }) as unknown as RunInfo;

describe('the board model', () => {
  it('has one column per configured phase, the first marked', () => {
    const model = boardModelOf(board({}), []);
    expect(model.columns.map((c) => c.id)).toEqual(['inbox', 'prioritized', 'build', 'review', 'done']);
    expect(model.columns[0]!.first).toBe(true);
    expect(model.columns[1]!.first).toBe(false);
    expect(model.done).toEqual([{ id: 'T-0001', title: 'Done thing' }]);
  });

  it('sums the known costs per column and says nothing for none', () => {
    const model = boardModelOf(board({ build: [card('T-0010', 'build', { cost: 1.2 }), card('T-0011', 'build', { cost: 2.05 }), card('T-0012', 'build')], inbox: [card('T-0020', 'inbox')] }), []);
    const build = model.columns.find((c) => c.id === 'build')!;
    expect(build.cost).toBeCloseTo(3.25);
    expect(columnCostText(build)).toBe('$3.25');
    expect(build.cards[2]!.cost).toBeNull();
    expect(columnCostText(model.columns[0]!)).toBe('');
  });

  it('resolves the persona: live run, then the ticket pin, then the column', () => {
    const model = boardModelOf(board({ build: [card('T-0010', 'build'), card('T-0011', 'build', { persona: 'tessa' }), card('T-0012', 'build')], inbox: [card('T-0020', 'inbox')] }), [
      run({ ticketId: 'T-0012', persona: 'paul' }),
    ]);
    const build = model.columns.find((c) => c.id === 'build')!;
    expect(build.cards.map((c) => c.personaId)).toEqual(['ben', 'tessa', 'paul']);
    expect(model.columns[0]!.cards[0]!.personaId).toBeNull();
  });

  it('marks running and waiting cards and shows blockers', () => {
    const waiting = run({ ticketId: 'T-0011', waiting: { kind: 'question' } } as unknown as Partial<RunInfo>);
    const model = boardModelOf(
      board({ build: [card('T-0010', 'build'), card('T-0011', 'build'), card('T-0012', 'build', { blocked: ['T-0010'] })] }),
      [run({ activity: 'Editing outline.ts' }), waiting],
    );
    const [a, b, c] = model.columns.find((col) => col.id === 'build')!.cards;
    expect(a).toMatchObject({ kind: 'Running', running: true, line: 'Editing outline.ts' });
    expect(b).toMatchObject({ kind: 'Waiting', running: true });
    expect(c).toMatchObject({ kind: '', running: false, line: 'blocked by T-0010' });
  });

  it('hangs a part under its parent, cost included, and not as its own card', () => {
    const model = boardModelOf(
      board({ prioritized: [card('T-0130', 'prioritized')], build: [card('T-0131', 'build', { parent: 'T-0130', cost: 1.5 }), card('T-0132', 'build')] }),
      [],
    );
    const parent = model.columns.find((c) => c.id === 'prioritized')!;
    expect(parent.cards[0]!.parts.map((p) => p.handle)).toEqual(['T-0131']);
    expect(parent.cards[0]!.parts[0]).toMatchObject({ personaId: 'ben', cost: 1.5, state: 'build' });
    expect(parent.cost).toBeCloseTo(1.5);
    expect(model.columns.find((c) => c.id === 'build')!.cards.map((c) => c.id)).toEqual(['T-0132']);
    expect(model.total).toBe(3);
  });

  it('keeps a part whose parent is not on the board as a card of its own', () => {
    const model = boardModelOf(board({ build: [card('T-0131', 'build', { parent: 'T-9999' })] }), []);
    expect(model.columns.find((c) => c.id === 'build')!.cards.map((c) => c.id)).toEqual(['T-0131']);
  });

  it('adds the plan\'s unreleased parts under the planning ticket, marked Plan', () => {
    const plan = new Map<string, readonly PlanPartCard[]>([
      [
        'T-0130',
        [
          { index: 0, title: 'Capture hotkey', persona: 'ben', start: 'Runs now', state: 'new', ticket: null },
          { index: 1, title: 'Dictation', persona: null, start: 'After part 1', state: 'new', ticket: null },
          { index: 2, title: 'Released', persona: null, start: 'Released as T-0141', state: 'queued', ticket: 'T-0141' },
        ] as unknown as PlanPartCard[],
      ],
    ]);
    const model = boardModelOf(board({ review: [card('T-0130', 'review')] }), [], plan);
    const planCard = model.columns.find((c) => c.id === 'review')!.cards[0]!;
    expect(planCard.kind).toBe('Plan');
    expect(planCard.parts.map((p) => [p.handle, p.state, p.ticketId])).toEqual([
      ['P1', 'Runs now', null],
      ['P2', 'After part 1', null],
    ]);
  });

  it('finds plan candidates in the owner-checkpoint columns', () => {
    expect(planCandidatesOf(board({ review: [card('T-0130', 'review')], build: [card('T-0010', 'build')] }))).toEqual(['T-0130']);
  });
});
