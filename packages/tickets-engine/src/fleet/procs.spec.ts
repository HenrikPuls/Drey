import { describe, expect, it } from 'vitest';
import { listenerPid, scrubInheritedEnv } from './procs';

describe('listenerPid — the worker server behind its cmd shell', () => {
  const onWindows = process.platform === 'win32';

  it('reads the owning process of the listening port on Windows; null elsewhere', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: readonly string[]): Promise<string> => {
      calls.push([cmd, ...args]);
      return '777\r\n';
    };
    expect(await listenerPid(50918, exec)).toBe(onWindows ? 777 : null);
    if (onWindows) {
      expect(calls[0]!.join(' ')).toContain('Get-NetTCPConnection -LocalPort 50918 -State Listen');
    }
  });

  it('is null for no listener, a failed probe or a bad port', async () => {
    expect(await listenerPid(50918, async () => '')).toBeNull();
    expect(await listenerPid(50918, async () => Promise.reject(new Error('no such port')))).toBeNull();
    expect(await listenerPid(0, async () => '777')).toBeNull();
  });
});

describe('scrubInheritedEnv — what the runner does not hand on to workers (req-56)', () => {
  it("removes npm's config and lifecycle variables, INIT_CWD and ELECTRON_RUN_AS_NODE, and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: 'C:/bin',
      npm_config_allow_scripts: 'false',
      NPM_CONFIG_CACHE: 'x',
      npm_lifecycle_event: 'dev',
      INIT_CWD: 'E:/projects/Drey',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--max-old-space-size=4096',
    };
    expect([...scrubInheritedEnv(env)].sort()).toEqual(
      ['ELECTRON_RUN_AS_NODE', 'INIT_CWD', 'NPM_CONFIG_CACHE', 'npm_config_allow_scripts', 'npm_lifecycle_event'].sort(),
    );
    expect(env).toEqual({ PATH: 'C:/bin', NODE_OPTIONS: '--max-old-space-size=4096' });
  });
});
