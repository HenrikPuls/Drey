/**
 * Which card a ticket's thread shows at the end of a step, and what it
 * offers — pure, so the rule is specced without a DOM.
 *
 * The card used to follow the `## Changes` section alone, so it stayed
 * on a Done ticket whose branch was long merged. It now follows the
 * ticket's place in the pipeline:
 *
 * - `gate`: the ticket waits at a manual column behind an automatic one
 *   (a human gate). The card reports what the step did and offers the
 *   gate's moves — launch the build when one can run, move on, send back.
 * - `final`: the ticket sits in the terminal column. The step is over
 *   and merged; the card is the closing report and offers only Archive.
 * - `none`: an agent works the ticket, or there is nothing to report.
 */
import { READY_STATE } from './pipeline-states';

export type StepCardKind = 'gate' | 'final' | 'none';

export interface StepCardInput {
  /** The pipeline in order, with each column's title. */
  readonly pipeline: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** The column the ticket sits in. */
  readonly phaseId: string;
  /** The ticket is at a checkpoint of the owner (a manual column behind an automatic one, no live run). */
  readonly atCheckpoint: boolean;
  /** The checkpoint is the plan gate — the plan has its own approval UI, not this card. */
  readonly planGate: boolean;
  /** The ticket file carries a `## Changes` or `## Result` section. */
  readonly hasReport: boolean;
  /** A worktree exists and a launch command resolves. */
  readonly launchable: boolean;
}

export interface StepCard {
  readonly kind: StepCardKind;
  /** The primary move's label: `Move to Review`, `Archive`. Empty for `none`. */
  readonly acceptLabel: string;
  /** Offer "Launch this version". */
  readonly canLaunch: boolean;
  /** Offer "Send back…". */
  readonly canSendBack: boolean;
}

const NONE: StepCard = { kind: 'none', acceptLabel: '', canLaunch: false, canSendBack: false };

export function stepCardOf(input: StepCardInput): StepCard {
  const at = input.pipeline.findIndex((p) => p.id === input.phaseId);
  if (at < 0) {
    return NONE;
  }
  if (at === input.pipeline.length - 1) {
    return input.hasReport ? { kind: 'final', acceptLabel: 'Archive', canLaunch: false, canSendBack: false } : NONE;
  }
  if (!input.atCheckpoint || input.planGate) {
    return NONE;
  }
  const next = input.pipeline[at + 1]!;
  return {
    kind: 'gate',
    // Ready to try is the sign-off: Accept starts the commit step (req-99a, Q8).
    acceptLabel: input.phaseId === READY_STATE ? 'Accept' : `Move to ${next.title}`,
    canLaunch: input.launchable,
    canSendBack: at > 0,
  };
}
