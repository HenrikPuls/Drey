import { describe, expect, it } from 'vitest';
import { phaseWithoutPoolKeys, type BoardColumn, type PipelinePhase } from '../shared/tickets';
import { interactiveEndMoves, interactiveModeFor } from './end-moves';

/**
 * The interactive dialog's column rules and end moves (req-65): where
 * "Plan with agent" / "Refine with agent" are offered, and which owner
 * moves end a dialog there.
 */

function phase(id: string, over: Partial<PipelinePhase> = {}): PipelinePhase {
  return phaseWithoutPoolKeys({ id, title: id, wip: null, claim: false, handover: 'manual', ...over });
}

function column(phase: PipelinePhase): BoardColumn {
  return { phase, unknown: false, tickets: [] };
}

const COLUMNS: readonly BoardColumn[] = [
  column(phase('inbox')),
  column(phase('prioritized')),
  column(phase('plan', { handover: 'agent plan-default' })),
  column(phase('plan-review')),
  column(phase('build', { handover: 'agent build-default' })),
  column(phase('review')),
  column(phase('commit', { handover: 'agent commit-default' })),
  column(phase('done')),
];

describe('interactiveModeFor', () => {
  it('offers plan on the first automatic column, refine in every manual column (req-72)', () => {
    expect(interactiveModeFor('plan', COLUMNS)).toBe('plan');
    expect(interactiveModeFor('plan-review', COLUMNS)).toBe('refine');
    expect(interactiveModeFor('review', COLUMNS)).toBe('refine');
  });

  it('offers refine on the queues before the first automatic column, too', () => {
    expect(interactiveModeFor('inbox', COLUMNS)).toBe('refine');
    expect(interactiveModeFor('prioritized', COLUMNS)).toBe('refine');
  });

  it('offers nothing on the automatic columns and the terminal phase', () => {
    expect(interactiveModeFor('build', COLUMNS)).toBeNull();
    expect(interactiveModeFor('commit', COLUMNS)).toBeNull(); // automatic: the runner works it
    expect(interactiveModeFor('done', COLUMNS)).toBeNull();
    expect(interactiveModeFor('nowhere', COLUMNS)).toBeNull();
  });

  it('a ci column is automatic like an agent column — no dialog there', () => {
    const ci = COLUMNS.map((c) =>
      c.phase.id === 'build' ? column(phase('build', { handover: 'ci' })) : c,
    );
    expect(interactiveModeFor('build', ci)).toBeNull();
  });

  it('refines everywhere on a board without an automatic column', () => {
    const manual = COLUMNS.map((c) => column(phase(c.phase.id, { handover: 'manual' })));
    expect(interactiveModeFor('inbox', manual)).toBe('refine');
    expect(interactiveModeFor('plan-review', manual)).toBe('refine');
    expect(interactiveModeFor('done', manual)).toBeNull(); // still the terminal column
  });
});

describe('interactiveEndMoves', () => {
  it('a plan dialog finishes into the checkpoint or approves straight past it', () => {
    const moves = interactiveEndMoves('plan', 'plan', COLUMNS);
    expect(moves.map((m) => m.toPhase)).toEqual(['plan-review', 'build']);
    expect(moves[0]!.label).toBe('Finish → plan-review');
    expect(moves[1]!.label).toBe('Approve → build');
  });

  it('a refine dialog goes on to the next column or back to the nearest automatic column', () => {
    const moves = interactiveEndMoves('refine', 'review', COLUMNS);
    expect(moves.map((m) => m.toPhase)).toEqual(['commit', 'build']);
    expect(moves[0]!.label).toBe('On to commit');
    expect(moves[1]!.label).toBe('Back to build');
  });

  it('omits the sides that do not exist', () => {
    // plan-review refines: on to build, back to plan (it is automatic)
    expect(interactiveEndMoves('refine', 'plan-review', COLUMNS).map((m) => m.toPhase)).toEqual(['build', 'plan']);
    // inbox refines before any automatic column: only "on to"
    expect(interactiveEndMoves('refine', 'inbox', COLUMNS).map((m) => m.toPhase)).toEqual(['prioritized']);
    expect(interactiveEndMoves('plan', 'nowhere', COLUMNS)).toEqual([]);
  });
});
