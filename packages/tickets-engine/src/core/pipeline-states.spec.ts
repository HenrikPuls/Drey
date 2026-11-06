import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { CLAIM_STATE_IDS, DEFAULT_PIPELINE_TEXT, LEGACY_PHASE_IDS, legacyPhaseOfState, stateOfPhase, STATE_IDS } from './pipeline-states';

describe('the one state list', () => {
  it('the default pipeline is exactly the six stages, Building the only agent claim stage', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(DEFAULT_PIPELINE_TEXT)![1]!;
    const phases = (parse(front) as { phases: { id: string; title: string; handover: string; claim?: boolean; persona?: string }[] }).phases;
    expect(phases.map((p) => p.id)).toEqual([...STATE_IDS]);
    expect(phases.map((p) => p.title)).toEqual(['Inbox', 'Shaping', 'Prioritized', 'Building', 'Ready to try', 'Done']);
    expect(phases.filter((p) => p.claim === true).map((p) => p.id)).toEqual([...CLAIM_STATE_IDS]);
    expect(phases.filter((p) => p.handover.startsWith('agent')).map((p) => p.id)).toEqual(['building']);
    expect(phases.filter((p) => p.persona === 'you').map((p) => p.id)).toEqual(['inbox', 'shaping', 'prioritized', 'ready']);
  });
});

describe('stateOfPhase: the mapping of O-2', () => {
  const stages = [...STATE_IDS];

  it.each([
    ['inbox', 'inbox'],
    ['plan', 'shaping'],
    ['prioritized', 'prioritized'],
    ['build', 'building'],
    ['review', 'ready'],
    ['sign-off', 'ready'],
    ['commit', 'ready'],
    ['done', 'done'],
  ])('%s -> %s', (phase, stage) => {
    expect(stateOfPhase(phase, stages)).toBe(stage);
  });

  it('a stage id reads as itself and an unknown phase stays unknown, never a guess', () => {
    expect(stateOfPhase('building', stages)).toBe('building');
    expect(stateOfPhase('plan-review', stages)).toBeNull();
  });

  it('a mapping into a stage the store does not have is no answer', () => {
    expect(stateOfPhase('build', ['inbox', 'done'])).toBeNull();
    expect(stateOfPhase('build', ['build', 'done'])).toBe('build');
  });
});

describe('legacyPhaseOfState: the way back', () => {
  it('every stage has a column on the board before the cut-over', () => {
    expect(STATE_IDS.map((stage) => legacyPhaseOfState(stage, LEGACY_PHASE_IDS))).toEqual(['inbox', 'prioritized', 'prioritized', 'build', 'commit', 'done']);
  });

  it('takes the first column the board has', () => {
    const e129c = ['inbox', 'plan', 'build', 'review', 'sign-off', 'done'];
    expect(legacyPhaseOfState('shaping', e129c)).toBe('plan');
    expect(legacyPhaseOfState('prioritized', e129c)).toBe('inbox');
    expect(legacyPhaseOfState('ready', e129c)).toBe('sign-off');
  });

  it('restores the migrated phase while the ticket still sits in the stage it mapped to', () => {
    const e129c = ['inbox', 'plan', 'build', 'review', 'sign-off', 'done'];
    expect(legacyPhaseOfState('ready', e129c, 'review')).toBe('review');
    expect(legacyPhaseOfState('done', e129c, 'review')).toBe('done');
  });

  it('a stage on the target board stays itself; a stage nothing can hold is null', () => {
    expect(legacyPhaseOfState('build', ['build', 'done'])).toBe('build');
    expect(legacyPhaseOfState('blocked', LEGACY_PHASE_IDS)).toBeNull();
    expect(legacyPhaseOfState('building', ['inbox', 'done'])).toBeNull();
  });
});
