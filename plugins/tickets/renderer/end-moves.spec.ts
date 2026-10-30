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
  it('offers plan on the first automatic column, refine at the checkpoints and the last agent column', () => {
    expect(interactiveModeFor('plan', COLUMNS)).toBe('plan');
    expect(interactiveModeFor('plan-review', COLUMNS)).toBe('refine');
    expect(interactiveModeFor('review', COLUMNS)).toBe('refine');
    expect(interactiveModeFor('commit', COLUMNS)).toBe('refine');
  });

  it('offers nothing on the queues, the middle agent column and the terminal phase', () => {
    expect(interactiveModeFor('inbox', COLUMNS)).toBeNull();
    expect(interactiveModeFor('prioritized', COLUMNS)).toBeNull();
    expect(interactiveModeFor('build', COLUMNS)).toBeNull();
    expect(interactiveModeFor('done', COLUMNS)).toBeNull();
    expect(interactiveModeFor('nowhere', COLUMNS)).toBeNull();
  });

  it('degrades to nothing on a board without an agent column', () => {
    const manual = COLUMNS.map((c) => column(phase(c.phase.id, { handover: 'manual' })));
    expect(interactiveModeFor('plan-review', manual)).toBeNull();
  });
});

describe('interactiveEndMoves', () => {
  it('a plan dialog finishes into the checkpoint or approves straight past it', () => {
    const moves = interactiveEndMoves('plan', 'plan', COLUMNS);
    expect(moves.map((m) => m.toPhase)).toEqual(['plan-review', 'build']);
    expect(moves[0]!.label).toBe('Finish → plan-review');
    expect(moves[1]!.label).toBe('Approve → build');
  });

  it('a refine dialog goes on to the next column or back to the nearest agent column', () => {
    const moves = interactiveEndMoves('refine', 'review', COLUMNS);
    expect(moves.map((m) => m.toPhase)).toEqual(['commit', 'build']);
    expect(moves[0]!.label).toBe('On to commit');
    expect(moves[1]!.label).toBe('Back to build');
  });

  it('omits the sides that do not exist', () => {
    // commit refines: on to done, back to build (review is manual, plan behind it)
    expect(interactiveEndMoves('refine', 'commit', COLUMNS).map((m) => m.toPhase)).toEqual(['done', 'build']);
    // a last-column dialog has no "on to"
    const short = [...COLUMNS.slice(0, -1)];
    expect(interactiveEndMoves('refine', 'commit', short).map((m) => m.toPhase)).toEqual(['build']);
    expect(interactiveEndMoves('plan', 'nowhere', COLUMNS)).toEqual([]);
  });
});
