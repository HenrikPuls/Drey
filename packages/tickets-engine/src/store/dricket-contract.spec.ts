import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TicketStoreError } from '../ports/ticket-store';
import { assertDkVersion, defaultExec, DkProcess, MIN_DK_VERSION, type ExecFn } from './dk-process';
import { DricketTicketStore } from './dricket-ticket-store';

/**
 * Contract tests against the REAL `dk` and a SCRATCH store in a temp dir with
 * a temp HOME (never the owner's tickets repo or engine home). Skipped, with
 * the reason printed, when `dk` is missing or older than the minimum.
 *
 *   DREY_DK_BIN=<path to dk>        which dk to test (default: `dk` on PATH)
 *   DREY_CAPTURE_DK_FIXTURES=1      also rewrite fixtures/dk-v<version>/*.json
 *                                   from this run's raw output
 */
const bin = process.env['DREY_DK_BIN'] ?? 'dk';

function probe(): { ok: true; version: string } | { ok: false; reason: string } {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    const version = /version:\s*(\S+)/.exec(out)?.[1] ?? out.trim();
    try {
      assertDkVersion(version, bin);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, version };
  } catch {
    return { ok: false, reason: `dk was not found ("${bin}"); set DREY_DK_BIN to a dk >= ${MIN_DK_VERSION}` };
  }
}

const found = probe();
if (!found.ok) {
  console.warn(`[dricket contract] SKIPPED: ${found.reason}`);
}

const recorded: Array<{ step: string; args: readonly string[]; code: number | null; stdout: string }> = [];

