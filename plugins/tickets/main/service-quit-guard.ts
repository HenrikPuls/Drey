// i18n: catalog
/**
 * The background service is optional (the owner's ruling on Q3, 2026-11-08,
 * req-164). With `service.enabled` off the components live and die with
 * Drey, so closing Drey while an agent run is live asks first — the
 * save-before-exit prompt's pattern, as a quit guard (SDK 1.53):
 *
 * - **Stop the runs and quit** — the Notaus (`abortAll`), then Drey closes and
 *   the service follows it;
 * - **Keep running (enable the service)** — `service.enabled` on (the plugin
 *   config and the engine's), Drey closes and the service outlives it;
 * - **Cancel** — Drey stays.
 *
 * With the service on, or with nothing live, the guard lets the close go on.
 */
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';

export const SERVICE_ENABLED_KEY = 'service.enabled';
export const SERVICE_AUTOSTART_KEY = 'service.autostart';

const LIVE_STATES: ReadonlySet<string> = new Set(['starting', 'running', 'stopping']);

/** The runs a quit would end: live ones, once per id (a boot-adopted run can be listed twice). */
export function liveRunsOf(runs: readonly RunInfo[]): readonly RunInfo[] {
  const byId = new Map<string, RunInfo>();
  for (const run of runs) {
    if (LIVE_STATES.has(run.state) && !byId.has(run.id)) {
      byId.set(run.id, run);
    }
  }
  return [...byId.values()];
}

export type QuitChoice = 'stop' | 'keep' | 'cancel';

export interface ServiceQuitGuardDeps {
  readonly config: { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void> };
  readonly runs: () => Promise<readonly RunInfo[]>;
  readonly abortAll: () => Promise<unknown>;
  /** Writes a key into the engine's config (the service reads its mode there). */
  readonly configSet: (key: string, value: unknown) => Promise<unknown>;
  /** Asks the owner; the real one is a native message box on the main window. */
  readonly ask: (liveCount: number) => Promise<QuitChoice>;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/** The guard: true lets Drey close, false keeps it open. */
export function createServiceQuitGuard(deps: ServiceQuitGuardDeps): () => Promise<boolean> {
  return async () => {
    if ((await deps.config.get<boolean>(SERVICE_ENABLED_KEY)) === true) {
      return true;
    }
    const live = liveRunsOf(await deps.runs().catch(() => [] as RunInfo[]));
    if (live.length === 0) {
      return true;
    }
    const choice = await deps.ask(live.length);
    if (choice === 'cancel') {
      return false;
    }
    if (choice === 'keep') {
      await deps.config.set(SERVICE_ENABLED_KEY, true);
      await deps.configSet(SERVICE_ENABLED_KEY, true).catch((error: unknown) => deps.log(`enabling the background service failed: ${String(error)}`, 'warn'));
      deps.log(`the background service was switched on at quit — ${live.length} live run(s) keep running`);
      return true;
    }
    await deps.abortAll().catch((error: unknown) => deps.log(`stopping the runs at quit failed: ${String(error)}`, 'warn'));
    deps.log(`stopped ${live.length} live run(s) at quit (the background service is off)`);
    return true;
  };
}

/** The message box's words, from the catalog. */
export interface QuitWords {
  readonly message: string;
  readonly detail: string;
  readonly stop: string;
  readonly keep: string;
  readonly cancel: string;
}

export function quitWordsOf(t: (key: string, params?: Record<string, unknown>) => string, liveCount: number): QuitWords {
  return {
    message: t('service.quit.message', { count: liveCount }),
    detail: t('service.quit.detail'),
    stop: t('service.quit.stop'),
    keep: t('service.quit.keep'),
    cancel: t('service.quit.cancel'),
  };
}
