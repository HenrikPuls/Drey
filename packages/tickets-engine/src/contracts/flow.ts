/**
 * The flow editor's contract (E10-5, concept v2 §5.7): what the desk
 * answers for one flow — a ticket's chain or one plan part's — and the
 * edits, the save and the draft on it. The grammar and the edit logic are
 * `core/chain-delta.ts` and `core/flow-edit.ts`; the service is
 * `BoardService`. Nothing is written before a save: an edit is a pure
 * function from a draft chain to a draft chain (the app keeps the draft).
 */
import type { FlowOp } from '../core/flow-edit';

export type { FlowOp };

/** Which flow: the ticket's own chain, or one part of a split plan (the parent's `### Parts`). */
export type FlowScope =
  | { readonly kind: 'ticket' }
  | { readonly kind: 'part'; readonly index: number; readonly title: string };

/** One gate of the flow, from the ticket's current gate on. */
export interface FlowStepView {
  /** Position in the merged chain — what an edit addresses. */
  readonly index: number;
  readonly phase: string;
  readonly title: string;
  readonly state: 'current' | 'future';
  /** A gate the delta adds. */
  readonly inserted: boolean;
  /** A standard gate the delta strikes. */
  readonly skipped: boolean;
  /** A standard gate the delta runs somewhere else. */
  readonly moved: boolean;
  readonly notify: boolean;
  /** Who works the gate: the delta's pin, else the pipeline's; null = the ladder decides. */
  readonly persona: string | null;
  /** True when the delta pinned the persona (a pinned persona is a change). */
  readonly pinned: boolean;
  /** The persona's model; null when there is none to show. */
  readonly model: string | null;
  /** A gate the owner works by hand (a manual column and no persona). */
  readonly owner: boolean;
  /** The step may not change: it runs now (or the part is a ticket already). */
  readonly locked: boolean;
}

export interface FlowPersona {
  readonly id: string;
  /** `human` = the owner (E10-6): the gate parks the ticket for them. */
  readonly kind: 'agent' | 'human';
  readonly title: string;
  readonly color: string;
  readonly model: string;
}

export interface FlowPhaseOption {
  readonly id: string;
  readonly title: string;
}

export type FlowReply =
  | {
      readonly ok: true;
      readonly ticket: string;
      readonly title: string;
      readonly scope: FlowScope;
      /** The chain shown: the saved delta, an edit's result or Paul's draft; canonical strings. */
      readonly chain: readonly string[];
      /** The delta in the file now. */
      readonly saved: readonly string[];
      readonly steps: readonly FlowStepView[];
      /** Phases a gate can be added for. */
      readonly phases: readonly FlowPhaseOption[];
      readonly personas: readonly FlowPersona[];
      /** Set when nothing may be saved (a live run, a part that is a ticket); the reason. */
      readonly readOnly: string | null;
    }
  | { readonly ok: false; readonly error: string };

/** The edit's answer: the new draft, or why the edit does not hold. */
export type FlowEditReply = FlowReply;

/** Paul's draft: the flow he proposes and why — nothing is written. */
export type FlowDraftReply =
  | (Extract<FlowReply, { ok: true }> & { readonly reason: string })
  | { readonly ok: false; readonly error: string };

export type FlowSaveReply =
  | { readonly ok: true; readonly warning?: string }
  | { readonly ok: false; readonly error: string };

export interface FlowTarget {
  readonly id: string;
  /** 0-based part index; null = the ticket's own chain. */
  readonly part: number | null;
}
