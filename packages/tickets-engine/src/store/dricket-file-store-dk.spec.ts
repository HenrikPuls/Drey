import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertDkVersion, DkProcess, MIN_DK_VERSION } from './dk-process';
import { DricketFileStore } from './dricket-file-store';
import { DricketTicketStore } from './dricket-ticket-store';
import { FileStoreReader } from './file-store-reader';
import { StoreBoardSource } from './store-board-source';
import type { StoreSettings } from './store-settings';

/**
 * The E14-4 write path against a REAL `dk` and a SCRATCH store: `put --claim
 * --if-version`, the conflict (exit 12) coming back re-read, a foreign claim
 * (exit 11), the checkout current after a write, and the own-write
 * announcement. Temp dir + temp HOME. Skipped when `dk` is missing or too old.
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
  console.warn(`[dricket file store] SKIPPED: ${found.reason}`);
}

describe.skipIf(!found.ok)('DricketFileStore over a real dk store', { timeout: 120_000 }, () => {
  let root = '';
  let storeDir = '';
  let env: NodeJS.ProcessEnv;
  let files: DricketFileStore;

  const dk = (args: string[], owner = 'owner@scratch'): string =>
    execFileSync(bin, args, { env: { ...env, DK_OWNER: owner }, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-dk-put-'));
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
      GIT_AUTHOR_NAME: 'Put Test',
      GIT_AUTHOR_EMAIL: 'put@test.invalid',
      GIT_COMMITTER_NAME: 'Put Test',
      GIT_COMMITTER_EMAIL: 'put@test.invalid',
      DK_DATA_DIR: path.join(root, 'data'),
    };
    dk(['init', storeDir, 't']);
    execFileSync('git', ['checkout', '-q', 'tickets'], { cwd: storeDir, env, windowsHide: true, stdio: 'pipe' });
    env = { ...env, DK_STORE: storeDir };
    dk(['add', '--unclaimed', '-m', 'First']);
    dk(['add', '--unclaimed', '-m', 'Second']);
    dk(['claim', '--size', 'S', 't-2'], 'ben.run-1');
    files = new DricketFileStore(
      new FileStoreReader({ root: storeDir }),
      new DricketTicketStore(new DkProcess({ bin, store: storeDir, dataDir: path.join(root, 'data'), env, readConcurrency: 1 })),
      storeDir,
    );
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('writes a whole ticket in one commit and shows it in the checkout at once', async () => {
    const before = await files.show('T-0001');
    expect(before.rev).toBe(0);
    const edited = before.text.replace('title: First', 'title: First, renamed').replace('priority: normal', 'priority: high');
    const outcome = await files.write('T-0001', edited, { expectedRev: before.rev!, actor: 'henrik' });
    expect(outcome).toMatchObject({ ok: true, result: { id: 'T-0001', rev: 1, changedFields: ['title', 'priority'] } });
    const after = await files.show('T-0001');
    expect(after).toMatchObject({ title: 'First, renamed', priority: 'high', rev: 1, owner: null, epoch: before.epoch });
  });

  it('answers exit 12 with the ticket as it is now instead of overwriting it', async () => {
    const stale = await files.show('T-0001');
    dk(['put', 't-1', '-F', writeTemp(stale.text.replace('title: First, renamed', 'title: Someone else was first')), '--claim', '--if-version', String(stale.rev)]);
    const outcome = await files.write('T-0001', stale.text.replace('title: First, renamed', 'title: Mine'), { expectedRev: stale.rev! });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.conflict.current).toMatchObject({ title: 'Someone else was first', rev: stale.rev! + 1 });
    }
  });

  it('refuses to write into a ticket someone else holds (exit 11)', async () => {
    const held = await files.show('T-0002');
    expect(held.owner).toBe('ben.run-1');
    await expect(files.write('T-0002', held.text.replace('title: Second', 'title: Hijack'), { expectedRev: held.rev! })).rejects.toMatchObject({ kind: 'claimed' });
  });

  it('announces an own write through the board source', async () => {
    const onChange = vi.fn();
    const settings: StoreSettings = { backend: 'dricket', shadow: false, dkPath: bin === 'dk' ? '' : bin, dkStore: storeDir, dkDataDir: path.join(root, 'data'), dkCheckout: '', dkSyncSeconds: 30 };
    const source = new StoreBoardSource(path.join(root, 'report'), () => undefined, 0, undefined, {
      onChange,
      watch: () => ({ close: () => undefined }),
      dkFactory: () => new DricketTicketStore(new DkProcess({ bin, store: storeDir, dataDir: settings.dkDataDir, env, readConcurrency: 1 })),
    });
    try {
      const t = (await source.records(settings)).find((r) => r.id === 'T-0001')!;
      const outcome = await source.write(settings, 'T-0001', t.text.replace('title: Someone else was first', 'title: Third'), { expectedRev: t.rev! });
      expect(outcome.ok).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect((await source.records(settings)).find((r) => r.id === 'T-0001')!.title).toBe('Third');
    } finally {
      source.dispose();
    }
  });

  function writeTemp(text: string): string {
    const file = path.join(root, `edit-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(file, text);
    return file;
  }
});
