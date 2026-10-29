import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MainPluginContext } from '../../../shared/plugin-api';
import plugin from './index';

/**
 * Repository discovery under a parent vault (T-0045), plugin-level over
 * REAL git in temp directories: a vault that is no repository itself
 * still surfaces the repositories below it — read-only. Every mutating
 * handler refuses a discovered repository BEFORE any repository is
 * located or git runs; the queries answer; the vault's own repository
 * path is untouched.
 */

const PARENT = 'parent-vault';
const OWNED = 'repo-vault';

const run = promisify(execFile);

type Handler = (payload: unknown) => unknown;

interface Harness {
  invoke(method: string, payload?: unknown): Promise<unknown>;
}

async function harness(vaults: Array<{ id: string; name: string; path: string; exists: boolean }>): Promise<Harness> {
  const handlers = new Map<string, Handler>();
  const ctx = {
    pluginId: 'git',
    manifest: { id: 'git', name: 'Git', apiVersion: '1.33' },
    config: { get: async () => undefined, set: async () => undefined },
    app: {
      onMainWindowCreated: () => () => undefined,
      getMainWindow: () => null,
      onWillQuit: () => () => undefined,
      appVersion: '0.0.0-test',
      userRoot: 'C:/tmp',
    },
    ipc: {
      handle: (method: string, fn: Handler) => handlers.set(method, fn),
      emit: () => undefined,
    },
    vault: {
      listVaults: async () => vaults.map((v) => ({ ...v, active: false })),
      // The one IO call a query makes on a found repository: reading the
      // working copy of a vault-relative path.
      read: async (path: string, opts: { vaultId?: string }) =>
        readFile(join(vaults.find((v) => v.id === (opts?.vaultId ?? ''))?.path ?? '.', path), 'utf8'),
      onChanged: () => () => undefined,
      managedBy: vi.fn(() => null),
      register: vi.fn(async (folderPath: string): Promise<{ id: string; name: string; path: string }> => ({
        id: 'v9',
        name: 'Registered',
        path: folderPath,
      })),
    },
    save: { onNoteSaved: () => () => undefined },
    log: () => undefined,
  } as unknown as MainPluginContext;
  await plugin.activate(ctx);
  return {
    invoke: (method: string, payload?: unknown) => {
      const handler = handlers.get(method);
      if (handler === undefined) {
        throw new Error(`no handler registered for "${method}"`);
      }
      return Promise.resolve(handler(payload));
    },
  };
}

let home: string;
let parentPath: string;
let ownedPath: string;

