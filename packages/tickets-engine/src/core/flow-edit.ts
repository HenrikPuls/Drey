/**
 * The flow editor's pure half (E10-5, concept v2 §5.7): edits on a ticket's
 * (or a plan part's) merged chain, written back as the smallest chain
 * delta that merges to the same chain.
 *
 * The editor never edits delta strings. It edits the *steps* the delta
 * merges to — insert after a step, remove, restore, move earlier / later,
 * a persona, the notify rule — and `entriesFromSteps` regenerates the
 * canonical delta from the result: standard gates that kept their relative
 * order stay silent, the others get `move`, new gates get `insert`, and the
 * attributes follow as `skip` / `notify` / `assign`. The regeneration is
 * checked by merging it again; an arrangement the grammar cannot write
 * (two gates of one phase make an anchor ambiguous) is refused with a
 * reason, never written wrong.
 *
 * Only the future is editable: a step that is past or current is locked
 * (a running gate stays as it is).
 */
import type { ChainEntry, ChainStep } from '../contracts/chain';
import { isManualPhase, MANUAL_TITLE, mergeChain, renderChainEntries, validateChain } from './chain-delta';

export interface FlowPhase {
  readonly id: string;
  readonly title: string;
}

/** One edit on the draft, addressed by the step's position in the merged chain. */
export type FlowOp =
  | { readonly op: 'view' }
  | { readonly op: 'insert'; readonly phase: string; readonly after: number }
  | { readonly op: 'remove'; readonly step: number }
  | { readonly op: 'restore'; readonly step: number }
  | { readonly op: 'move'; readonly step: number; readonly dir: -1 | 1 }
  | { readonly op: 'notify'; readonly step: number; readonly on: boolean }
  | { readonly op: 'persona'; readonly step: number; readonly persona: string | null }
  | { readonly op: 'reset' };

export type FlowEdit =
  | { readonly ok: true; readonly entries: readonly ChainEntry[]; readonly chain: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** True while the step may still be edited. */
export function isEditable(step: ChainStep): boolean {
  return step.state === 'future';
}

/** Applies one edit to the chain; the result is a new delta, validated against the pipeline. */
export function applyFlowOp(
  phases: readonly FlowPhase[],
  currentPhaseId: string,
  entries: readonly ChainEntry[],
  edit: FlowOp,
): FlowEdit {
  if (edit.op === 'reset') {
    return { ok: true, entries: [], chain: [] };
  }
  const steps = mergeChain(phases, currentPhaseId, entries);
  if (edit.op === 'view') {
    return finish(phases, currentPhaseId, steps);
  }
  if (edit.op === 'insert') {
    const anchor = steps[edit.after];
    if (anchor === undefined) {
      return refuse('no such gate to add after');
    }
    if (anchor.state === 'past') {
      return refuse(`${anchor.title} is done — a gate can only be added after the current or a later gate`);
    }
    const known = phases.find((phase) => phase.id === edit.phase) ?? (isManualPhase(edit.phase) ? { id: edit.phase, title: MANUAL_TITLE } : undefined);
    if (known === undefined) {
      return refuse(`the pipeline has no phase "${edit.phase}"`);
    }
    if (steps.some((step) => step.inserted && step.phase === edit.phase)) {
      return refuse(`${known.title} is in this flow already — a gate revisits a phase at most once`);
    }
    if (steps.some((step) => !step.inserted && step.skipped && step.phase === edit.phase)) {
      return refuse(`${known.title} is struck from this flow — restore it instead`);
    }
    const next = [...steps];
    next.splice(edit.after + 1, 0, {
      phase: known.id,
      title: known.title,
      state: 'future',
      inserted: true,
      skipped: false,
      notify: false,
      persona: null,
      moved: false,
    });
    return finish(phases, currentPhaseId, next);
  }
  const at = steps[edit.step];
  if (at === undefined) {
    return refuse('no such gate');
  }
  if (!isEditable(at)) {
    return refuse(`${at.title} is ${at.state === 'current' ? 'the current gate' : 'done'} — only gates that have not begun can change`);
  }
  const next = [...steps];
  switch (edit.op) {
    case 'remove':
      if (at.inserted) {
        next.splice(edit.step, 1);
      } else if (at.skipped) {
        return refuse(`${at.title} is struck already`);
      } else {
        // A struck gate goes back to its standard place: striking and moving are not combined.
        next.splice(edit.step, 1);
        const rank = phases.findIndex((phase) => phase.id === at.phase);
        const after = next.findIndex((step, i) => i >= 0 && !step.inserted && phases.findIndex((phase) => phase.id === step.phase) > rank);
        next.splice(after < 0 ? next.length : after, 0, { ...at, skipped: true, moved: false });
      }
      return finish(phases, currentPhaseId, next);
    case 'restore':
      if (!at.skipped) {
        return refuse(`${at.title} is not struck`);
      }
      next[edit.step] = { ...at, skipped: false };
      return finish(phases, currentPhaseId, next);
    case 'move': {
      const to = edit.step + edit.dir;
      const neighbour = steps[to];
      if (neighbour === undefined) {
        return refuse(edit.dir < 0 ? `${at.title} is the first gate` : `${at.title} is the last gate`);
      }
      if (!isEditable(neighbour)) {
        return refuse(`${at.title} cannot move ahead of ${neighbour.title} — it has begun`);
      }
      next[edit.step] = neighbour;
      next[to] = at;
      return finish(phases, currentPhaseId, next);
    }
    case 'notify':
      next[edit.step] = { ...at, notify: edit.on };
      return finish(phases, currentPhaseId, next);
    case 'persona':
      next[edit.step] = { ...at, persona: edit.persona };
      return finish(phases, currentPhaseId, next);
  }
}

function refuse(error: string): FlowEdit {
  return { ok: false, error };
}

function finish(phases: readonly FlowPhase[], currentPhaseId: string, steps: readonly ChainStep[]): FlowEdit {
  const entries = entriesFromSteps(phases, steps);
  const refusal = validateChain(phases, currentPhaseId, entries);
  if (refusal !== null) {
    return refuse(refusal);
  }
  // The proof of the regeneration: the delta merges back to the same arrangement.
  const back = mergeChain(phases, currentPhaseId, entries);
  const same =
    back.length === steps.length &&
    back.every((step, i) => {
      const want = steps[i]!;
      return (
        step.phase === want.phase &&
        step.inserted === want.inserted &&
        step.skipped === want.skipped &&
        step.notify === want.notify &&
        step.persona === want.persona
      );
    });
  if (!same) {
    return refuse('that arrangement cannot be written as a change to the standard flow');
  }
  return { ok: true, entries, chain: renderChainEntries(entries) };
}

/** The longest increasing subsequence of `values`; the returned set holds the kept positions. */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = []; // position of the smallest tail per length
  const prev: number[] = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < values[i]!) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let at = tails.length > 0 ? tails[tails.length - 1]! : -1; at >= 0; at = prev[at]!) {
    keep.add(at);
  }
  return keep;
}

