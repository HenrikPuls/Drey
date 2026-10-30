/**
 * The start dialog's handover field (T-0049): the pure half that turns
 * the fleet snapshot plus the config into the three options, their
 * disabled reasons, the computed default and the status line. The same
 * `resolveHandover` rules decide — an option is enabled exactly when an
 * explicit ask for it would be honoured, so the dialog can only disable
 * what the supervisor would refuse, never promise a mode it would
 * silently switch away.
 *
 * Two supervisor-side facts are unknowable before the start (the
 * worktree preparation's sessionInvalidated, a session another run
 * holds): the dialog computes legality without them, and the start-time
 * resolution stays the final word — falling back fresh there is visible
 * as a stream note, not a silent switch.
 */
import { COMPACT_CAPABILITY, resolveHandover, type HandoverCandidate } from '../main/fleet/handover';
import type { FleetHandoverConfig, HandoverMode } from '../main/fleet/protocol';
import { formatTokens } from './worker-status';

export interface HandoverOption {
  readonly mode: HandoverMode;
  readonly label: string;
  readonly disabled: boolean;
  /** One line under the option (title/tooltip): why it is disabled, or what it does. */
  readonly why: string;
}

export interface HandoverDialogState {
  readonly options: readonly HandoverOption[];
  /** What the dialog preselects — the auto rules' answer. */
  readonly defaultMode: HandoverMode;
  /** The one-line context of the run these options would resume. */
  readonly statusLine: string;
}

export interface HandoverDialogInput {
  readonly phase: string;
  readonly candidate: HandoverCandidate | null;
  readonly provider: string;
  readonly model: string | null;
  readonly config: FleetHandoverConfig;
  readonly nowMs: number;
}

const OPTION_LABEL: Readonly<Record<HandoverMode, string>> = {
  fresh: 'Fresh session',
  resume: 'Resume last session',
  'resume-compact': 'Resume + compact first',
};

const OPTION_HELP: Readonly<Record<HandoverMode, string>> = {
  fresh: 'A new session with the composed instruction (the previous behaviour).',
  resume: 'Continue the previous run\u2019s provider session where it left off.',
  'resume-compact': 'Continue it, natively compacted before the first prompt.',
};

/** `3 min ago` / `2 h ago` — the pause since the candidate ended. */
function ageWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

export function handoverDialogState(input: HandoverDialogInput): HandoverDialogState {
  const capability = (COMPACT_CAPABILITY as Readonly<Record<string, 'native' | 'none'>>)[input.provider] ?? 'none';
  const base = {
    phase: input.phase,
    candidate: input.candidate,
    provider: input.provider,
    model: input.model,
    sessionInvalidated: false,
    sessionInUse: false,
    capability,
    config: input.config,
    nowMs: input.nowMs,
  };
  // The auto rules pick the preselection…
  const auto = resolveHandover({ ...base, requested: 'auto' });
  // …and each option is enabled exactly when an explicit ask for it
  // would be honoured — the same rules, asked per mode.
  const options: HandoverOption[] = (['fresh', 'resume', 'resume-compact'] as const).map((mode) => {
    const asked = resolveHandover({ ...base, requested: mode });
    const honoured = asked.mode === mode && asked.compactFirst === (mode === 'resume-compact');
    return {
      mode,
      label: OPTION_LABEL[mode],
      disabled: !honoured,
      // Why it fell back is exactly why it is disabled here.
      why: honoured ? OPTION_HELP[mode] : asked.why,
    };
  });

  const candidate = input.candidate;
  let statusLine: string;
  if (candidate === null) {
    statusLine = 'No earlier run of this ticket — a fresh session.';
  } else {
    const ctx =
      candidate.lastTurnContext !== null ? ` · ctx ${formatTokens(candidate.lastTurnContext)}` : ' · ctx unknown';
    const age =
      candidate.endedAt !== null && Number.isFinite(Date.parse(candidate.endedAt))
        ? ` · ${ageWords(input.nowMs - Date.parse(candidate.endedAt))}`
        : '';
    statusLine = `last: ${candidate.phase} · ${candidate.state}${ctx}${age} — ${OPTION_LABEL[auto.mode].toLowerCase()}`;
  }
  return { options, defaultMode: auto.mode, statusLine };
}
