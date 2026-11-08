/**
 * Drey Service's entry (req-164, ADR-0092): the one background process
 * shipped with Drey. Started by the Drey plugin when no service is running
 * (`launch.ts`), at Windows log-in when the owner switched that on, or by
 * hand:
 *
 *   service-main.js [--vault <tickets vault>] [--home <dir>]   run the service
 *   service-main.js --version                                   the version and build stamp
 *   service-main.js --status                                    the components, from service.lock + /status
 *   service-main.js --stop                                      ask a running service to leave
 *   service-main.js --autostart on|off|status                   start with Windows (opt-in; on also enables the service)
 *
 * The home is `~/.drey-engine` (the integrator's ruling of 2026-11-08: the
 * engine's config, the fleet root and the e2e isolation stay where they
 * are). One service per home: `service.lock`, plus a boot claim
 * (`service.starting`) so two Dreys starting at once cannot start two.
 */
import { closeSync, openSync, promises as fsp, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fleetBuildStamp } from '../fleet/build-stamp';
import { clientDirOf } from '../server/client-dir';
import { FileConfigStore } from '../server/file-config';
import { autostartEntry, setAutostart } from './launch';
import { ServiceHost } from './service-host';
import { COMPONENT_NAMES, readServiceLock, serviceAlive, type ServiceLock } from './service-lock';
import { serviceIdleMsOf } from './sleep';

export const SERVICE_VAULT_KEY = 'service.vaultPath';
export const SERVICE_IDLE_KEY = 'service.idleMinutes';

export interface CliOptions {
  readonly command: 'run' | 'version' | 'status' | 'stop' | 'autostart';
  readonly vault: string | null;
  readonly home: string;
  readonly autostart: 'on' | 'off' | 'status' | null;
  readonly idleMs: number | null;
}