/**
 * The canonical delta for a target arrangement: structure first (moves and
 * inserts in chain order, each anchored on the step before it), then the
 * attributes (skip, notify, assign) in chain order.
 */
export function entriesFromSteps(phases: readonly FlowPhase[], steps: readonly ChainStep[]): ChainEntry[] {
  const standardIndex = new Map(phases.map((phase, i) => [phase.id, i] as const));
  const standardAt: number[] = [];
  const standardPos: number[] = []; // position in `steps` per standard step
  steps.forEach((step, i) => {
    if (!step.inserted) {
      standardAt.push(standardIndex.get(step.phase) ?? Number.MAX_SAFE_INTEGER);
      standardPos.push(i);
    }
  });
  const stableStandard = new Set([...longestIncreasing(standardAt)].map((k) => standardPos[k]!));
  const isStable = (i: number): boolean => !steps[i]!.inserted && stableStandard.has(i);
  const entries: ChainEntry[] = [];
  steps.forEach((step, i) => {
    if (isStable(i)) {
      return;
    }
    // Anchor: the step before this one; for the first step, the first stable step after it.
    let anchor: string | null = null;
    let position: 'after' | 'before' = 'after';
    if (i > 0) {
      anchor = steps[i - 1]!.phase;
    } else {
      const later = steps.findIndex((_, k) => k > i && isStable(k));
      if (later >= 0) {
        anchor = steps[later]!.phase;
        position = 'before';
      }
    }
    if (anchor === null) {
      return;
    }
    if (step.inserted) {
      entries.push({ kind: 'insert', phase: step.phase, anchor, position, persona: step.persona, notify: step.notify });
    } else {
      entries.push({ kind: 'move', phase: step.phase, anchor, position });
    }
  });
  for (const step of steps) {
    if (!step.inserted && step.skipped) {
      entries.push({ kind: 'skip', phase: step.phase });
    }
  }
  for (const step of steps) {
    if (!step.inserted && step.notify) {
      entries.push({ kind: 'notify', phase: step.phase });
    }
  }
  for (const step of steps) {
    if (!step.inserted && step.persona !== null) {
      entries.push({ kind: 'assign', phase: step.phase, persona: step.persona });
    }
  }
  return entries;
}
