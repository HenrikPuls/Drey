import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertDkVersion, DkProcess, MIN_DK_VERSION } from '../store/dk-process';
import { DricketTicketStore } from '../store/dricket-ticket-store';
import { RunLease, withStage } from './run-lease';

/**
 * E14-5 against a REAL `dk` and a scratch store (temp dir, temp HOME): the claim, the lease
 * extension, the comment-then-release door, and a second owner refused with exit 11. The
 * takeover by an expired lease (exit 13 for the old owner) is dk's own test; the 20 minute
 * grace cannot be waited for here, the fence is covered against the scripted store.
 * Skipped when `dk` is missing or too old.
 */
const bin = process.env['DREY_DK_BIN'] ?? 'dk';

function probe(): { ok: true } | { ok: false; reason: string } {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    assertDkVersion(/version:\s*(\S+)/.exec(out)?.[1] ?? out.trim(), bin);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : `dk was not found ("${bin}"); set DREY_DK_BIN to a dk >= ${MIN_DK_VERSION}` };
  }
}
const found = probe();
if (!found.ok) {
  console.warn(`[run lease] SKIPPED: ${found.reason}`);
}

describe.skipIf(!found.ok)('RunLease over a real dk store', { timeout: 120_000 }, () => {
  let root = '';
  let storeDir = '';
  let env: NodeJS.ProcessEnv;
  let store: DricketTicketStore;

  const dk = (args: string[], owner = 'owner@scratch'): string =>
    execFileSync(bin, args, { env: { ...env, DK_OWNER: owner }, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-dk-lease-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    storeDir = path.join(root, 'store');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Lease Test',
      GIT_AUTHOR_EMAIL: 'lease@test.invalid',
      GIT_COMMITTER_NAME: 'Lease Test',
      GIT_COMMITTER_EMAIL: 'lease@test.invalid',
      DK_DATA_DIR: path.join(root, 'data'),
    };
    dk(['init', storeDir, 't']);
    execFileSync('git', ['checkout', '-q', 'tickets'], { cwd: storeDir, env, windowsHide: true, stdio: 'pipe' });
    env = { ...env, DK_STORE: storeDir };
    dk(['add', '--unclaimed', '-m', 'First']);
    store = new DricketTicketStore(new DkProcess({ bin, store: storeDir, dataDir: path.join(root, 'data'), env, readConcurrency: 1 }));
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('claims, extends, comments and releases through dk; a second owner is refused', async () => {
    const log = vi.fn();
    const lease = new RunLease({
      store,
      ticketId: 'T-0001',
      actor: 'agent-r-1@scratch',
      runId: 'R-1',
      size: 'S',
      log,
      onLost: () => undefined,
    });
    const claim = await lease.claim();
    expect(claim.epoch).toBe(1);
    expect(lease.preStage).not.toBeNull();
    const held = await store.show('T-0001');
    expect(held.owner).toBe('agent-r-1@scratch');

    await expect(
      store.claim('T-0001', { actor: 'agent-r-2@scratch', size: 'S', kind: 'agent' }),
    ).rejects.toMatchObject({ kind: 'claimed' });

    const extended = await store.extend('T-0001', { actor: 'agent-r-1@scratch', reason: 'run R-1 is still working' });
    expect(extended.epoch).toBe(1);

    const result = await lease.release([lease.preStage, 'review'], 'run R-1 done - gate green');
    expect(result.ok).toBe(true);
    lease.stopKeepAlive();
    const after = await store.show('T-0001');
    expect(after.owner).toBeNull();
    expect(after.epoch).toBe(1); // the epoch is never reset by a release
    // The note is a comment file, the ticket itself carries no release message.
    const comments = readdirSync(path.join(storeDir, 'tickets', 't', '0000', 't-1', 'comments'));
    expect(comments).toHaveLength(1);
  });
});

/**
 * E14-5b against a real `dk` with Drey's stage vocabulary (the store's configuration lives on
 * `main`, as in the owner's store): R-31 (the same-stage release is a write-back), the in-claim
 * write, and the re-claim after a wait.
 */
describe.skipIf(!found.ok)('RunLease over a real dk store with Drey stages (E14-5b)', { timeout: 120_000 }, () => {
  let root = '';
  let storeDir = '';
  let env: NodeJS.ProcessEnv;
  let store: DricketTicketStore;

  const dk = (args: string[], owner = 'owner@scratch'): string =>
    execFileSync(bin, args, { env: { ...env, DK_OWNER: owner }, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: storeDir, env, windowsHide: true, stdio: 'pipe' });
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-dk-r31-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    storeDir = path.join(root, 'store');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Lease Test',
      GIT_AUTHOR_EMAIL: 'lease@test.invalid',
      GIT_COMMITTER_NAME: 'Lease Test',
      GIT_COMMITTER_EMAIL: 'lease@test.invalid',
      DK_DATA_DIR: path.join(root, 'data'),
    };
    dk(['init', storeDir, 't']);
    git(['checkout', '-q', 'main']);
    const tomlPath = path.join(storeDir, 'dricket.toml');
    const toml = readFileSync(tomlPath, 'utf8').replace(/\[transitions\.agent\][\s\S]*?(?=\n\[|$)/, '');
    writeFileSync(tomlPath, `${toml}\n[stages]\nvalues = ["inbox", "prioritized", "build", "commit", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["build", "commit"]\ncancelled = "cancelled"\n`);
    git(['commit', '-q', '-am', 'stages']);
    git(['checkout', '-q', 'tickets']);
    env = { ...env, DK_STORE: storeDir };
    dk(['add', '--unclaimed', '-m', 'First']);
    store = new DricketTicketStore(new DkProcess({ bin, store: storeDir, dataDir: path.join(root, 'data'), env: { ...env, DK_OWNER: 'agent-r-1@scratch' }, readConcurrency: 1 }));
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const leaseFor = (runId: string, actor: string): RunLease =>
    new RunLease({ store, ticketId: 'T-0001', actor, runId, size: 'S', log: () => undefined, onLost: () => undefined });

  it('R-31: a failed run that sat in the claim stage ends where it sat; patchInClaim keeps the claim', async () => {
    // Put the ticket into `build` unclaimed first: claim moves inbox -> build, a release to prioritized, then the write-back.
    dk(['claim', 't-1', '--size', 'S'], 'agent-r-0@scratch');
    dk(['release', 't-1', '--stage', 'prioritized'], 'agent-r-0@scratch');
    const seed = await store.show('T-0001');
    await store.put('T-0001', withStage(seed.text, 'build')!, { expectedRev: seed.rev!, actor: 'agent-r-0@scratch' });
    expect((await store.show('T-0001')).stage).toBe('build');

    const lease = leaseFor('R-1', 'agent-r-1@scratch');
    await lease.claim();
    expect(lease.preStage).toBe('build');

    // The in-claim write: the claim (owner, epoch) is untouched, the chapter is in.
    const before = await store.show('T-0001');
    expect(await lease.patchInClaim((text) => `${text.trimEnd()}\n\n## Verlauf\n\n- a line\n`)).toBe(true);
    const during = await store.show('T-0001');
    expect(during.owner).toBe('agent-r-1@scratch');
    expect(during.epoch).toBe(before.epoch);
    expect(during.text).toContain('- a line');

    const result = await lease.release(['build', 'prioritized'], 'run R-1 failed', { restoreTo: lease.preStage });
    expect(result).toEqual({ ok: true, stage: 'build' });
    const after = await store.show('T-0001');
    expect(after.stage).toBe('build'); // where it sat, not a column left
    expect(after.owner).toBeNull();
    expect(after.text).toContain('- a line'); // the chapter survived both writes
  });

  it('Q-03: release for a wait, re-claim on the answer: a new epoch, the same owner', async () => {
    const lease = leaseFor('R-2', 'agent-r-2@scratch');
    const first = await lease.claim();
    const released = await lease.release([lease.preStage, 'prioritized'], 'needs-decision: [k] which?', { restoreTo: lease.preStage });
    expect(released.ok).toBe(true);
    expect((await store.show('T-0001')).owner).toBeNull();
    const second = await lease.reclaim();
    expect(second.epoch).toBe((first.epoch ?? 0) + 1);
    expect((await store.show('T-0001')).owner).toBe('agent-r-2@scratch');
    await lease.release([lease.preStage, 'prioritized'], null, { restoreTo: lease.preStage });
    lease.stopKeepAlive();
  });
});