export function parseServiceArgs(argv: readonly string[], home = path.join(homedir(), '.drey-engine')): CliOptions {
  let command: CliOptions['command'] = 'run';
  let vault: string | null = null;
  let autostart: CliOptions['autostart'] = null;
  let idleMs: number | null = null;
  let chosenHome = home;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string | null => {
      if (arg.includes('=')) {
        return arg.slice(arg.indexOf('=') + 1);
      }
      return argv[++i] ?? null;
    };
    if (arg === '--version' || arg === '-v') {
      command = 'version';
    } else if (arg === '--status') {
      command = 'status';
    } else if (arg === '--stop') {
      command = 'stop';
    } else if (arg === '--autostart' || arg.startsWith('--autostart=')) {
      command = 'autostart';
      const v = value();
      autostart = v === 'on' || v === 'off' ? v : 'status';
    } else if (arg === '--vault' || arg.startsWith('--vault=')) {
      vault = value();
    } else if (arg === '--home' || arg.startsWith('--home=')) {
      chosenHome = value() ?? chosenHome;
    } else if (arg === '--idle-ms' || arg.startsWith('--idle-ms=')) {
      const n = Number(value());
      idleMs = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return { command, vault: vault === null ? null : path.resolve(vault), home: path.resolve(chosenHome), autostart, idleMs };
}

/** The repository / app root: the entry sits at `<root>/dist-electron/packages/tickets-engine/src/service/`. */
const APP_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The `--status` text: one line per component. */
export function formatStatus(lock: ServiceLock, status: { components?: ServiceLock['components']; sleep?: { sleep: boolean; reason?: string }; dreyClients?: number } | null): string {
  const components = status?.components ?? lock.components;
  const lines = [
    `Drey Service — running (pid ${lock.pid}, since ${lock.startedAt})`,
    `  build    ${lock.build}`,
    `  home     ${lock.home}`,
    `  vault    ${lock.vaultPath}`,
    `  control  127.0.0.1:${lock.port}`,
  ];
  if (status?.sleep !== undefined) {
    lines.push(`  held by  ${status.sleep.sleep ? 'nothing (it leaves after the idle span)' : (status.sleep.reason ?? '?')}${status.dreyClients !== undefined ? ` · ${status.dreyClients} Drey client(s)` : ''}`);
  }
  lines.push('');
  for (const name of COMPONENT_NAMES) {
    const record = components[name];
    lines.push(`  ${name.padEnd(8)} ${(record?.state ?? 'unknown').padEnd(9)} ${record?.detail ?? ''}`.trimEnd());
  }
  return lines.join('\n');
}

async function fetchStatus(lock: ServiceLock): Promise<Parameters<typeof formatStatus>[1]> {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/status`, { headers: { Authorization: `Bearer ${lock.token}` } });
    return res.ok ? ((await res.json()) as Parameters<typeof formatStatus>[1]) : null;
  } catch {
    return null;
  }
}

/** The boot claim: true when this process may start the service in `home`. */
async function claimBoot(home: string): Promise<boolean> {
  const file = path.join(home, 'service.starting');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      await fsp.writeFile(file, String(process.pid), 'utf8');
      closeSync(fd);
      return true;
    } catch {
      const pid = Number(await fsp.readFile(file, 'utf8').catch(() => ''));
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
        return false;
      }
      await fsp.rm(file, { force: true });
    }
  }
  return false;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function run(opts: CliOptions): Promise<number> {
  const out = (line: string): void => console.log(line);
  const build = await fleetBuildStamp(__filename).catch(() => 'unknown');
  switch (opts.command) {
    case 'version':
      out(`Drey Service ${appVersion()} (build ${build})`);
      return 0;
    case 'status': {
      const lock = await readServiceLock(opts.home);
      if (lock === null || !(await serviceAlive(lock))) {
        out(`Drey Service — not running (home ${opts.home})`);
        return 3;
      }
      out(formatStatus(lock, await fetchStatus(lock)));
      return 0;
    }
    case 'stop': {
      const lock = await readServiceLock(opts.home);
      if (lock === null || !(await serviceAlive(lock))) {
        out('Drey Service — not running');
        return 0;
      }
      await fetch(`http://127.0.0.1:${lock.port}/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${lock.token}`, 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => undefined);
      for (let i = 0; i < 300 && (await serviceAlive(lock)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      out((await serviceAlive(lock)) ? 'Drey Service is still stopping its live runs' : 'Drey Service stopped');
      return 0;
    }
    case 'autostart': {
      // Start with Windows belongs to the background service: on also switches it on.
      if (opts.autostart === 'on' || opts.autostart === 'off') {
        const on = opts.autostart === 'on';
        const settings = on ? { enabled: true, autostart: true } : { autostart: false };
        const lock = await readServiceLock(opts.home);
        if (lock !== null && (await serviceAlive(lock))) {
          // A running service owns the setting: it writes it and applies the registry itself.
          await fetch(`http://127.0.0.1:${lock.port}/settings`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${lock.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(settings),
          });
        } else {
          const config = new FileConfigStore(path.join(opts.home, 'config.json'));
          await config.setMany(Object.entries(settings).map(([key, value]) => [`service.${key}`, value] as const));
          await setAutostart(on, { entry: __filename, home: opts.home, vaultPath: null });
        }
      }
      const entry = await autostartEntry();
      out(entry === null ? 'start with Windows: off' : `start with Windows: on\n  ${entry}`);
      return 0;
    }
    case 'run':
      break;
  }

  await fsp.mkdir(opts.home, { recursive: true });
  const existing = await readServiceLock(opts.home);
  if (existing !== null && (await serviceAlive(existing))) {
    out(`Drey Service is already running (pid ${existing.pid})`);
    return 0;
  }
  if (!(await claimBoot(opts.home))) {
    out('another Drey Service is starting in this home');
    return 0;
  }
  const config = new FileConfigStore(path.join(opts.home, 'config.json'));
  const vault = opts.vault ?? (await config.get<string>(SERVICE_VAULT_KEY)) ?? null;
  if (vault === null) {
    await fsp.rm(path.join(opts.home, 'service.starting'), { force: true });
    console.error('usage: service-main.js --vault <tickets vault> — no vault given and none remembered from an earlier start');
    return 2;
  }
  await config.set(SERVICE_VAULT_KEY, vault);
  const clientDir = await clientDirOf(path.join(APP_ROOT, 'dist', 'mission-control', 'browser'), path.join(APP_ROOT, 'plugins', 'tickets', 'remote'));
  try {
    const host = await ServiceHost.start({
      home: opts.home,
      vaultPath: vault,
      clientDir,
      build,
      idleMs: opts.idleMs ?? serviceIdleMsOf(await config.get<unknown>(SERVICE_IDLE_KEY)),
      exit: (code) => process.exit(code),
      stdout: out,
      applyAutostart: (on) =>
        process.platform === 'win32' ? setAutostart(on, { entry: __filename, home: opts.home, vaultPath: null }) : Promise.resolve(),
    });
    const quit = (): void => void host.shutdown({ handover: false });
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  } finally {
    await fsp.rm(path.join(opts.home, 'service.starting'), { force: true });
  }
  return -1;
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  run(parseServiceArgs(process.argv.slice(2))).then(
    (code) => {
      if (code >= 0) {
        process.exit(code);
      }
      // -1: the service runs; its listeners keep the process alive.
    },
    (error: unknown) => {
      console.error(`Drey Service failed to start: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
