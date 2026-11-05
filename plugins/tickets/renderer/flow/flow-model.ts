/**
 * The Flow tab's pure half (E13-11): what the gate rows say, which gates
 * the draft changed against the saved flow, what the inspector offers.
 * The grammar and every edit stay in the engine (`core/flow-edit.ts`);
 * this file only reads the engine's `FlowReply`, the same shape the phone's
 * editor renders (`libs/mission-ui/src/flow/flow.model.ts` is its twin).
 */
import type { FlowPersona, FlowReply, FlowStepView } from '../../../../packages/tickets-engine/src/contracts/flow';
import { isManualPhase } from '../../../../packages/tickets-engine/src/core/chain-delta';

/** An answer the desk gave for a flow, minus the failure case. */
export type FlowDraft = Extract<FlowReply, { readonly ok: true }>;

/** `Standard flow` or `Standard flow + 2 changes` — the number of delta entries. */
export function changesLabelOf(chain: readonly string[]): string {
  return chain.length === 0 ? 'Standard flow' : `Standard flow + ${chain.length} ${chain.length === 1 ? 'change' : 'changes'}`;
}

/** The tab's eyebrow: `Flow` for a ticket, `Flow · Part 2` for a part. */
export function eyebrowOf(flow: FlowDraft): string {
  return flow.scope.kind === 'part' ? `Flow · Part ${flow.scope.index + 1}` : 'Flow';
}

/** Whether the draft differs from what was last saved. */
export function isDirty(flow: FlowDraft | null, saved: FlowDraft | null): boolean {
  if (flow === null || saved === null) {
    return false;
  }
  return flow.chain.join('\n') !== saved.chain.join('\n');
}

function signatureOf(step: FlowStepView): string {
  return [step.phase, step.inserted ? 'i' : '', step.skipped ? 's' : '', step.moved ? 'm' : '', step.notify ? 'n' : '', step.pinned ? (step.persona ?? '') : ''].join('|');
}

/** The gates the draft changed against the saved flow; they are drawn dashed until "Save flow". */
export function changedIndicesOf(flow: FlowDraft, saved: FlowDraft | null): ReadonlySet<number> {
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

/** Who works a gate, for its row: the persona, the owner's own name for the owner's gates. */
export function whoOf(step: FlowStepView, flow: FlowDraft): string {
  if (step.persona !== null) {
    return flow.personas.find((p) => p.id === step.persona)?.title ?? step.persona;
  }
  return step.owner ? humanNameOf(flow) : 'Automatic';
}

/** The owner's display name: the human persona's title (configurable, default `You`). */
export function humanNameOf(flow: Pick<FlowDraft, 'personas'>): string {
  return flow.personas.find((p) => p.kind === 'human')?.title ?? 'You';
}

/** The short marks on a gate row. */
export function marksOf(step: FlowStepView): readonly string[] {
  const marks: string[] = [];
  if (step.inserted) {
    marks.push('Added');
  }
  if (step.moved) {
    marks.push('Moved');
  }
  if (step.skipped) {
    marks.push('Struck');
  }
  if (step.notify) {
    marks.push('Tell me');
  }
  return marks;
}

/** The gate the selected one runs after; null for the first of the list. */
export function runsAfterOf(flow: FlowDraft, step: FlowStepView): FlowStepView | null {
  const at = flow.steps.findIndex((s) => s.index === step.index);
  return at > 0 ? flow.steps[at - 1]! : null;
}

/** Whether a gate may move one place earlier / later (the engine enforces the same rules). */
export function moveRoomOf(flow: FlowDraft, step: FlowStepView): { readonly earlier: boolean; readonly later: boolean } {
  if (step.locked || step.state === 'current') {
    return { earlier: false, later: false };
  }
  const at = flow.steps.findIndex((s) => s.index === step.index);
  const above = flow.steps[at - 1];
  const below = flow.steps[at + 1];
  return { earlier: above !== undefined && above.state === 'future' && !above.locked, later: below !== undefined };
}

/**
 * The phases a gate can still be added for: those still ahead in this flow,
 * not added already and not struck. The manual step (E10-6) is no pipeline
 * phase: it is always on offer, once per id.
 */
export function addablePhasesOf(flow: FlowDraft): readonly { readonly id: string; readonly title: string }[] {
  const ahead = new Set(flow.steps.filter((s) => !s.inserted && s.state !== 'current').map((s) => s.phase));
  return flow.phases.filter(
    (phase) =>
      (ahead.has(phase.id) || isManualPhase(phase.id)) &&
      !flow.steps.some((s) => (s.inserted && s.phase === phase.id) || (!s.inserted && s.skipped && s.phase === phase.id)),
  );
}

/** The personas a gate can be given: a manual step is worked by a human, so only those. */
export function personasFor(flow: FlowDraft, step: FlowStepView): readonly FlowPersona[] {
  return isManualPhase(step.phase) ? flow.personas.filter((p) => p.kind === 'human') : flow.personas;
}

/** The flow tab's fixed key for a ticket (and optionally one plan part). */
export const FLOW_SCHEME = 'flow://';

export interface FlowTarget {
  readonly ticketId: string;
  /** 0-based part index; null = the ticket's own chain. */
  readonly part: number | null;
}

export const flowKeyOf = (target: FlowTarget): string =>
  `${FLOW_SCHEME}${target.ticketId}${target.part === null ? '' : `/${target.part}`}`;

export const flowTitleOf = (target: FlowTarget): string =>
  target.part === null ? `Flow · ${target.ticketId}` : `Flow · ${target.ticketId} · Part ${target.part + 1}`;

/** The target a flow key names; null for any other key. */
export function flowTargetOfKey(key: string): FlowTarget | null {
  const match = /^flow:\/\/(T-\d{4,})(?:\/(\d{1,3}))?$/.exec(key);
  return match === null ? null : { ticketId: match[1]!, part: match[2] === undefined ? null : Number(match[2]) };
}
