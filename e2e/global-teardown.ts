import { sweepLeftoverEngines } from './fixtures/engine-sweep';

/**
 * After the last spec: the same sweep, so a run that was interrupted
 * (Playwright still runs this on Ctrl+C) or whose fixture teardown was cut
 * off leaves no engine behind. Whatever still escapes, the next run's
 * `globalSetup` catches.
 */
export default function globalTeardown(): void {
  sweepLeftoverEngines({ log: (line) => console.log(line) });
}
