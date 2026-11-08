/**
 * How Drey Service is started — the one seam (req-164).
 *
 * The owner's open question Q3 decides the process mode: plain Node under
 * Electron's binary (`ELECTRON_RUN_AS_NODE`, today's way, the default here)
 * or Electron headless (`Drey.exe --drey-service`, which the tray of
 * req-165 and a clean Windows log-in start would need). Both the spawn from
 * Drey and the Windows log-in entry are built here and only here, so the
 * answer changes this file, not its callers.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface LaunchTarget {
  /** The built service entry (`dist-electron/packages/tickets-engine/src/service/service-main.js`). */
  readonly entry: string;
  readonly home: string;
  /** The tickets vault; null for a start that reads the last one from the config (the log-in start). */
  readonly vaultPath: string | null;
  /** The binary to run; the current process's (Electron's) by default. */
  readonly execPath?: string;
}

/** The process mode (Q3). Node until the owner rules otherwise. */
export type ServiceMode = 'node';
export const SERVICE_MODE: ServiceMode = 'node';

export const SERVICE_ENTRY_NAME = 'service-main.js';

/** The service's command for a spawn from Drey (and from the e2e fixtures through Drey). */
export function serviceLaunchCommand(target: LaunchTarget): LaunchCommand {
  const exec = target.execPath ?? process.execPath;
  return {
    command: exec,
    args: [target.entry, '--home', target.home, ...(target.vaultPath === null ? [] : ['--vault', target.vaultPath])],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** Starts the service detached: it outlives the Drey that started it. Its first output goes to `service-start.log`. */
export function spawnService(cmd: LaunchCommand, home: string): number | null {
  const output = openSync(path.join(home, 'service-start.log'), 'w');
  const child = spawn(cmd.command, [...cmd.args], {
    env: { ...process.env, ...cmd.env },
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  closeSync(output);
  child.unref();
  return child.pid ?? null;
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const AUTOSTART_VALUE = 'DreyService';

/**
 * The log-in command line. A `Run` entry cannot carry an environment
 * variable, so in Node mode it goes through a hidden PowerShell that sets
 * `ELECTRON_RUN_AS_NODE` first (a console may flash for an instant at
 * log-in). Electron-headless mode (Q3) would make it `"Drey.exe"
 * --drey-service`.
 */
export function autostartCommandLine(target: LaunchTarget): string {
  const cmd = serviceLaunchCommand(target);
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const envs = Object.entries(cmd.env).map(([key, value]) => `$env:${key}=${quote(value)}; `).join('');
  const call = `& ${quote(cmd.command)} ${cmd.args.map(quote).join(' ')}`;
  return `powershell.exe -NoProfile -WindowStyle Hidden -Command "${envs}${call}"`;
}

export type RegExec = (args: readonly string[]) => Promise<string>;

const realReg: RegExec = async (args) => (await promisify(execFile)('reg.exe', [...args], { windowsHide: true })).stdout;

/** Start with Windows on or off (opt-in, off by default): the per-user `Run` key. */
export async function setAutostart(on: boolean, target: LaunchTarget, reg: RegExec = realReg): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('start with the system is only built for Windows');
  }
  if (on) {
    await reg(['add', RUN_KEY, '/v', AUTOSTART_VALUE, '/t', 'REG_SZ', '/d', autostartCommandLine(target), '/f']);
  } else {
    await reg(['delete', RUN_KEY, '/v', AUTOSTART_VALUE, '/f']).catch(() => '');
  }
}

/** The registered log-in command, or null when start with Windows is off. */
export async function autostartEntry(reg: RegExec = realReg): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const out = await reg(['query', RUN_KEY, '/v', AUTOSTART_VALUE]);
    const line = out.split(/\r?\n/).find((l) => l.includes(AUTOSTART_VALUE));
    const match = line === undefined ? null : /REG_SZ\s+(.*)$/.exec(line);
    return match === null ? null : match[1]!.trim();
  } catch {
    return null;
  }
}
