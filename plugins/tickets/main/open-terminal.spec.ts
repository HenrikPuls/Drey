// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { runInNewConsole, type ConsoleSpawnFn } from './open-terminal';

/** A spawn stand-in that records the call and answers like a detached child. */
function recordingSpawn(): { calls: { cmd: string; args: readonly string[]; options: unknown }[]; spawn: ConsoleSpawnFn } {
  const calls: { cmd: string; args: readonly string[]; options: unknown }[] = [];
  const spawn: ConsoleSpawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { once: vi.fn(), unref: vi.fn() };
  };
  return { calls, spawn };
}

describe('runInNewConsole (req-75 W3)', () => {
  it('hands the command line to a new cmd console as one argument, detached at the worktree', () => {
    const { calls, spawn } = recordingSpawn();
    const platform = vi.spyOn(process, 'platform', 'get');
    platform.mockReturnValue('win32');
    try {
      runInNewConsole(
        'E:/checkouts/T-0126',
        'powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi',
        spawn,
      );
    } finally {
      platform.mockRestore();
    }
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd).toMatch(/cmd\.exe$/i);
    // start's window-title placeholder is the worktree's folder name; the
    // whole command line is ONE argument of `cmd /k` — never a shell string.
    expect(call.args).toEqual([
      '/c',
      'start',
      'T-0126',
      'cmd.exe',
      '/k',
      'powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi',
    ]);
    expect(call.options).toMatchObject({
      cwd: 'E:/checkouts/T-0126',
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
  });

  it('uses x-terminal-emulator -e sh -c off Windows and open -a Terminal on macOS', () => {
    const linux = recordingSpawn();
    const platform = vi.spyOn(process, 'platform', 'get');
    platform.mockReturnValue('linux');
    runInNewConsole('/opt/wt', 'npm run dev', linux.spawn);
    platform.mockRestore();
    expect(linux.calls[0]!.cmd).toBe('x-terminal-emulator');
    expect(linux.calls[0]!.args).toEqual(['-e', 'sh', '-c', 'npm run dev']);

    const mac = recordingSpawn();
    const macPlatform = vi.spyOn(process, 'platform', 'get');
    macPlatform.mockReturnValue('darwin');
    runInNewConsole('/opt/wt', 'npm run dev', mac.spawn);
    macPlatform.mockRestore();
    expect(mac.calls[0]!.cmd).toBe('open');
    expect(mac.calls[0]!.args).toEqual(['-a', 'Terminal', '/opt/wt']);
  });
});
