import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOSTART_LAUNCHER,
  AUTOSTART_VALUE,
  autostartCommandLine,
  autostartEntry,
  autostartLauncherScript,
  serviceLaunchCommand,
  setAutostart,
} from './launch';
import { formatStatus, parseServiceArgs } from './service-main';
import type { ServiceLock } from './service-lock';

/**
 * The one launch seam (req-164; the process mode is the owner's Q3) and
 * the command line the owner types in a terminal.
 */
describe('the launch seam', () => {
  const target = { entry: 'D:/app/service-main.js', home: 'C:/Users/me/.drey-engine', vaultPath: 'E:/notes', execPath: 'D:/app/Drey.exe' };

  it("Node mode: Electron's binary, the entry, the home and the vault, ELECTRON_RUN_AS_NODE set", () => {
    expect(serviceLaunchCommand(target)).toEqual({
      command: 'D:/app/Drey.exe',
      args: ['D:/app/service-main.js', '--home', 'C:/Users/me/.drey-engine', '--vault', 'E:/notes'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('the log-in start names no vault: the service reads the last one from its config', () => {
    expect(serviceLaunchCommand({ ...target, vaultPath: null }).args).not.toContain('--vault');
  });

  it('the log-in launcher sets the variable and runs the service hidden, every path quoted, no vault', () => {
    const script = autostartLauncherScript({ ...target, vaultPath: null, execPath: 'C:/Program Files/Drey/Drey.exe' });
    expect(script).toContain('shell.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"');
    expect(script).toContain('shell.Run """C:/Program Files/Drey/Drey.exe""" & " " & """D:/app/service-main.js"""');
    expect(script).toContain(', 0, False');
    expect(script).not.toContain('--vault');
  });

  it("the Run value is wscript over this home's launcher", () => {
    expect(autostartCommandLine('C:/Users/me/.drey-engine')).toBe(`wscript.exe "${path.join('C:/Users/me/.drey-engine', AUTOSTART_LAUNCHER)}"`);
  });

  it.runIf(process.platform === 'win32')("start with Windows writes the value and the launcher; off removes only this home's value", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-autostart-'));
    try {
      const calls: (readonly string[])[] = [];
      let registered = `wscript.exe "${path.join(home, AUTOSTART_LAUNCHER)}"`;
      const reg = async (args: readonly string[]): Promise<string> => {
        calls.push(args);
        return `    ${AUTOSTART_VALUE}    REG_SZ    ${registered}\r\n`;
      };
      const mine = { ...target, home };
      await setAutostart(true, mine, reg);
      expect(calls[0]!.slice(0, 4)).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_VALUE]);
      await expect(fsp.access(path.join(home, AUTOSTART_LAUNCHER))).resolves.toBeUndefined();
      expect(await autostartEntry(reg)).toBe(registered);

      calls.length = 0;
      await setAutostart(false, mine, reg);
      expect(calls.map((c) => c[0])).toEqual(['query', 'delete']);
      await expect(fsp.access(path.join(home, AUTOSTART_LAUNCHER))).rejects.toThrow();

      // Another home's entry (the owner's real one, seen from a test home) is left alone.
      registered = 'wscript.exe "C:\\Users\\owner\\.drey-engine\\start-service.vbs"';
      calls.length = 0;
      await setAutostart(false, mine, reg);
      expect(calls.map((c) => c[0])).toEqual(['query']);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});

describe('the service command line', () => {
  it('runs by default, with the home under the user profile', () => {
    expect(parseServiceArgs(['--vault', 'E:/notes'], 'C:/h')).toMatchObject({ command: 'run', home: expect.stringMatching(/h$/) as unknown as string });
  });

  it('--version, --status, --stop and --autostart', () => {
    expect(parseServiceArgs(['--version']).command).toBe('version');
    expect(parseServiceArgs(['--status']).command).toBe('status');
    expect(parseServiceArgs(['--stop']).command).toBe('stop');
    expect(parseServiceArgs(['--autostart', 'on'])).toMatchObject({ command: 'autostart', autostart: 'on' });
    expect(parseServiceArgs(['--autostart=off'])).toMatchObject({ command: 'autostart', autostart: 'off' });
    expect(parseServiceArgs(['--autostart'])).toMatchObject({ command: 'autostart', autostart: 'status' });
  });

  it('--status prints one line per component and what holds the service', () => {
    const lock: ServiceLock = {
      version: 1,
      pid: 9,
      build: 'b',
      startedAt: 's',
      home: 'H',
      vaultPath: 'V',
      port: 1,
      token: 't',
      components: {
        engine: { state: 'running', detail: 'V' },
        runner: { state: 'sleeping', detail: 'wakes on demand' },
        gateway: { state: 'stopped', detail: 'remote access is off' },
        mcp: { state: 'external', detail: 'served by Drey (until req-167)' },
      },
    };
    const text = formatStatus(lock, { sleep: { sleep: false, reason: 'drey' }, dreyClients: 1 });
    expect(text).toContain('Drey Service — running (pid 9');
    expect(text).toContain('held by  drey · 1 Drey client(s)');
    expect(text).toMatch(/runner\s+sleeping\s+wakes on demand/);
    expect(text).toMatch(/mcp\s+external\s+served by Drey \(until req-167\)/);
  });
});
