import { describe, expect, it } from 'vitest';
import { stepCardOf, type StepCardInput } from './step-card';

const PIPELINE = [
  { id: 'inbox', title: 'Inbox' },
  { id: 'plan', title: 'Plan' },
  { id: 'plan-review', title: 'Plan review' },
  { id: 'build', title: 'Build' },
  { id: 'review', title: 'Review' },
  { id: 'commit', title: 'Commit' },
  { id: 'done', title: 'Done' },
];

const base: StepCardInput = {
  pipeline: PIPELINE,
  phaseId: 'review',
  atCheckpoint: true,
  planGate: false,
  hasReport: true,
  launchable: true,
};

describe('stepCardOf', () => {
  it('a human gate behind an automatic column is a gate card with the next column in its move', () => {
    expect(stepCardOf(base)).toEqual({
      kind: 'gate',
      acceptLabel: 'Move to Commit',
      canLaunch: true,
      canSendBack: true,
    });
  });

  it('offers Launch only when a worktree and a command exist', () => {
    expect(stepCardOf({ ...base, launchable: false }).canLaunch).toBe(false);
  });

  it('the terminal column is a final card with Archive alone — even when the worktree is gone', () => {
    expect(stepCardOf({ ...base, phaseId: 'done', atCheckpoint: false, launchable: false })).toEqual({
      kind: 'final',
      acceptLabel: 'Archive',
      canLaunch: false,
      canSendBack: false,
    });
  });

  it('a Done ticket without any report shows no card', () => {
    expect(stepCardOf({ ...base, phaseId: 'done', atCheckpoint: false, hasReport: false }).kind).toBe('none');
  });

  it('a ticket an agent works (no checkpoint) shows no card, report or not', () => {
    expect(stepCardOf({ ...base, phaseId: 'commit', atCheckpoint: false }).kind).toBe('none');
  });

  it('the plan gate keeps its own approval UI', () => {
    expect(stepCardOf({ ...base, phaseId: 'plan-review', planGate: true }).kind).toBe('none');
  });

  it('an unknown phase shows no card', () => {
    expect(stepCardOf({ ...base, phaseId: 'ghost' }).kind).toBe('none');
  });
});
