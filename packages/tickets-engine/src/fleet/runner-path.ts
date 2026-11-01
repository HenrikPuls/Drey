import path from 'node:path';

/**
 * The bundled fleet-runner entry, next to this module in the compiled tree
 * (`dist-electron/packages/tickets-engine/src/fleet/runner.js`). The Drey
 * plugin spawns it with `ELECTRON_RUN_AS_NODE`; keeping the path here means
 * the spawn site never hard-codes a layout it cannot see.
 */
export const RUNNER_SCRIPT_PATH = path.join(__dirname, 'runner.js');
