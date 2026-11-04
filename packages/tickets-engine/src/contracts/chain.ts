/**
 * The chain-delta contract (E9, concept §5.7): the shapes the ticket
 * frontmatter's `chain:` entries, the merged per-ticket gate chain and
 * the chat's setChain command exchange. The grammar and the merge live
 * in core/chain-delta.ts; the full specification is
 * specs/ticket-schema.md.
 *
 * The idea: the standard flow is team configuration
 * (`tickets/_meta/pipeline.md`) and applies to every ticket silently.
 * A ticket stores only its DELTA — declarative entries in the
 * frontmatter's `chain:` list, e.g.
 *
 *     chain: [insert security(ralf, notify) after review, skip verify]
 *
 * The engine merges standard + delta into the ticket's concrete chain,
 * from which the gate bar, the notify cards and the chat's before/after
 * confirmation render. No second source of truth, no UI state: the
 * chain is data in the ticket.
 */

/** One declarative delta entry, parsed from the `chain:` list. */
export type ChainEntry =
  | {
      readonly kind: 'insert';
      /** The pipeline phase this ticket's chain gains. */
      readonly phase: string;
      /** The anchor phase the new gate hangs on. */
      readonly anchor: string;
      readonly position: 'after' | 'before';
      /** The persona pinned to the inserted gate; null = the ladder decides. */
      readonly persona: string | null;
      /** The Bescheid rule: a card lands in "Needs you" when this gate completes. */
      readonly notify: boolean;
    }
  | {
      readonly kind: 'skip';
      /** The pipeline phase this ticket bypasses (rendered struck). */
      readonly phase: string;
    }
  | {
      readonly kind: 'notify';
      /** The gate whose completion lands a card in "Needs you". */
      readonly phase: string;
    }
  | {
      readonly kind: 'move';
      /** The standard gate this ticket runs somewhere else (E10-5). */
      readonly phase: string;
      readonly anchor: string;
      readonly position: 'after' | 'before';
    }
  | {
      readonly kind: 'assign';
      /** The standard gate whose persona this ticket pins (E10-5). */
      readonly phase: string;
      readonly persona: string;
    };

/** One step of the merged chain — what the gate bar renders. */
export interface ChainStep {
  readonly phase: string;
  readonly title: string;
  readonly state: 'past' | 'current' | 'future';
  /** A delta-inserted gate (rendered as an addition). */
  readonly inserted: boolean;
  /** A delta-skipped gate (rendered struck; the ticket bypasses it). */
  readonly skipped: boolean;
  /** The Bescheid rule stands on this gate. */
  readonly notify: boolean;
  /** The persona pinned to this gate by the delta; null = none (the pipeline decides). */
  readonly persona: string | null;
  /** A standard gate the delta moved (E10-5). */
  readonly moved: boolean;
}

/** The Bescheid card's freshness window (concept §5.7): a notify card
 *  shows from the gate's completion until the ticket leaves the
 *  following gate or the window runs out, whichever comes first. */
export const NOTIFY_WINDOW_MS = 24 * 60 * 60_000;
