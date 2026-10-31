// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { runInNewConsole } from './open-terminal';

/** A spawn stand-in that records the call and answers like a detached child. */
function recordingSpawn(): { calls: unknown[][]; spawn: (cmd: string, args: string[], options: unknown) => ChildProcess } {
  const calls: unknown[][] = [];
  const fake = {
    once: vi.fn(),
    unref: vi.fn(),
  } as unknown as ChildProcess;
  const spawn = (cmd: string, args: string[], options: unknown): ChildProcess => {
    calls.push([cmd, args, options]);
    return fake;
  };
  return { calls, spawn };
}

describe('runInNewConsole (req-75 W3)', () => {
  it('hands the command line to a new cmd console as one argument, detached at the worktree', () => {
    const { calls, spawn } = recordingSpawn();
    const realPlatform = process.platform;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      runInNewConsole('E:/checkouts/T-0126', 'powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi', spawn);
    } finally {
      vi.spyOn(process, 'platform', 'get').mockRestore();
      void realPlatform;
    }
    expect(calls).toHaveLength(1);
    const [cmd, args, options] = calls[0]! as [string, string[], Record<string, unknown>];
    expect(cmd).toMatch(/cmd\.exe$/i);
    // start's window-title placeholder is the worktree's folder name; the
    // whole command line is ONE argument of `cmd /k` — never a shell string.
    expect(args).toEqual(['/c', 'start', 'T-0126', 'cmd.exe', '/k', 'powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi']);
    expect(options).toMatchObject({
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
    expect(linux.calls[0]!.slice(0, 2)).toEqual(['x-terminal-emulator', ['-e', 'sh', '-c', 'npm run dev']]);

    const mac = recordingSpawn();
    const macPlatform = vi.spyOn(process, 'platform', 'get');
    macPlatform.mockReturnValue('darwin');
    runInNewConsole('/opt/wt', 'npm run dev', mac.spawn);
    macPlatform.mockRestore();
    expect(mac.calls[0]!.slice(0, 2)).toEqual(['open', ['-a', 'Terminal', '/opt/wt']]);
  });
});
