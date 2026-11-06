import { describe, expect, it } from 'vitest';
import { phaseWithoutPoolKeys, type BoardColumn, type PipelinePhase } from '../shared/tickets';
import { interactiveEndMoves, interactiveModeFor } from './end-moves';

/**
 * The interactive dialog's column rules and end moves (req-65): where
 * "Plan with agent" are offered, and which owner
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
  it('offers plan on the first automatic column and nothing in the manual ones (E13-9: no refine)', () => {
    expect(interactiveModeFor('plan', COLUMNS)).toBe('plan');
    expect(interactiveModeFor('plan-review', COLUMNS)).toBeNull();
    expect(interactiveModeFor('review', COLUMNS)).toBeNull();
    expect(interactiveModeFor('inbox', COLUMNS)).toBeNull();
    expect(interactiveModeFor('prioritized', COLUMNS)).toBeNull();
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

  it('a board without an automatic column offers no dialog at all', () => {
    const manual = COLUMNS.map((c) => column(phase(c.phase.id, { handover: 'manual' })));
    expect(interactiveModeFor('inbox', manual)).toBeNull();
    expect(interactiveModeFor('plan-review', manual)).toBeNull();
    expect(interactiveModeFor('done', manual)).toBeNull();
  });
});

describe('interactiveEndMoves', () => {
  it('a plan dialog finishes into the checkpoint or approves straight past it', () => {
    const moves = interactiveEndMoves('plan', 'plan', COLUMNS);
    expect(moves.map((m) => m.toPhase)).toEqual(['plan-review', 'build']);
    expect(moves[0]!.label).toBe('Finish → plan-review');
    expect(moves[1]!.label).toBe('Accept → build');
  });

  it('a run left over from the refine dialog offers no end move', () => {
    expect(interactiveEndMoves('refine' as never, 'review', COLUMNS)).toEqual([]);
  });

  it('omits the sides that do not exist', () => {
    // the last column before the terminal one has no second step
    expect(interactiveEndMoves('plan', 'commit', COLUMNS).map((m) => m.toPhase)).toEqual(['done']);
    expect(interactiveEndMoves('plan', 'nowhere', COLUMNS)).toEqual([]);
  });
});
