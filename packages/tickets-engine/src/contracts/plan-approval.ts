/**
 * The "Plan to accept" contract (E10-4, concept v2 §5.9): what the
 * desk answers for a ticket whose plan lists parts, and the owner's
 * edits and release on it. Pure shapes — the logic is
 * `core/plan-release.ts`, the service `BoardService`.
 *
 * Nothing here knows about overlap, touched files or routing: decision
 * D5 dropped them.
 */

/**
 * Where a part stands:
 * - `new`: no ticket yet — the plan still holds it, it can move or go;
 * - `queued`: released, its ticket waits (for a free worker or for the
 *   part before it);
 * - `running`: a run is live on its ticket;
 * - `active`: released and past the queue, no run live right now;
 * - `done`: its ticket reached the pipeline's terminal phase.
 * Every state but `new` is **locked**: the part is a ticket now.
 */
export type PartState = 'new' | 'queued' | 'running' | 'active' | 'done';

/** One gate of a part's flow, from the build step on. */
export interface PartFlowStep {
  readonly phase: string;
  readonly title: string;
  /** The persona on the gate (the part's builder on the build gate); null = none. */
  readonly persona: string | null;
  /** A delta-inserted gate. */
  readonly inserted: boolean;
  /** A delta-skipped gate. */
  readonly skipped: boolean;
  readonly notify: boolean;
}

/** One card of the plan to accept. */
export interface PlanPartCard {
  /** 0-based position in the plan's parts list. */
  readonly index: number;
  readonly title: string;
  readonly reason: string | null;
  /** The pinned builder persona; null = the ladder decides (`defaultPersona`). */
  readonly persona: string | null;
  /** The part's own chain delta, canonical strings. */
  readonly chain: readonly string[];
  readonly flow: readonly PartFlowStep[];
  /** The ticket this part became; null while `new`. */
  readonly ticket: string | null;
  readonly state: PartState;
  /** The pipeline phase the part's ticket sits in; null while `new`. */
  readonly phase: string | null;
  /** True once the part is a ticket: no move, delete or persona change. */
  readonly locked: boolean;
  /** `Runs now`, `After part 2`, or `Released as T-0141`. */
  readonly start: string;
}

/** A persona the picker offers. */
export interface PlanPartPersona {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly color: string;
  /** The model the persona is set to (the estimate's third key); '' = none. */
  readonly model: string;
}

export type PlanPartsReply =
  | {
      readonly ok: true;
      readonly ticket: string;
      readonly title: string;
      readonly parts: readonly PlanPartCard[];
      /** The build gate's phase id — the gate the estimate is asked for. */
      readonly gate: string;
      /** The persona that builds a part without a pin; null = none resolves. */
      readonly defaultPersona: string | null;
      readonly personas: readonly PlanPartPersona[];
      /** The tolerant read's findings (unreadable lines etc.). */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/** The owner's edits on the card list. */
export type PlanPartsEdit =
  | { readonly op: 'persona'; readonly index: number; readonly persona: string | null }
  | { readonly op: 'move'; readonly from: number; readonly to: number }
  | { readonly op: 'delete'; readonly index: number };

/** What a release mints: every new part, or only the first one that has no ticket. */
export type PlanReleaseScope = 'all' | 'first';

export type PlanReleaseReply =
  | {
      readonly ok: true;
      /** The ticket ids minted, in part order. */
      readonly tickets: readonly string[];
      readonly warning?: string;
    }
  | { readonly ok: false; readonly error: string };
