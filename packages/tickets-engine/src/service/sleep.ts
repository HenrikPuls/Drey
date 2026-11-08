/**
 * When Drey Service may leave (req-164, ADR-0092) — the second of two
 * levels:
 *
 * 1. **The Crew runner component** sleeps on req-110's verdict
 *    (`fleet/runner-lifecycle.ts`, unchanged): a live run keeps it, an
 *    On/Paused Autopilot keeps it, otherwise it goes when the Autopilot is
 *    switched Off, when Drey has gone (`/retire-if-idle`), or after its own
 *    idle span without a write. It wakes on the next write that needs it
 *    (D-51, req-154) — inside the same process, nothing is spawned.
 * 2. **The service process** leaves only when nothing holds it — no Drey
 *    client on the engine's event stream (`DreyPresence`), the runner
 *    asleep (so no live run and no Autopilot), and the remote gateway not
 *    serving a paired device (the integrator's ruling of 2026-11-08: a
 *    phone cannot wake a service that is gone, so an enabled gateway with
 *    at least one paired device keeps it awake) — and that has lasted the
 *    idle span (`service.idleMinutes`, 15 by default).
 */

export interface ServiceLiveness {
  /** Drey instances holding the engine's `/api/events` stream. */
  readonly dreyClients: number;
  /** The runner component is awake (a live run or a running/paused Autopilot keeps it so). */
  readonly runnerAwake: boolean;
  /** The remote gateway is enabled and at least one device is paired. */
  readonly gatewayServesDevices: boolean;
}

export type SleepReason = 'drey' | 'runner' | 'remote gateway';

export type SleepVerdict = { readonly sleep: true } | { readonly sleep: false; readonly reason: SleepReason };

/** What holds the service, first reason first; nothing holding means it may leave once the span is over. */
export function serviceSleepVerdict(state: ServiceLiveness): SleepVerdict {
  if (state.dreyClients > 0) {
    return { sleep: false, reason: 'drey' };
  }
  if (state.runnerAwake) {
    return { sleep: false, reason: 'runner' };
  }
  if (state.gatewayServesDevices) {
    return { sleep: false, reason: 'remote gateway' };
  }
  return { sleep: true };
}

export const DEFAULT_SERVICE_IDLE_MS = 15 * 60_000;

/** The configured span (`service.idleMinutes`), or the default for anything that is not a positive number. */
export function serviceIdleMsOf(minutes: unknown): number {
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : DEFAULT_SERVICE_IDLE_MS;
}

/**
 * The service's idle clock: it starts the moment the last holder lets go,
 * and any holder coming back resets it — a Drey that reconnects, a runner
 * that wakes, a device paired.
 */
export class ServiceIdleWatch {
  private releasedAt: number | null;

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {
    // A fresh service counts from its start: started by hand or at log-in
    // with nobody coming, it does not stand for ever.
    this.releasedAt = now();
  }

  /** True when nothing has held the service for the whole span. */
  expired(state: ServiceLiveness): boolean {
    if (!serviceSleepVerdict(state).sleep) {
      this.releasedAt = null;
      return false;
    }
    this.releasedAt ??= this.now();
    return this.now() - this.releasedAt >= this.idleMs;
  }
}
