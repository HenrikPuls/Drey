/**
 * A green commit step lands in Done on the next fleet change, whether or not a
 * client is connected to read the board (req-99a follow-up).
 */
export function settleCommitStepsOnFleet(
  subscribe: (listener: (what: string) => void) => () => void,
  settle: () => Promise<void>,
  log: (message: string, level: 'warn') => void,
): () => void {
  return subscribe((what) => {
    if (what === 'fleet') {
      settle().catch((error: unknown) => {
        log(`commit step settling failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      });
    }
  });
}
