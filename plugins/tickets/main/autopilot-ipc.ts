/**
 * The plugin's `chainAutopilot` IPC (req-95b): the renderer's Autopilot
 * writes (status item, popover, `Mod+Alt+P`, the Settings row) take the same
 * road as the remote route — `parseAutopilotSet` on the payload, the runner's
 * `POST /chain/autopilot` behind `FleetClient.setAutopilot` — and get the
 * same reply shape: the new chain status, or a refusal with its code.
 */
import { parseAutopilotSet } from '../../../packages/tickets-engine/src/fleet/autopilot';
import type { AutopilotRecord, AutopilotRefusal, ChainStatus } from '../../../packages/tickets-engine/src/fleet/protocol';

export type ChainAutopilotReply = { readonly ok: true; readonly status: ChainStatus } | AutopilotRefusal;

export async function chainAutopilotOf(
  payload: unknown,
  now: Date,
  set: (record: AutopilotRecord) => Promise<ChainStatus | AutopilotRefusal | null>,
): Promise<ChainAutopilotReply> {
  const parsed = parseAutopilotSet(payload, now);
  if (!parsed.ok) {
    return parsed;
  }
  const reply = await set(parsed.value);
  if (reply === null) {
    return { ok: false, error: 'runner_down', code: 'runner_down' };
  }
  return 'ok' in reply ? reply : { ok: true, status: reply };
}
