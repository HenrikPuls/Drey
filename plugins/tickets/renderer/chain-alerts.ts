/**
 * The chain's alerts (fix, owner request 2026-10-31): what stops the
 * fleet from working the board, as rows the Work panel puts on top —
 * a tripped circuit breaker, a held machine column with tickets in it,
 * a halted chain with work waiting, a provider out of quota. The
 * kanban drew the column brakes; the Work panel (ADR-0087) dropped
 * them, so a breaker trip went unseen. Pure — the panel and the
 * notifications share it, the spec pins it.
 */
import type { ChainStatus, RunInfo, RunState } from '../main/fleet/protocol';
import type { BoardSnapshot } from '../shared/tickets';
import { isMachinePhase } from './work-groups';

const LIVE: ReadonlySet<RunState> = new Set(['starting', 'running', 'stopping', 'detached']);

/** The breaker's threshold when a phase names none (the runner's DEFAULT_MAX_RED). */
const DEFAULT_MAX_RED = 3;

export type ChainAlertKind = 'breaker' | 'held' | 'halted' | 'quota';

/** What the alert's one button does; null = nothing to press (a quota waits by itself). */
export type ChainAlertAction =
  | { readonly kind: 'play-column'; readonly phase: string; readonly label: string }
  | { readonly kind: 'run-chain'; readonly label: string };

export interface ChainAlert {
  readonly kind: ChainAlertKind;
  /** Stable per cause: the notification tag and the "already announced" key. */
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly action: ChainAlertAction | null;
}

/** `16:05` in the viewer's time. */
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function waitingLine(ids: readonly string[]): string {
  if (ids.length === 0) {
    return 'nothing waits in it right now';
  }
  const shown = ids.slice(0, 3).join(', ');
  return `${ids.length === 1 ? '1 ticket waits' : `${ids.length} tickets wait`} (${shown}${ids.length > 3 ? ', …' : ''})`;
}

/** A provider id as people read it. */
function providerLabel(provider: string): string {
  return provider === 'opencode' ? 'OpenCode' : provider === 'claude-code' ? 'Claude Code' : provider;
}

export function chainAlertsOf(
  chain: ChainStatus | null,
  board: BoardSnapshot,
  runs: readonly RunInfo[],
  nowMs: number,
): readonly ChainAlert[] {
  if (chain === null || !chain.configured) {
    return [];
  }
  const live = new Set(runs.filter((run) => LIVE.has(run.state)).map((run) => run.ticketId));
  const machine = board.columns.filter((column) => !column.unknown && isMachinePhase(column.phase));
  const waitingIn = (phaseId: string): readonly string[] =>
    machine
      .find((column) => column.phase.id === phaseId)
      ?.tickets.filter((card) => !live.has(card.id) && !card.meta.interactive)
      .map((card) => card.id) ?? [];

  const alerts: ChainAlert[] = [];
  for (const column of machine) {
    const id = column.phase.id;
    if (chain.columns[id] !== 'held') {
      continue;
    }
    const waiting = waitingIn(id);
    const play = { kind: 'play-column' as const, phase: id, label: 'Resume' };
    const trip = chain.tripped?.[id] ?? null;
    // A runner before the fix reports no trips: a hold with a full red streak is one.
    const maxRed = column.phase.maxRed ?? DEFAULT_MAX_RED;
    const tripped = trip !== null || (chain.tripped === undefined && (chain.redStreak[id] ?? 0) >= maxRed);
    if (tripped) {
      const reason = trip?.reason ?? `${chain.redStreak[id] ?? maxRed} red gates in a row`;
      alerts.push({
        kind: 'breaker',
        key: `breaker:${id}:${trip?.at ?? ''}`,
        title: `${column.phase.title} stopped by the circuit breaker`,
        text: `${reason}${trip === null ? '' : ` at ${clock(trip.at)}`} — ${waitingLine(waiting)}. Resume once the cause is fixed.`,
        action: play,
      });
    } else if (waiting.length > 0) {
      alerts.push({
        kind: 'held',
        key: `held:${id}`,
        title: `${column.phase.title} is on hold`,
        text: `${waitingLine(waiting)} — nothing starts there until you resume it.`,
        action: play,
      });
    }
  }

  if (chain.master === 'halted') {
    const waiting = machine.filter((column) => chain.columns[column.phase.id] !== 'held').flatMap((column) => waitingIn(column.phase.id));
    if (waiting.length > 0) {
      alerts.unshift({
        kind: 'halted',
        key: 'halted',
        title: 'The chain is halted',
        text: `${waitingLine(waiting)} — nothing new starts until you run the chain.`,
        action: { kind: 'run-chain', label: 'Run' },
      });
    }
  }

  for (const [provider, until] of Object.entries(chain.quotaPausedUntil ?? {})) {
    if (Date.parse(until) > nowMs) {
      alerts.push({
        kind: 'quota',
        key: `quota:${provider}:${until}`,
        title: `${providerLabel(provider)} is out of quota`,
        text: `Its usage limit is spent — no new ${providerLabel(provider)} run before ${clock(until)}, then the chain tries again by itself.`,
        action: null,
      });
    }
  }
  return alerts;
}

/**
 * The alerts worth an OS notification that `announced` has not seen
 * yet; marks them seen. A breaker trip and a quota pause notify — a
 * plain hold or a halted chain is the owner's own doing.
 */
export function newChainAlerts(alerts: readonly ChainAlert[], announced: Set<string>): readonly ChainAlert[] {
  const fresh = alerts.filter((alert) => (alert.kind === 'breaker' || alert.kind === 'quota') && !announced.has(alert.key));
  for (const alert of fresh) {
    announced.add(alert.key);
  }
  return fresh;
}
