/**
 * Settings → Tickets, the page the boards show (E13-12, board 7g): the
 * pure half. What the rows say about the team, the standard flow, the
 * budget, the runners and the videos — read from what the engine already
 * answers (`personas`, the board snapshot, `settingsRead`), nothing stored
 * here.
 */
import { parseHandover, type PipelinePhase } from '../../../../packages/tickets-engine/src/contracts/tickets';
import type { PersonaView } from '../../shared/remote-protocol';

export interface FlowStripItem {
  readonly id: string;
  readonly title: string;
  /** The persona's name when the phase names one; null = the ladder decides. */
  readonly who: string | null;
}

/** The standard flow: the phases an agent works, in column order, with their persona. */
export function standardFlowOf(pipeline: readonly PipelinePhase[], personas: readonly PersonaView[]): readonly FlowStripItem[] {
  return pipeline
    .filter((phase) => parseHandover(phase.handover).mode === 'agent')
    .map((phase) => ({
      id: phase.id,
      title: phase.title,
      who: phase.persona === null ? null : (personas.find((p) => p.id === phase.persona)?.title ?? phase.persona),
    }));
}

/**
 * The shipped prompts the pipeline's columns name and the vault lacks (D-17). What runs is always
 * the vault file, so such a column would skip every dispatch; the settings page seeds them instead
 * of showing "file missing" for a prompt Drey ships.
 */
export function missingShippedPrompts(
  pipeline: readonly PipelinePhase[],
  listing: { readonly entries: readonly { readonly ref: string }[]; readonly shipped: readonly string[] },
): readonly string[] {
  const present = new Set(listing.entries.map((entry) => entry.ref));
  const used = pipeline.flatMap((phase) => {
    const ref = phase.prompt?.trim() || parseHandover(phase.handover).promptRef;
    return parseHandover(phase.handover).mode === 'agent' && ref !== null ? [ref] : [];
  });
  return [...new Set(used)].filter((ref) => listing.shipped.includes(ref) && !present.has(ref));
}

export function usd(amount: number): string {
  return `$${Number.isInteger(amount) ? String(amount) : amount.toFixed(2)}`;
}

/** The Daily budget row: the personas' budgets added up and what they spent today. */
export function budgetLineOf(personas: readonly PersonaView[]): string {
  const budgeted = personas.filter((p) => p.kind !== 'human' && p.budget !== null);
  if (budgeted.length === 0) {
    return 'No persona has a daily budget';
  }
  const total = budgeted.reduce((sum, p) => sum + (p.budget ?? 0), 0);
  const spent = budgeted.reduce((sum, p) => sum + (p.dailyCost ?? 0), 0);
  return `${usd(total)} across ${budgeted.length} ${budgeted.length === 1 ? 'persona' : 'personas'} · ${usd(spent)} spent today`;
}

/** `Claude Code 3 · OpenCode 1`: the pool size per runner. */
export function runnersLineOf(pools: ReadonlyArray<{ readonly label: string; readonly size: number }>): string {
  return pools.map((pool) => `${pool.label} ${pool.size}`).join(' · ');
}

export interface DeskDevice {
  readonly id: string;
  readonly name: string;
}

export interface DeskVideos {
  readonly inGit: boolean;
  readonly maxMb: number;
  readonly existing: number;
  readonly notice: string | null;
}

/** Reads the engine's `settingsRead` answer tolerantly; null = not a settings answer. */
export function parseDeskVideos(json: unknown): DeskVideos | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const videos = ((json as Record<string, unknown>)['engine'] as Record<string, unknown> | undefined)?.['videos'] as
    | Record<string, unknown>
    | undefined;
  if ((json as Record<string, unknown>)['ok'] !== true || videos === undefined || videos === null) {
    return null;
  }
  return {
    inGit: videos['inGit'] === true,
    maxMb: typeof videos['maxMb'] === 'number' ? videos['maxMb'] : 0,
    existing: typeof videos['existing'] === 'number' ? videos['existing'] : 0,
    notice: typeof videos['notice'] === 'string' ? videos['notice'] : null,
  };
}

/** A whole number of megabytes from a field; null = not a number. */
export function maxMbOf(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

export type AutopilotState = 'on' | 'paused' | 'off';

/**
 * The Autopilot row's state as far as the engine tells it today: the chain
 * master is `run` (On) or `halted` (Off). A timed Paused arrives with the
 * engine route of req-95a.
 */
export function autopilotStateOf(master: string | null | undefined): AutopilotState {
  return master === 'run' ? 'on' : 'off';
}
