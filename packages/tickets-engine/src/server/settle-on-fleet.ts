/**
 * A green commit step lands in Done on the next fleet change, whether or not a
 * client is connected to read the board (req-99a follow-up) — and on the next
 * board change too (D-32): on a store the runner's release of its claim is a
 * store write that follows the run's `done` by a moment, and the step settles
 * only once the ticket is back on Ready to try.
 */
export function settleCommitStepsOnFleet(
  subscribe: (listener: (what: string) => void) => () => void,
  settle: () => Promise<void>,
  log: (message: string, level: 'warn') => void,
): () => void {
  return subscribe((what) => {
    if (what === 'fleet' || what === 'board') {
      settle().catch((error: unknown) => {
        log(`commit step settling failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      });
    }
  });
}
