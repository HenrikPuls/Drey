/**
 * The order of the fleet's snapshots in the renderer (D-49). They come two ways: the engine
 * pushes `fleet-changed`, and the renderer pulls `fleetStatus`. A pull's reply says what was
 * true when it was asked, so a push that landed after the question is newer, whichever
 * arrives last: without this the reply replaces it and a live run disappears from the panel
 * until the next push.
 */
export interface SnapshotOrder {
  /** A pushed snapshot arrived: applies it. */
  push(apply: () => void): void;
  /** Asks for a snapshot and applies the reply, unless something newer was applied since the question. */
  pull<T>(request: () => Promise<T>, apply: (reply: T) => void): Promise<void>;
}

export function createSnapshotOrder(): SnapshotOrder {
  let clock = 0;
  let applied = 0;
  return {
    push(apply) {
      clock += 1;
      applied = clock;
      apply();
    },
    async pull(request, apply) {
      clock += 1;
      const asked = clock;
      const reply = await request();
      if (asked > applied) {
        applied = asked;
        apply(reply);
      }
    },
  };
}