/** A real repository with one committed file and one uncommitted change. */
async function gitRepo(dir: string, file: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '--initial-branch=main', dir]);
  await writeFile(join(dir, file), 'first\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'first']);
  await writeFile(join(dir, file), 'second\n');
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'drey-discovered-'));
  parentPath = join(home, 'parent');
  ownedPath = join(home, 'owned');
  await mkdir(parentPath, { recursive: true });
  await gitRepo(join(parentPath, 'drey'), 'readme.md');
  await gitRepo(join(parentPath, 'drey-tickets'), 'T-0001.md');
  await gitRepo(ownedPath, 'note.md'); // the vault IS the repository root
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('git plugin: repositories found under a parent vault', () => {
  it('status surfaces the found repositories read-only, and drops the "not a repository" entry', async () => {
    const h = await harness([
      { id: PARENT, name: 'Parent', path: parentPath, exists: true },
    ]);
    const states = (await h.invoke('status', { refresh: true })) as Array<{
      vaultId: string;
      state: string;
      subPath?: string;
      discovered?: boolean;
      status?: { branch: string | null; unstaged: unknown[] };
    }>;
    expect(states.map((s) => `${s.state}:${s.subPath ?? ''}`).sort()).toEqual(['ok:drey', 'ok:drey-tickets']);
    for (const entry of states) {
      expect(entry.discovered).toBe(true);
      expect(entry.status?.branch).toBe('main');
      expect(entry.status?.unstaged).toHaveLength(1);
    }
  });

  it('a parent without repositories stays the ordinary "not a repository" vault', async () => {
    const empty = join(home, 'empty-parent');
    await mkdir(empty, { recursive: true });
    const h = await harness([{ id: 'empty', name: 'Empty', path: empty, exists: true }]);
    await expect(h.invoke('status', { refresh: true })).resolves.toEqual([
      { vaultId: 'empty', state: 'not-a-repo' },
    ]);
  });

  it('every mutation refuses a found repository, naming the vault, before locating anything', async () => {
    const h = await harness([{ id: PARENT, name: 'Parent', path: parentPath, exists: true }]);
    const target = { vaultId: PARENT, subPath: 'drey' };
    const mutations = [
      ['stage', { ...target, paths: [] }],
      ['unstage', { ...target, paths: [] }],
      ['discard', { ...target, paths: ['drey/readme.md'] }],
      ['commit', { ...target, message: 'x' }],
      ['checkout', { ...target, name: 'main' }],
      ['createBranch', { ...target, name: 'feature' }],
      ['fetch', target],
      ['pull', target],
      ['push', target],
      ['merge', { ...target, name: 'main' }],
      ['mergeAbort', target],
      ['resolve', { ...target, path: 'drey/readme.md', side: 'ours' }],
      ['stashPush', target],
      ['stashPop', { ...target, index: 0 }],
      ['stashDrop', { ...target, index: 0 }],
    ] as const;
    for (const [method, payload] of mutations) {
      await expect(h.invoke(method, payload)).rejects.toThrow(
        'This repository was found under "Parent" and is read-only here. Register it as a vault to work with it.',
      );
    }
  });

  it('the refusal needs no scan either: a made-up subPath is refused the same way', async () => {
    const h = await harness([{ id: PARENT, name: 'Parent', path: parentPath, exists: true }]);
    await expect(h.invoke('push', { vaultId: PARENT, subPath: 'no-such-repo' })).rejects.toThrow(
      'found under "Parent" and is read-only',
    );
  });

  it('queries answer for a found repository: branches, log, stash list, file history', async () => {
    const h = await harness([{ id: PARENT, name: 'Parent', path: parentPath, exists: true }]);
    await h.invoke('status', { refresh: true }); // the panel always fills the scan before querying
    await expect(h.invoke('branches', { vaultId: PARENT, subPath: 'drey' })).resolves.toEqual([
      { name: 'main', remote: false, current: true },
    ]);
    const log = (await h.invoke('log', { vaultId: PARENT, subPath: 'drey' })) as Array<{ subject: string }>;
    expect(log.map((e) => e.subject)).toEqual(['first']);
    await expect(h.invoke('stashList', { vaultId: PARENT, subPath: 'drey' })).resolves.toEqual([]);
    const fileLog = (await h.invoke('fileLog', {
      vaultId: PARENT,
      subPath: 'drey',
      path: 'drey/readme.md',
    })) as Array<{ subject: string }>;
    expect(fileLog.map((e) => e.subject)).toEqual(['first']);
  });

  it('fileAt reads the working copy of a found repository through vault-relative paths', async () => {
    const h = await harness([{ id: PARENT, name: 'Parent', path: parentPath, exists: true }]);
    const at = (await h.invoke('fileAt', { vaultId: PARENT, subPath: 'drey', path: 'drey/readme.md', rev: 'worktree' })) as {
      content: string | null;
    };
    expect(at.content).toBe('second\n');
  });

  it('an unknown subPath on a query is a clear error, never a stale repository', async () => {
    const h = await harness([{ id: PARENT, name: 'Parent', path: parentPath, exists: true }]);
    await expect(h.invoke('branches', { vaultId: PARENT, subPath: 'gone' })).rejects.toThrow(
      'No repository "gone" was found under this vault. Refresh the status.',
    );
  });

  it('the vault\'s own repository path is untouched (no subPath = the vault itself)', async () => {
    const h = await harness([{ id: OWNED, name: 'Owned', path: ownedPath, exists: true }]);
    const states = (await h.invoke('status', { refresh: true })) as Array<{
      vaultId: string;
      state: string;
      subPath?: string;
      discovered?: boolean;
    }>;
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ vaultId: OWNED, state: 'ok', subPath: '', discovered: false });
    await expect(h.invoke('branches', { vaultId: OWNED })).resolves.toEqual([
      { name: 'main', remote: false, current: true },
    ]);
  });

  it('another registered vault\'s subtree is not surfaced twice', async () => {
    const h = await harness([
      { id: PARENT, name: 'Parent', path: parentPath, exists: true },
      { id: 'tickets', name: 'Tickets', path: join(parentPath, 'drey-tickets'), exists: true },
    ]);
    const states = (await h.invoke('status', { refresh: true })) as Array<{ vaultId: string; subPath?: string }>;
    expect(states.map((s) => `${s.vaultId}:${s.subPath ?? ''}`).sort()).toEqual([
      'parent-vault:drey',
      'tickets:',
    ]);
  });

  it('registerVault routes the found repository root to ctx.vault.register', async () => {
    const h = await harness([{ id: PARENT, name: 'Parent', path: parentPath, exists: true }]);
    const added = (await h.invoke('registerVault', { path: join(parentPath, 'drey') })) as {
      id: string;
      path: string;
    };
    expect(added).toMatchObject({ id: 'v9', path: join(parentPath, 'drey') });
  });

  it('registerVault refuses without a folder', async () => {
    const h = await harness([{ id: PARENT, name: 'Parent', path: parentPath, exists: true }]);
    await expect(h.invoke('registerVault', {})).rejects.toThrow('No folder given.');
  });
});
