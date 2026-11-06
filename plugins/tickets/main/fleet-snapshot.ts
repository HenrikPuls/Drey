import type { FleetClient, FleetSnapshot } from '../../../packages/tickets-engine/src/services/fleet-client';

export type FleetSnapshotSource = Pick<FleetClient, 'runs' | 'chainStatus'>;

/**
 * The engine's `fleet` frame is a signal without a payload (ADR-0088); the
 * renderer's `fleet-changed` channel carries the whole fleet (D-35). This reads
 * it on each signal and sends it on. Reads never overlap, so an older reply
 * cannot land after a newer one: a signal during a read means one more read.
 * A failed read sends nothing, so the renderer keeps what it has.
 *
 * The returned function resolves when the reads it joined have finished.
 */
export function createFleetSnapshotSender(
  source: FleetSnapshotSource,
  send: (snapshot: FleetSnapshot) => void,
  onFailure: (error: unknown) => void = () => undefined,
): () => Promise<void> {
  let draining: Promise<void> | null = null;
  let again = false;
  const drain = async (): Promise<void> => {
    do {
      again = false;
      try {
        const [runs, chain] = await Promise.all([source.runs(), source.chainStatus()]);
        send({ runs, chain });
      } catch (error) {
        onFailure(error);
      }
    } while (again);
    draining = null;
  };
  return () => {
    if (draining !== null) {
      again = true;
      return draining;
    }
    draining = drain();
    return draining;
  };
}
