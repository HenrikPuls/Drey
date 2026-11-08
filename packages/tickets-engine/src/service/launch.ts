/**
 * How Drey Service is started — the one seam (req-164).
 *
 * **Process mode (the owner's Q3, decided here, 2026-11-08):** plain Node
 * under Electron's binary (`ELECTRON_RUN_AS_NODE`), not a headless Electron
 * (`Drey.exe --drey-service`). The owner's ruling made the service
 * optional, so neither case needs Electron: "enabled → starts with Windows"
 * is a hidden `wscript` launcher that sets the variable, "disabled → dies
 * with Drey" is the service's own with-Drey mode — and Node mode costs no
 * Chromium (the ~50–80 MB the owner watches). The tray of req-165 is the
 * one thing that would need Electron; it can start as a separate small
 * window process on demand. Both the spawn from Drey and the log-in entry
 * are built here and only here.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync, promises as fsp } from 'node:fs';
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
export const AUTOSTART_LAUNCHER = 'start-service.vbs';

/** The VBScript string literal of a value: doubled quotes inside quotes. */
const vbs = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/**
 * The log-in launcher, written into the service home. A `Run` entry cannot
 * carry an environment variable, so `wscript` sets it for the process and
 * starts the service with a hidden window (style 0) — no console at log-in.
 */
export function autostartLauncherScript(target: LaunchTarget): string {
  const cmd = serviceLaunchCommand(target);
  // Every argument quoted inside the command string (paths have spaces).
  const line = [cmd.command, ...cmd.args].map((arg) => vbs(`"${arg}"`)).join(' & " " & ');
  const env = Object.entries(cmd.env)
    .map(([key, value]) => `shell.Environment("Process")(${vbs(key)}) = ${vbs(value)}`)
    .join('\r\n');
  return ['Set shell = CreateObject("WScript.Shell")', env, `shell.Run ${line}, 0, False`, ''].join('\r\n');
}

/** The `Run` value: wscript over this home's launcher. */
export function autostartCommandLine(home: string): string {
  return `wscript.exe "${path.join(home, AUTOSTART_LAUNCHER)}"`;
}

export type RegExec = (args: readonly string[]) => Promise<string>;

const realReg: RegExec = async (args) => (await promisify(execFile)('reg.exe', [...args], { windowsHide: true })).stdout;

/**
 * Start with Windows on or off (opt-in, off by default; on only while the
 * service is enabled): the per-user `Run` value plus the launcher. Off removes
 * the value only when it is this home's — a test home never removes the
 * owner's entry (HKCU is not isolated by `USERPROFILE`).
 */
export async function setAutostart(on: boolean, target: LaunchTarget, reg: RegExec = realReg): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('start with the system is only built for Windows');
  }
  const launcher = path.join(target.home, AUTOSTART_LAUNCHER);
  if (on) {
    await fsp.writeFile(launcher, autostartLauncherScript({ ...target, vaultPath: null }), 'utf8');
    await reg(['add', RUN_KEY, '/v', AUTOSTART_VALUE, '/t', 'REG_SZ', '/d', autostartCommandLine(target.home), '/f']);
    return;
  }
  const entry = await autostartEntry(reg);
  if (entry !== null && entry.toLowerCase().includes(launcher.toLowerCase())) {
    await reg(['delete', RUN_KEY, '/v', AUTOSTART_VALUE, '/f']).catch(() => '');
  }
  await fsp.rm(launcher, { force: true });
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
