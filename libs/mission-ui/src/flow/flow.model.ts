/**
 * The flow editor's view models and pure helpers (E10-5, concept v2 §5.7,
 * design board "iPad: Flow editor" and its phone twin): the gates of one
 * ticket's or one part's flow, the inspector's facts and the wording of
 * the chip and the draft. The wire is `GET /api/tickets/<id>/flow[/<part>]`,
 * `POST …/flow-edit`, `…/flow-draft` and `…/flow-save`; nothing here
 * imports engine code. Nothing is saved before "Save flow": the app
 * keeps a draft, and every edit is a round trip that returns the next
 * draft.
 */
import { InjectionToken } from '@angular/core';
import type { McFlow, McFlowStep } from '../api/dto';

export type McFlowReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** One edit on the draft, addressed by a step's `index`. */
export type McFlowOp =
  | { readonly op: 'insert'; readonly phase: string; readonly after: number }
  | { readonly op: 'remove'; readonly step: number }
  | { readonly op: 'restore'; readonly step: number }
  | { readonly op: 'move'; readonly step: number; readonly dir: -1 | 1 }
  | { readonly op: 'notify'; readonly step: number; readonly on: boolean }
  | { readonly op: 'persona'; readonly step: number; readonly persona: string | null }
  | { readonly op: 'reset' };

/** Exactly what the flow editor consumes of the app state. */
export interface McFlowState {
  /** The draft as the desk last answered; null while it loads or when closed. */
  flow(): McFlow | null;
  /** The flow as the file holds it (the dashed marks compare against it). */
  saved(): McFlow | null;
  error(): string | null;
  readOnly(): boolean;
  /** One edit on the draft; the refusal comes back as text. */
  edit(op: McFlowOp): Promise<McFlowReply>;
  /** Paul drafts a flow; `ask` is what the owner said, null = from the ticket alone. */
  draft(ask: string | null): Promise<McFlowReply>;
  /** Paul's reason while his draft is the working draft; null otherwise. */
  paulReason(): string | null;
  /** Throws Paul's draft away (back to the draft before it). */
  undoDraft(): void;
  /** "Save flow": writes the draft; the editor closes on success. */
  save(): Promise<McFlowReply>;
  close(): void;
}

export const MC_FLOW_STATE = new InjectionToken<McFlowState>('mc-flow-state');

/** `Standard flow` or `Standard flow + 2 changes` — the number of delta entries. */
export function changesLabelOf(chain: readonly string[]): string {
  return chain.length === 0 ? 'Standard flow' : `Standard flow + ${chain.length} ${chain.length === 1 ? 'change' : 'changes'}`;
}

/** The screen's eyebrow: `Flow` for a ticket, `Flow · Part 2` for a part. */
export function eyebrowOf(flow: McFlow): string {
  return flow.scope.kind === 'part' ? `Flow · Part ${flow.scope.index + 1}` : 'Flow';
}

/** Whether the draft differs from what is saved. */
export function isDirty(flow: McFlow | null, saved: McFlow | null): boolean {
  if (flow === null || saved === null) {
    return false;
  }
  return flow.chain.join('\n') !== saved.chain.join('\n');
}

function signatureOf(step: McFlowStep): string {
  return [step.phase, step.inserted ? 'i' : '', step.skipped ? 's' : '', step.moved ? 'm' : '', step.notify ? 'n' : '', step.pinned ? (step.persona ?? '') : ''].join('|');
}

/**
 * The gates the draft changed against the saved flow (they are drawn
 * dashed: "nothing counts before Save flow"). A gate counts as unchanged
 * when the saved flow holds the same gate with the same marks (a moved
 * gate carries the `moved` mark, so the jump shows on it alone).
 */
export function changedIndicesOf(flow: McFlow, saved: McFlow | null): ReadonlySet<number> {
  const changed = new Set<number>();
  if (saved === null) {
    return changed;
  }
  const before = new Set(saved.steps.map(signatureOf));
  for (const step of flow.steps) {
    if (!before.has(signatureOf(step))) {
      changed.add(step.index);
    }
  }
  return changed;
}

/** What one gate row says besides its title: the persona, `you` for the owner's own gates. */
export function whoOf(step: McFlowStep, flow: McFlow): string {
  if (step.persona !== null) {
    return flow.personas.find((p) => p.id === step.persona)?.title ?? step.persona;
  }
  return step.owner ? 'you' : 'automatic';
}

/** A short marks line for a gate row: `added`, `moved`, `struck`, `tell me`. */
export function marksOf(step: McFlowStep): readonly string[] {
  const marks: string[] = [];
  if (step.inserted) {
    marks.push('added');
  }
  if (step.moved) {
    marks.push('moved');
  }
  if (step.skipped) {
    marks.push('struck');
  }
  if (step.notify) {
    marks.push('tell me');
  }
  return marks;
}

/** The gate the selected one runs after; null for the first gate of the list. */
export function runsAfterOf(flow: McFlow, step: McFlowStep): McFlowStep | null {
  const at = flow.steps.findIndex((s) => s.index === step.index);
  return at > 0 ? flow.steps[at - 1]! : null;
}

/** Whether a gate may move one place earlier / later (the same rules the desk enforces). */
export function moveRoomOf(flow: McFlow, step: McFlowStep): { readonly earlier: boolean; readonly later: boolean } {
  if (step.locked || step.state === 'current') {
    return { earlier: false, later: false };
  }
  const at = flow.steps.findIndex((s) => s.index === step.index);
  const above = flow.steps[at - 1];
  const below = flow.steps[at + 1];
  return { earlier: above !== undefined && above.state === 'future' && !above.locked, later: below !== undefined };
}

/**
 * The phases a gate can still be added for: those still ahead in this flow
 * (a phase that is done or is the current gate is not offered), not added
 * already and not struck.
 */
export function addablePhasesOf(flow: McFlow): readonly { readonly id: string; readonly title: string }[] {
  const ahead = new Set(flow.steps.filter((s) => !s.inserted && s.state !== 'current').map((s) => s.phase));
  return flow.phases.filter(
    (phase) => ahead.has(phase.id) && !flow.steps.some((s) => (s.inserted && s.phase === phase.id) || (!s.inserted && s.skipped && s.phase === phase.id)),
  );
}
