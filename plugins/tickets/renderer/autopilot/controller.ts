// i18n: catalog
/**
 * The desktop's Autopilot writes (req-95b): `chainAutopilot` for a state, the
 * existing `chainAbort` for "Stop all running steps now…". A refusal comes
 * back as words from the catalog, keyed by the engine's code — never the
 * code itself and never an English sentence of the plugin's own. The reason
 * travels with it (D-51): a runner that could not be started says why, and
 * a write that got no answer at all says what failed — "the runner is not
 * running" only when the engine said so.
 */
import { autopilotFailureWordsOf, autopilotRefusalWordsOf, type AutopilotRefusalWords, type AutopilotView } from '../../../../shared/autopilot';
import type { ChainStatus } from '../../../../packages/tickets-engine/src/fleet/protocol';
import type { Translate } from '../status-slot';

export interface AutopilotIo {
  invoke(method: string, payload?: unknown): Promise<unknown>;
}

export type AutopilotOutcome =
  | { readonly ok: true; readonly status: ChainStatus | null }
  | { readonly ok: false; readonly words: string };

const wordsOf = (t: Translate, words: AutopilotRefusalWords): string => t(words.key, words.params);

async function run(io: AutopilotIo, t: Translate, method: string, payload: unknown): Promise<AutopilotOutcome> {
  let reply: unknown;
  try {
    reply = await io.invoke(method, payload);
  } catch (error) {
    return { ok: false, words: wordsOf(t, autopilotFailureWordsOf(error)) };
  }
  const body = (typeof reply === 'object' && reply !== null ? reply : {}) as { ok?: unknown; status?: ChainStatus };
  if (body.ok === true) {
    return { ok: true, status: body.status ?? null };
  }
  return { ok: false, words: wordsOf(t, autopilotRefusalWordsOf(reply)) };
}

/** Sets the Autopilot state (and, on Paused, its resume time). */
export function writeAutopilot(io: AutopilotIo, t: Translate, record: AutopilotView): Promise<AutopilotOutcome> {
  return run(io, t, 'chainAutopilot', record);
}

/** The chain's stop-all: every live run aborted, the chain halted. */
export function stopAllNow(io: AutopilotIo, t: Translate): Promise<AutopilotOutcome> {
  return run(io, t, 'chainAbort', {});
}
