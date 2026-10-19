import { describe, expect, it } from 'vitest';
import { scrubInheritedEnv } from './procs';

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
