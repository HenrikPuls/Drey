import type { PipelinePhase } from '../contracts/tickets';
import type { ChainStoreConfig, RunDkTarget } from './protocol';

/**
 * Where a run of the board claims its ticket (E14-5, E14-5b): the store, the stage a release may
 * retreat to (dk refuses an agent's same-stage release, R-31: the lease then writes the stage back),
 * whether the store has a `blocked` / `needs-input` stage to park in. One function for the board's
 * owner-started runs and the chain orchestrator, so both compose the same target.
 */
export function dkTargetFor(store: ChainStoreConfig, pipeline: readonly PipelinePhase[], phaseId: string): RunDkTarget {
  const index = pipeline.findIndex((p) => p.id === phaseId);
  return {
    bin: store.dkPath,
    store: store.dkStore,
    dataDir: store.dkDataDir,
    checkout: store.dkCheckout,
    parkStage: pipeline.some((p) => p.id === 'blocked') ? 'blocked' : null,
    needsInputStage: pipeline.some((p) => p.id === 'needs-input') ? 'needs-input' : null,
    retreatStage: index > 0 ? pipeline[index - 1]!.id : null,
    trailers: store.trailers,
  };
}

/** The stage a claim stage retreats to, per working stage - what {@link RunSupervisor.releaseLeftoverClaims} needs for tickets it has no run record of. */
export function retreatStages(pipeline: readonly PipelinePhase[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  pipeline.forEach((phase, index) => {
    out[phase.id] = index > 0 ? pipeline[index - 1]!.id : null;
  });
  return out;
}
