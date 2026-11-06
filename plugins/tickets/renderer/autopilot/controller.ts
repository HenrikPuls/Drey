// i18n: catalog
/**
 * The desktop's Autopilot writes (req-95b): `chainAutopilot` for a state, the
 * existing `chainAbort` for "Stop all running steps now…". A refusal comes
 * back as words from the catalog, keyed by the engine's code — never the
 * code itself and never an English sentence of the plugin's own.
 */
import { autopilotRefusalCodeOf, autopilotRefusalKeyOf, type AutopilotView } from '../../../../shared/autopilot';
import type { ChainStatus } from '../../../../packages/tickets-engine/src/fleet/protocol';
import type { Translate } from '../status-slot';

export interface AutopilotIo {
  invoke(method: string, payload?: unknown): Promise<unknown>;
}

export type AutopilotOutcome =
  | { readonly ok: true; readonly status: ChainStatus | null }
  | { readonly ok: false; readonly words: string };

async function run(io: AutopilotIo, t: Translate, method: string, payload: unknown): Promise<AutopilotOutcome> {
  let reply: unknown;
  try {
    reply = await io.invoke(method, payload);
  } catch {
    return { ok: false, words: t(autopilotRefusalKeyOf('runner_down')) };
  }
  const body = (typeof reply === 'object' && reply !== null ? reply : {}) as { ok?: unknown; status?: ChainStatus };
  if (body.ok === true) {
    return { ok: true, status: body.status ?? null };
  }
  return { ok: false, words: t(autopilotRefusalKeyOf(autopilotRefusalCodeOf(reply))) };
}

/** Sets the Autopilot state (and, on Paused, its resume time). */
export function writeAutopilot(io: AutopilotIo, t: Translate, record: AutopilotView): Promise<AutopilotOutcome> {
  return run(io, t, 'chainAutopilot', record);
}

/** The chain's stop-all: every live run aborted, the chain halted. */
export function stopAllNow(io: AutopilotIo, t: Translate): Promise<AutopilotOutcome> {
  return run(io, t, 'chainAbort', {});
}
