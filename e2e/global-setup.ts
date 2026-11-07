import { sweepLeftoverEngines } from './fixtures/engine-sweep';

/**
 * Before the first spec: end the engines and remove the homes a previous
 * run left behind (an aborted run never reaches its own teardown -- D-43).
 */
export default function globalSetup(): void {
  sweepLeftoverEngines({ log: (line) => console.log(line) });
}
