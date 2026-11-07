/**
 * When the fleet runner may leave (req-110). The runner is a detached
 * process (ADR-0075): it survives Drey so that live runs do, and a
 * running or paused Autopilot keeps it because the chain is what drains
 * the board while Drey is closed (M85). Everything else is a reason to
 * go — the engine respawns it on the next start.
 *
 * Two triggers besides the idle span: the Autopilot going **Off**
 * (the runner was deactivated), and Drey quitting (the engine asks
 * `POST /retire-if-idle` once its last Drey client is gone). Both end
 * the process only when this verdict says so, so a run never dies with
 * the app that started it.
 */

export interface RunnerLiveness {
  /** Supervisors with a live run (`starting` / `running` / `stopping`). */
  readonly live: number;
  /** `Orchestrator.keepsRunnerAlive`: a configured chain whose Autopilot is On or Paused. */
  readonly keepsAlive: boolean;
}

export type RetireVerdict =
  | { readonly exiting: true }
  | { readonly exiting: false; readonly reason: 'live runs' | 'autopilot' };

/** Exit is allowed only with nothing live and no Autopilot to serve. */
export function retireVerdict(state: RunnerLiveness): RetireVerdict {
  if (state.live > 0) {
    return { exiting: false, reason: 'live runs' };
  }
  if (state.keepsAlive) {
    return { exiting: false, reason: 'autopilot' };
  }
  return { exiting: true };
}

/**
 * The idle span, counted from the last **write** or the last moment a run
 * was live. Reads do not count: the engine polls `/status` every 2.5 s for
 * as long as it lives, and with every request resetting the clock the
 * documented "~15 min idle" exit never fired once the engine outlived Drey —
 * the runner stood for days.
 */
export class IdleWatch {
  private lastActivity: number;

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lastActivity = now();
  }

  /** A request that changes state (every POST). */
  noteActivity(): void {
    this.lastActivity = this.now();
  }

  /** True when the runner has stood idle for the span: nothing live, nothing kept, no write. */
  expired(state: RunnerLiveness): boolean {
    if (state.live > 0) {
      // A run that just ended gets the whole span before the exit.
      this.lastActivity = this.now();
      return false;
    }
    if (state.keepsAlive) {
      return false;
    }
    return this.now() - this.lastActivity > this.idleMs;
  }
}
