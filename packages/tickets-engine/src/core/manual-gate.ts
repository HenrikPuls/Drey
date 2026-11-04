/**
 * Manual gates (E10-6): the pure rules that decide where a ticket parks for
 * the owner. Two shapes park a ticket:
 *
 * - **A manual step after the working gate** — the ticket's merged chain
 *   (pipeline + `chain:` delta) holds an inserted `manual` step right after
 *   the gate that just ran (`insert manual(you, notify) after review`).
 *   The run finishes, the gate is green, but the ticket does not move on:
 *   it parks where it is with `awaiting: you`.
 * - **A gate the human persona works** — the persona that resolves for the
 *   ticket's current gate (the delta's pin, the ticket's pin, the phase's
 *   `persona:`, the engine default) is a `kind: human` persona. No agent
 *   is dispatched for it; the dispatch pass parks the ticket the same way.
 *
 * Accept / Send back are the board's ordinary moves (they clear the park).
 * No IO here — the orchestrator and the specs feed it the merged inputs.
 */
import type { ChainEntry } from '../contracts/chain';
import { isManualPhase, mergeChain } from './chain-delta';

interface PhaseRef {
  readonly id: string;
  readonly title: string;
}

/**
 * The persona the delta pins on the gate the ticket sits in (an `assign`
 * on a standard gate, or an insert's persona on a revisited phase); null
 * when the delta pins none.
 */
export function chainPersonaAt(phases: readonly PhaseRef[], phaseId: string, entries: readonly ChainEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  const step = mergeChain(phases, phaseId, entries).find((s) => s.state === 'current');
  return step?.persona ?? null;
}

/**
 * The manual step that follows `workingPhaseId` in the merged chain, or
 * null. `persona` is the step's pin (null = the owner, "You").
 */
export function manualStepAfter(
  phases: readonly PhaseRef[],
  workingPhaseId: string,
  entries: readonly ChainEntry[],
): { readonly phase: string; readonly persona: string | null } | null {
  if (entries.length === 0) {
    return null;
  }
  const steps = mergeChain(phases, workingPhaseId, entries);
  const at = steps.findIndex((s) => s.state === 'current');
  const next = at < 0 ? undefined : steps[at + 1];
  if (next === undefined || next.skipped || !isManualPhase(next.phase) || !next.inserted) {
    return null;
  }
  return { phase: next.phase, persona: next.persona };
}

/** The `awaiting:` value and the Log / status wording of a park. */
export function parkLine(who: string, where: string): string {
  return `parked for ${who} — manual step after ${where}`;
}
