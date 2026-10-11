import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitError, GitRunner } from './git-runner';

/** These specs run the real `git`; without one installed they are skipped. */
const hasGit = spawnSync('git', ['--version']).status === 0;

const IDENTITY = ['-c', 'user.name=Spec', '-c', 'user.email=spec@example.test'];

async function failure(promise: Promise<unknown>): Promise<GitError> {
  const err: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(GitError);
  return err as GitError;
}

describe.skipIf(!hasGit)('GitRunner', () => {
  let repo = '';
  let runner: GitRunner;

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-git-'));
    runner = new GitRunner(() => 'git');
    await runner.run(repo, ['init', '--quiet']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('resolves with what git printed', async () => {
    await expect(runner.run(repo, ['rev-parse', '--is-inside-work-tree'])).resolves.toBe('true\n');
  });

  it('hands text to stdin', async () => {
    const hash = await runner.run(repo, ['hash-object', '--stdin'], { input: 'hello\n' });
    expect(hash.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('rejects with git\'s own message, without the prefix', async () => {
    const err = await failure(runner.run(repo, ['rev-parse', '--verify', 'no-such-branch']));
    expect(err.kind).toBe('failed');
    expect(err.message).not.toMatch(/^(fatal|error): /);
    expect(err.message).not.toBe('');
  });

  it('says so when the executable is missing', async () => {
    const missing = new GitRunner(() => 'definitely-not-an-installed-git');
    const err = await failure(missing.run(repo, ['status']));
    expect(err.kind).toBe('not-found');
    expect(err.message).toContain('definitely-not-an-installed-git');
  });

  it('takes a path as a path, never as a pattern', async () => {
    fs.writeFileSync(path.join(repo, 'a.md'), 'a');
    fs.writeFileSync(path.join(repo, 'b.md'), 'b');
    await runner.run(repo, ['add', '--', 'a.md', 'b.md']);

    await expect(runner.run(repo, ['ls-files', '--', '*.md'])).resolves.toBe('');
    await expect(runner.run(repo, ['ls-files', '--', 'a.md'])).resolves.toBe('a.md\n');
  });

  it('prints file names as they are on disk', async () => {
    fs.writeFileSync(path.join(repo, 'Übersicht 1.md'), 'x');
    const status = await runner.run(repo, ['status', '--porcelain=v2', '-z'], { readOnly: true });
    expect(status).toContain('? Übersicht 1.md\0');
  });

  it('runs the commands of one repository one after the other', async () => {
    fs.writeFileSync(path.join(repo, 'note.md'), 'text');

    // Started together: without the queue the commit would find nothing staged.
    const results = await Promise.all([
      runner.run(repo, ['add', '--', 'note.md']),
      runner.run(repo, [...IDENTITY, 'commit', '--quiet', '-m', 'first']),
      runner.run(repo, ['log', '--format=%s']),
    ]);

    expect(results[2]).toBe('first\n');
  });

  it('carries on with the queue after a command failed', async () => {
    const failed = runner.run(repo, ['rev-parse', '--verify', 'no-such-branch']);
    const next = runner.run(repo, ['rev-parse', '--is-inside-work-tree']);

    expect((await failure(failed)).kind).toBe('failed');
    await expect(next).resolves.toBe('true\n');
  });

  it('does not start a command that was cancelled beforehand', async () => {
    const controller = new AbortController();
    controller.abort();

    const err = await failure(runner.run(repo, ['init', 'never-created'], { signal: controller.signal }));

    expect(err.kind).toBe('cancelled');
    expect(fs.existsSync(path.join(repo, 'never-created'))).toBe(false);
  });

  it('stops a running command when cancelled, and frees the queue', async () => {
    const controller = new AbortController();
    // Waits for stdin that never comes -- the stand-in for a slow fetch.
    const hanging = runner.run(repo, ['hash-object', '--stdin'], { signal: controller.signal });
    const next = runner.run(repo, ['rev-parse', '--is-inside-work-tree']);
    setTimeout(() => controller.abort(), 150);

    expect((await failure(hanging)).kind).toBe('cancelled');
    await expect(next).resolves.toBe('true\n');
  }, 20_000);
});
