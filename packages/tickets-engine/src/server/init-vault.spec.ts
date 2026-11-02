import { describe, expect, it } from 'vitest';
import { initVault, type InitIo } from './init-vault';
import { PIPELINE_PATH } from '../core/init-scaffold';

/** An in-memory vault: the recorded dirs/files and the git calls. */
function memoryIo(existing: string[] = []): {
  io: InitIo;
  dirs: Set<string>;
  files: Map<string, string>;
  gitCalls: readonly string[][];
  failGitOn: string | null;
} {
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  const gitCalls: string[][] = [];
  const state = { failGitOn: null as string | null };
  const io: InitIo = {
    mkdir: async (dir) => {
      dirs.add(dir);
    },
    exists: async (file) => existing.includes(file),
    writeFile: async (file, text) => {
      files.set(file, text);
    },
    git: {
      run: async (_cwd, args) => {
        if (state.failGitOn !== null && args[0] === state.failGitOn) {
          throw new Error(`git ${args[0]} failed (mock)`);
        }
        gitCalls.push([...args]);
        return '';
      },
    },
    log: () => undefined,
  };
  return { io, dirs, files, gitCalls, failGitOn: state.failGitOn };
}

const PROMPTS = new Map([
  ['build-default', '# Build\n'],
  ['scout-default', '# Scout\n'],
]);

describe('initVault (M112)', () => {
  it('writes the scaffold, the prompts and the phase directories, then git init + one commit', async () => {
    const mem = memoryIo();
    const result = await initVault('E:/notes', PROMPTS, mem.io);

    expect(result).toEqual({ ok: true, root: 'E:/notes', warning: null });
    expect(mem.files.get(`E:/notes/${PIPELINE_PATH}`)).toContain('priorities: [urgent, high, normal, low]');
    expect(mem.files.get('E:/notes/tickets/_meta/repos.md')).toContain('repos: {}');
    expect(mem.files.get('E:/notes/tickets/_meta/prompts/build-default.md')).toBe('# Build\n');
    expect(mem.files.get('E:/notes/tickets/_meta/prompts/scout-default.md')).toBe('# Scout\n');
    for (const dir of ['tickets/10-inbox', 'tickets/20-prioritized', 'tickets/30-build', 'tickets/40-commit', 'tickets/50-done']) {
      expect(mem.dirs.has(`E:/notes/${dir}`)).toBe(true);
    }
    expect(mem.gitCalls.map((args) => args[0])).toEqual(['init', 'add', 'commit']);
    expect(mem.gitCalls[1]).toContain('tickets/_meta/pipeline.md');
    expect(mem.gitCalls[2]).toContain('tickets: initialize board');
  });

  it('refuses a directory that is already a tickets repository — and writes nothing', async () => {
    const mem = memoryIo(['E:/notes/tickets/_meta/pipeline.md']);
    const result = await initVault('E:/notes', PROMPTS, mem.io);

    expect(result).toEqual({
      ok: false,
      error: 'E:/notes is already a tickets repository — tickets/_meta/pipeline.md exists',
    });
    expect(mem.files.size).toBe(0);
    expect(mem.gitCalls).toEqual([]);
  });

  it('a failing git degrades to a warning — the scaffold stands, the vault stays unversioned', async () => {
    const mem = memoryIo();
    mem.io = {
      ...mem.io,
      git: {
        run: async (_cwd, args) => {
          if (args[0] === 'commit') {
            throw new Error('fatal: unable to auto-detect email');
          }
          return '';
        },
      },
    };
    const result = await initVault('E:/notes', new Map(), mem.io);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.warning).toBe('git skipped: fatal: unable to auto-detect email');
    expect(mem.files.get(`E:/notes/${PIPELINE_PATH}`)).toContain('priorities:');
    expect(mem.dirs.has('E:/notes/tickets/10-inbox')).toBe(true);
  });
});
