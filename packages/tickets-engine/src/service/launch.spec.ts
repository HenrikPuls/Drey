import { describe, expect, it } from 'vitest';
import { AUTOSTART_VALUE, autostartCommandLine, autostartEntry, serviceLaunchCommand, setAutostart } from './launch';
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

  it('the log-in command sets the variable in a hidden PowerShell, quoting every path', () => {
    const line = autostartCommandLine({ ...target, vaultPath: null, home: "C:/Users/o'neil/.drey-engine" });
    expect(line).toBe(
      `powershell.exe -NoProfile -WindowStyle Hidden -Command "$env:ELECTRON_RUN_AS_NODE='1'; & 'D:/app/Drey.exe' 'D:/app/service-main.js' '--home' 'C:/Users/o''neil/.drey-engine'"`,
    );
  });

  it.runIf(process.platform === 'win32')('start with Windows writes and removes the per-user Run value', async () => {
    const calls: (readonly string[])[] = [];
    const reg = async (args: readonly string[]): Promise<string> => {
      calls.push(args);
      return `    ${AUTOSTART_VALUE}    REG_SZ    powershell.exe -x\r\n`;
    };
    await setAutostart(true, target, reg);
    await setAutostart(false, target, reg);
    expect(calls[0]!.slice(0, 4)).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_VALUE]);
    expect(calls[1]!.slice(0, 1)).toEqual(['delete']);
    expect(await autostartEntry(reg)).toBe('powershell.exe -x');
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
