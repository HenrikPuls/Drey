import { InjectionToken, type Signal } from '@angular/core';
import { autopilotRefusalCodeOf, type AutopilotRefusalCode, type AutopilotView } from '../../../../shared/autopilot';

export type { AutopilotView };

/** What a write hands back: done, or a refusal whose code the clients map to words. */
export type McAutopilotReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly code?: AutopilotRefusalCode };

/**
 * The Autopilot as every Mission Control surface sees it (req-95b, concept
 * 6.1): the iPad chip, the phone app-bar button and sheet, the menu row. The
 * shell binds it to the desk's state; the state arrives over the desk's
 * event stream, so no component polls.
 */
export interface McAutopilotState {
  /** The state and resume time; null = the desk has no chain config (every control hides). */
  readonly autopilot: Signal<AutopilotView | null>;
  /** A read-only device sees the state; every control is disabled. */
  readonly readOnly: Signal<boolean>;
  /** Switches the state (`POST /api/chain/autopilot`). */
  set(record: AutopilotView): Promise<McAutopilotReply>;
  /** "Stop all running steps now" — the chain's existing stop-all (`POST /api/chain/abort`). */
  stopAll(): Promise<McAutopilotReply>;
}

export const MC_AUTOPILOT = new InjectionToken<McAutopilotState | null>('mc-autopilot', {
  providedIn: 'root',
  factory: () => null,
});

/** A refused chain write as the surfaces read it: the engine's code when the body carried one, else the words it sent. */
export function autopilotRefusalOf(body: unknown, fallback: string): McAutopilotReply {
  const code = autopilotRefusalCodeOf(body);
  const error = (typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined);
  return {
    ok: false,
    error: typeof error === 'string' && error !== '' ? error : fallback,
    ...(code !== null ? { code } : {}),
  };
}
