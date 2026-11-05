import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { headFingerprint, remoteMovedProbe, type GitRun } from './store-git-probe';

function fakeGit(answers: Record<string, string | Error>): { run: GitRun; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (args) => {
      const key = args.join(' ');
      calls.push(key);
      const answer = answers[key];
      if (answer === undefined) {
        return Promise.reject(new Error(`unexpected: ${key}`));
      }
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

describe('headFingerprint', () => {
  it('is the HEAD commit, or null when git cannot say', async () => {
    expect(await headFingerprint('/c', fakeGit({ 'rev-parse HEAD': 'abc' }).run)()).toBe('abc');
    expect(await headFingerprint('/c', fakeGit({ 'rev-parse HEAD': new Error('not a repo') }).run)()).toBeNull();
    expect(await headFingerprint('/c', fakeGit({ 'rev-parse HEAD': '' }).run)()).toBeNull();
  });
});

describe('remoteMovedProbe', () => {
  const tracking = 'rev-parse --abbrev-ref --symbolic-full-name @{u}';

  it('is false while the remote tip is the checkout HEAD, and asks for the upstream once', async () => {
    const git = fakeGit({ [tracking]: 'origin/tickets', 'ls-remote origin refs/heads/tickets': 'abc\trefs/heads/tickets', 'rev-parse HEAD': 'abc' });
    const probe = remoteMovedProbe('/c', git.run);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
    expect(git.calls.filter((c) => c === tracking)).toHaveLength(1);
  });

  it('is true when the remote tip differs', async () => {
    const git = fakeGit({ [tracking]: 'origin/tickets', 'ls-remote origin refs/heads/tickets': 'def\trefs/heads/tickets', 'rev-parse HEAD': 'abc' });
    expect(await remoteMovedProbe('/c', git.run)()).toBe(true);
  });

  it('keeps a slash-bearing branch name whole', async () => {
    const git = fakeGit({ [tracking]: 'origin/team/tickets', 'ls-remote origin refs/heads/team/tickets': 'abc\tx', 'rev-parse HEAD': 'abc' });
    expect(await remoteMovedProbe('/c', git.run)()).toBe(false);
  });

  it('answers "moved" whenever it cannot tell (no upstream, ls-remote fails, empty answer)', async () => {
    expect(await remoteMovedProbe('/c', fakeGit({ [tracking]: new Error('no upstream') }).run)()).toBe(true);
    expect(await remoteMovedProbe('/c', fakeGit({ [tracking]: 'origin/tickets', 'ls-remote origin refs/heads/tickets': new Error('offline') }).run)()).toBe(true);
    expect(await remoteMovedProbe('/c', fakeGit({ [tracking]: 'origin/tickets', 'ls-remote origin refs/heads/tickets': '' }).run)()).toBe(true);
  });
});

describe('remoteMovedProbe against real git', () => {
  it('follows a remote that moves and a checkout that catches up', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'drey-probe-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.invalid', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    try {
      const origin = path.join(root, 'origin');
      const clone = path.join(root, 'clone');
      mkdirSync(origin);
      git(origin, 'init', '-q', '-b', 'tickets');
      git(origin, 'commit', '-q', '--allow-empty', '-m', 'one');
      git(root, 'clone', '-q', '-b', 'tickets', origin, clone);
      const probe = remoteMovedProbe(clone);
      expect(await probe()).toBe(false);
      git(origin, 'commit', '-q', '--allow-empty', '-m', 'two');
      expect(await probe()).toBe(true);
      git(clone, 'pull', '-q', '--ff-only');
      expect(await probe()).toBe(false);
      expect(await headFingerprint(clone)()).toBe(git(clone, 'rev-parse', 'HEAD').trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