describe.skipIf(!found.ok)('DricketTicketStore against a scratch dricket store', { timeout: 60_000 }, () => {
  let root = '';
  let store: DricketTicketStore;
  let step = 'setup';

  const recording: ExecFn = async (file, args, options) => {
    const result = await defaultExec(file, args, options);
    if (args.includes('--json')) {
      recorded.push({ step, args, code: result.code, stdout: result.stdout });
    }
    return result;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-dk-contract-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    const storeDir = path.join(root, 'store');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Contract Test',
      GIT_AUTHOR_EMAIL: 'contract@test.invalid',
      GIT_COMMITTER_NAME: 'Contract Test',
      GIT_COMMITTER_EMAIL: 'contract@test.invalid',
      DK_OWNER: 'owner@scratch',
      DK_DATA_DIR: path.join(root, 'data'),
    };
    const dk = (args: string[], extra: NodeJS.ProcessEnv = {}): void => {
      execFileSync(bin, args, { env: { ...env, ...extra }, windowsHide: true, stdio: 'pipe' });
    };
    dk(['init', storeDir, 't']);
    const seed = { DK_STORE: storeDir };
    dk(['add', '--unclaimed', '--kind', 'human', '-m', 'First: a title with a colon', '-d', 'The first scratch ticket.'], seed);
    dk(['add', '--unclaimed', '-l', 'a,b', '--priority', 'high', '-m', 'Second', '-d', 'The second.'], seed);
    dk(['add', '--unclaimed', '-m', 'Third', '-d', 'The third.'], seed);
    store = new DricketTicketStore(new DkProcess({ bin, store: storeDir, dataDir: path.join(root, 'data'), env, exec: recording }));
  });

  afterAll(() => {
    if (process.env['DREY_CAPTURE_DK_FIXTURES'] === '1' && found.ok) {
      const dir = path.join(__dirname, 'fixtures', `dk-${found.version}`);
      mkdirSync(dir, { recursive: true });
      const index: Record<string, { args: readonly string[]; code: number | null }> = {};
      for (const [i, r] of recorded.entries()) {
        const name = `${String(i + 1).padStart(2, '0')}-${r.step}`;
        // The scratch path is machine-specific noise; nothing else in the output is.
        writeFileSync(path.join(dir, `${name}.json`), r.stdout.replaceAll(root.replaceAll('\\', '\\\\'), '<scratch>'));
        index[name] = { args: r.args.filter((a) => !a.startsWith(root)), code: r.code };
      }
      writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('runs the slice: list -> show -> claim -> show -> second claimant -> release -> show -> list', async () => {
    step = 'ls-initial';
    const first = await store.list();
    expect(first.map((r) => r.id)).toEqual(['T-0001', 'T-0002', 'T-0003']);
    expect(first[0]).toMatchObject({ id: 'T-0001', stage: 'open', owner: null, title: 'First: a title with a colon', kind: 'human', epoch: 0, rev: 0 });
    expect(first[1]).toMatchObject({ priority: 'high', labels: ['a', 'b'] });

    step = 'show-open';
    const open = await store.show('T-0001');
    expect(open).toMatchObject({ id: 'T-0001', title: 'First: a title with a colon', stage: 'open', owner: null, epoch: 0, rev: 0, leaseUntil: null });
    expect(open.body).toContain('The first scratch ticket.');

    step = 'claim';
    const claim = await store.claim('T-0001', { actor: 'ben.slice-1', size: 'S' });
    expect(claim).toMatchObject({ id: 'T-0001', epoch: 1, takeover: false });
    expect(claim.leaseUntil).toMatch(/^\d{4}-\d\d-\d\dT/);

    step = 'show-claimed';
    const claimed = await store.show('T-0001');
    expect(claimed).toMatchObject({ stage: 'in-progress', owner: 'ben.slice-1', epoch: 1, size: 'S', kind: 'agent' });
    expect(claimed.leaseUntil).toBe(claim.leaseUntil);
    expect(claimed.rev).toBeGreaterThan(open.rev ?? 0);

    step = 'claim-taken';
    const taken = await store.claim('T-0001', { actor: 'someone.else' }).catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(TicketStoreError);
    expect(taken).toMatchObject({ kind: 'claimed', exitCode: 11 });

    step = 'extend';
    const extended = await store.extend('T-0001', { actor: 'ben.slice-1', reason: 'tests take longer' });
    expect(extended).toMatchObject({ id: 'T-0001', epoch: 1, extensions: 1 });

    step = 'release-foreign';
    await expect(store.release('T-0001', { actor: 'someone.else', message: 'x' })).rejects.toMatchObject({ kind: 'claimed', exitCode: 11 });

    step = 'release';
    const released = await store.release('T-0001', { actor: 'ben.slice-1', stage: 'review', message: 'done it' });
    expect(released).toEqual({ id: 'T-0001', stage: 'review' });

    step = 'show-released';
    const after = await store.show('T-0001');
    expect(after).toMatchObject({ stage: 'review', owner: null, epoch: 1, leaseUntil: null });
    expect(after.rev).toBeGreaterThan(claimed.rev ?? 0);
    expect(after.body).toContain('done it');

    step = 'ls-final';
    const last = await store.list();
    expect(last.find((r) => r.id === 'T-0001')).toMatchObject({ stage: 'review', owner: null, epoch: 1 });
    step = 'ls-review';
    expect((await store.list({ stage: 'review' })).map((r) => r.id)).toEqual(['T-0001']);
  });

  it('maps the failure exits to kinds', async () => {
    step = 'claim-missing';
    await expect(store.claim('T-0099', { actor: 'ben.slice-1' })).rejects.toMatchObject({ kind: 'not-found', exitCode: 10 });
    step = 'claim-second';
    await store.claim('T-0002', { actor: 'ben.slice-1' });
    step = 'release-invalid';
    await expect(store.release('T-0002', { actor: 'ben.slice-1', stage: 'done' })).rejects.toMatchObject({ kind: 'invalid', exitCode: 14 });
    step = 'release-second';
    await store.release('T-0002', { actor: 'ben.slice-1', stage: 'review' });
  });

  it('lists an empty stage as an empty list (dk answers null)', async () => {
    step = 'ls-empty-stage';
    expect(await store.list({ stage: 'cancelled' })).toEqual([]);
  });

  it('reports comments as unsupported instead of working around R-08', async () => {
    await expect(store.comments()).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('answers with a typed error when no store is configured', async () => {
    const lost = new DricketTicketStore(new DkProcess({ bin, store: path.join(root, 'nowhere'), env: { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') } }));
    await expect(lost.list()).rejects.toBeInstanceOf(TicketStoreError);
  });
});
