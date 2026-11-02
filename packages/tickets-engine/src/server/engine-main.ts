import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { loadShippedPrompts } from '../core/default-prompts';
import { createEngine, removeEngineLock, writeEngineLock } from './engine';
import { initVault } from './init-vault';
import { TicketsGit } from '../core/tickets-git';

/**
 * The standalone tickets-engine process (ADR-0088, E2b). Started by the
 * Drey plugin (`ELECTRON_RUN_AS_NODE`, same pattern as the fleet runner)
 * or by hand:
 *
 *   node engine-main.js --vault "E:/notes" [--home "C:/Users/me/.drey-engine"]
 *
 * A tickets repository is set up from nothing with the init subcommand
 * (M112) — the `git init` of the tickets vault: scaffold + one commit:
 *
 *   node engine-main.js init "E:/notes"
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

/** The `init <dir>` branch: scaffold a tickets repository, then exit. */
async function runInit(argv: readonly string[]): Promise<number> {
  const rest = argv.slice(1).filter((arg) => !arg.startsWith('--'));
  if (rest.length > 1) {
    console.error('usage: engine-main.js init <tickets repository directory>');
    return 1;
  }
  const target = path.resolve(rest[0] ?? process.cwd());
  const log = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
    const line = `[${new Date().toISOString()}] ${level}: ${message}`;
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  const result = await initVault(target, await loadShippedPrompts(), {
    mkdir: async (dir) => {
      await fsp.mkdir(dir, { recursive: true });
    },
    exists: async (file) => {
      try {
        await fsp.stat(file);
        return true;
      } catch {
        return false;
      }
    },
    writeFile: async (file, text) => {
      await fsp.writeFile(file, text, 'utf8');
    },
    git: new TicketsGit(() => 'git'),
    log,
  });
  if (!result.ok) {
    console.error(`tickets init failed: ${result.error}`);
    return 1;
  }
  log(`initialized tickets repository in ${result.root}`);
  log(`start the engine: node engine-main.js --vault ${result.root}`);
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') {
    process.exit(await runInit(argv));
  }
  const opts = parseArgs(argv);
  const log = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
    const line = `[${new Date().toISOString()}] ${level}: ${message}`;
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  // The built Mission Control app when present, the legacy remote
  // client otherwise — the strangler hand-over (E5b).
  const repoRoot = path.resolve(__dirname, '../../../..', '..');
  const builtApp = path.join(repoRoot, 'dist', 'mission-control', 'browser');
  const clientDir = (await fsp.stat(path.join(builtApp, 'index.html'))).isFile()
    ? builtApp
    : path.resolve(__dirname, '../../../..', 'plugins', 'tickets', 'remote');
  await fsp.mkdir(opts.home, { recursive: true });
  const engine = await createEngine({
    vaultPath: opts.vault,
    home: opts.home,
    clientDir,
    log,
  });
  log(`serving ${clientDir === builtApp ? 'Mission Control' : 'the legacy remote client'}`);
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
