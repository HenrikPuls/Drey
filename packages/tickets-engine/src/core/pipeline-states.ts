/**
 * The one state list (req-99a, owner decisions of 2026-11-06, concept §5.1,
 * convergence-gaps O-2, build plan Q1/Q6/Q8): the stage ids the default pipeline
 * and the dricket import write, the mapping from the phases of older boards,
 * and the way back for whatever still reads the old names.
 *
 * The titles here are the pipeline's `title:` values, stored data like the ids.
 * What the clients display is req-99b.
 */

/** The six stages in board order. `ready` is titled "Ready to try". */
export const STATE_IDS = ['inbox', 'shaping', 'prioritized', 'building', 'ready', 'done'] as const;

export const SHAPING_STATE = 'shaping';
export const BUILDING_STATE = 'building';
export const READY_STATE = 'ready';

/** The only stage an agent claims: Plan, Build, review and test are phases of the chain inside it (Q6). */
export const CLAIM_STATE_IDS: readonly string[] = [BUILDING_STATE];

/** The prompt of the commit step that Accept on Ready to try starts (Q8): merge and push on the target repository. */
export const COMMIT_STEP_PROMPT = 'commit-default';

/**
 * What a new board's `_meta/pipeline.md` says besides its phases. Prose for
 * humans; the board reads only the frontmatter.
 */
export const PIPELINE_PROSE = `The pipeline: ordered phases (first = capture target, last = terminal),
configurable per handover (manual | agent <prompt-ref> | ci | none).
Inbox, Shaping and Prioritized are the owner's columns; the fleet takes
nothing from them, the owner moves a ticket into Building. Building is the
one agent column: plan, build, review and test are phases of the chain
inside it. Ready to try is the owner's checkpoint: Accept there is the
sign-off. It starts the commit step on the target repository (merge the
ticket's branch, push); when that is green the ticket lands in Done. See
specs/ticket-schema.md. Edit freely; the board follows on refresh.
`;

/** The `_meta/pipeline.md` "Initialize board" writes. */
export const DEFAULT_PIPELINE_TEXT = `---
phases:
  - { id: inbox, title: Inbox, handover: manual, persona: you }
  - { id: shaping, title: Shaping, handover: manual, persona: you }
  - { id: prioritized, title: Prioritized, handover: manual, persona: you }
  - { id: building, title: Building, wip: 3, claim: true, handover: agent build-default }
  - { id: ready, title: Ready to try, handover: manual, persona: you }
  - { id: done, title: Done, handover: none }
---
${PIPELINE_PROSE}`;

/**
 * Old phase -> stage (O-2), for a phase that is not a stage id itself.
 * `commit` is the live board's column of the same role as Sign Off (E12-9c).
 * `prioritized`, `inbox` and `done` keep their ids and need no entry.
 */
export const LEGACY_PHASE_STATES: Readonly<Record<string, string>> = {
  plan: 'shaping',
  build: BUILDING_STATE,
  review: READY_STATE,
  'sign-off': READY_STATE,
  commit: READY_STATE,
};

/** The columns of the vault a rollback writes back into: the pipeline before the cut-over. */
export const LEGACY_PHASE_IDS: readonly string[] = ['inbox', 'prioritized', 'build', 'commit', 'done'];

/** For each stage, the old phases that hold it, best first. */
const LEGACY_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  inbox: ['inbox'],
  shaping: ['plan', 'prioritized', 'inbox'],
  prioritized: ['prioritized', 'inbox'],
  building: ['build'],
  ready: ['commit', 'sign-off', 'review'],
  done: ['done'],
};

/**
 * The stage a phase id belongs to: the id itself when `stages` lists it, else
 * the mapping, else null. The read bridge of the migration: an old name resolves
 * instead of showing as a stray column.
 */
export function stateOfPhase(phase: string, stages: readonly string[], mapping: Readonly<Record<string, string>> = LEGACY_PHASE_STATES): string | null {
  if (stages.includes(phase)) {
    return phase;
  }
  const mapped = mapping[phase];
  return mapped !== undefined && stages.includes(mapped) ? mapped : null;
}

/**
 * The reverse converter's half: the column of `phases` a stage goes back to.
 * The phase the ticket was migrated from wins while it still means the stage the
 * ticket is in (`sign-off`, moved nowhere since), because it restores the very
 * column; a ticket that moved on takes the stage's best column on that board.
 * Null when the board has no column for the stage.
 */
export function legacyPhaseOfState(stage: string, phases: readonly string[], migratedFrom: string | null = null): string | null {
  if (migratedFrom !== null && phases.includes(migratedFrom) && stateOfPhase(migratedFrom, [...STATE_IDS]) === stage) {
    return migratedFrom;
  }
  if (phases.includes(stage)) {
    return stage;
  }
  return (LEGACY_CANDIDATES[stage] ?? []).find((phase) => phases.includes(phase)) ?? null;
}
