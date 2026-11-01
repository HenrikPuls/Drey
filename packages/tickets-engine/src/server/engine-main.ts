import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createEngine, removeEngineLock, writeEngineLock } from './engine';

/**
 * The standalone tickets-engine process (ADR-0088, E2b). Started by the
 * Drey plugin (`ELECTRON_RUN_AS_NODE`, same pattern as the fleet runner)
 * or by hand:
 *
 *   node engine-main.js --vault "E:/notes" [--home "C:/Users/me/.drey-engine"]
 *
 * One engine per machine: the lockfile in the engine home records
 * pid/invoke-port/token; the Drey plugin adopts a live engine instead of
 * spawning a second one, and the phone reaches the same engine through
 * the gateway's pairing either way.
 */

interface CliOptions {
  vault: string;
  home: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let vault: string | null = null;
  let home: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--vault') {
      vault = argv[++i] ?? null;
    } else if (arg.startsWith('--vault=')) {
      vault = arg.slice('--vault='.length);
    } else if (arg === '--home') {
      home = argv[++i] ?? null;
    } else if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length);
    }
  }
  if (vault === null) {
    throw new Error('usage: engine-main.js --vault <absolute tickets vault path> [--home <engine home>]');
  }
  return { vault: path.resolve(vault), home: path.resolve(home ?? path.join(homedir(), '.drey-engine')) };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const log = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
    const line = `[${new Date().toISOString()}] ${level}: ${message}`;
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  await fsp.mkdir(opts.home, { recursive: true });
  const engine = await createEngine({
    vaultPath: opts.vault,
    home: opts.home,
    clientDir: path.resolve(__dirname, '../../../..', 'plugins', 'tickets', 'remote'),
    log,
  });
  const invokePort = Number(new URL(engine.invokeUrl).port);
  await writeEngineLock(opts.home, { pid: process.pid, invokePort, token: engine.token, vaultPath: opts.vault });
  log(`tickets engine up: vault=${opts.vault} invoke=${engine.invokeUrl}`);

  const shutdown = async (): Promise<void> => {
    await engine.close();
    await removeEngineLock(opts.home);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Stay alive: the listeners above keep the loop running.
}

main().catch((error: unknown) => {
  console.error(`tickets engine failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
