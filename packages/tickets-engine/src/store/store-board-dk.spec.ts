import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDkVersion, DkProcess, MIN_DK_VERSION } from './dk-process';
import { DricketTicketStore } from './dricket-ticket-store';
import { StoreBoardSource } from './store-board-source';
import type { StoreSettings } from './store-settings';

/**
 * The board built from a REAL `dk` and a SCRATCH store with a configured
 * `[stages]` vocabulary (E14-2): extension fields, `depends`, `parent`, claims
 * and the shadow report, end to end. Temp dir + temp HOME, never the owner's
 * repos. Skipped (with the reason printed) when `dk` is missing or too old.
 *
 *   DREY_DK_BIN=<path to dk>   which dk to test (default: `dk` on PATH)
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
  console.warn(`[store board dk] SKIPPED: ${found.reason}`);
}

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: build, title: Build, claim: true, handover: agent build-default }
  - { id: commit, title: Commit, claim: true, handover: manual }
  - { id: done, title: Done, handover: none }
priorities: [urgent, high, normal, low]
---
`;
const BASE = { vaultId: 'v', vaultName: 'v', activeVaultName: 'v', isGitRepo: true, defaultWorker: 'opencode', pipelineText: PIPELINE, reposText: null };

describe.skipIf(!found.ok)('the board over a real dk store', { timeout: 120_000 }, () => {
  let root = '';
  let settings: StoreSettings;
  let env: NodeJS.ProcessEnv;

  const dk = (args: string[], owner = 'owner@scratch'): void => {
    execFileSync(bin, args, { env: { ...env, DK_OWNER: owner }, windowsHide: true, stdio: 'pipe' });
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-dk-board-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    const storeDir = path.join(root, 'store');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Board Test',
      GIT_AUTHOR_EMAIL: 'board@test.invalid',
      GIT_COMMITTER_NAME: 'Board Test',
      GIT_COMMITTER_EMAIL: 'board@test.invalid',
      DK_DATA_DIR: path.join(root, 'data'),
    };
    dk(['init', storeDir, 't']);
    // The store's configuration lives on `main` and is edited by hand (a PR in real life):
    // Drey's pipeline as the stage vocabulary, Drey's priority words.
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: storeDir, env, windowsHide: true, stdio: 'pipe' });
    };
    git(['checkout', '-q', 'main']);
    const tomlPath = path.join(storeDir, 'dricket.toml');
    const toml = readFileSync(tomlPath, 'utf8')
      .replace(/\[transitions\.agent\][\s\S]*?(?=\n\[|$)/, '')
      .replace('values = ["critical", "high", "normal", "low"]', 'values = ["urgent", "high", "normal", "low"]');
    writeFileSync(
      tomlPath,
      `${toml}\n[stages]\nvalues = ["inbox", "prioritized", "build", "commit", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["build", "commit"]\ncancelled = "cancelled"\n`,
    );
    git(['commit', '-q', '-am', 'stages and priorities']);
    git(['checkout', '-q', 'tickets']);

    env = { ...env, DK_STORE: storeDir };
    dk(['add', '--unclaimed', '-m', 'First: with a colon', '--priority', 'urgent', '--set', 'x-rank=10', '--set', 'x-persona=ben', '--set', 'x-chain=skip review; insert design after build', '--set', 'x-entered-inbox=2026-11-01T08:00:00Z']);
    dk(['add', '--unclaimed', '-m', 'Second, waits for first', '--depends', 't-1', '--parent', 't-1']);
    dk(['add', '--unclaimed', '-m', 'Third, in build', '--priority', 'high']);
    dk(['add', '--unclaimed', '-m', 'Fourth, in commit', '--priority', 'low']);
    dk(['claim', '--size', 'S', 't-3'], 'ben.run-1');
    dk(['claim', '--size', 'S', 't-4'], 'owner@scratch');
    dk(['release', '--stage', 'commit', 't-4'], 'owner@scratch');
    settings = { backend: 'dricket', shadow: false, dkPath: bin === 'dk' ? '' : bin, dkStore: storeDir, dkDataDir: path.join(root, 'data'), dkCheckout: '', dkSyncSeconds: 30 };
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const sourceFor = (reportDir: string): StoreBoardSource =>
    new StoreBoardSource(reportDir, () => undefined, 0, () => new DricketTicketStore(new DkProcess({ bin, store: settings.dkStore, dataDir: settings.dkDataDir, env, readConcurrency: 1 })));

  it('puts each ticket in the column of its stage, ordered, with blocked and extension fields', async () => {
    const board = await sourceFor(path.join(root, 'report')).board(settings, BASE);
    expect(board.issues.filter((i) => i.level === 'error')).toEqual([]);
    const ids = (phase: string): string[] => board.columns.find((c) => c.phase.id === phase)!.tickets.map((t) => t.id);
    expect(board.columns.map((c) => c.phase.id)).toEqual(['inbox', 'prioritized', 'build', 'commit', 'done']);
    expect(ids('inbox')).toEqual(['T-0001', 'T-0002']);
    expect(ids('build')).toEqual(['T-0003']);
    expect(ids('commit')).toEqual(['T-0004']);

    const card = (id: string) => board.columns.flatMap((c) => c.tickets).find((t) => t.id === id)!;
    expect(card('T-0001').meta).toMatchObject({
      title: 'First: with a colon',
      priority: 'urgent',
      rank: 10,
      persona: 'ben',
      entered: { inbox: '2026-11-01T08:00:00Z' },
    });
    expect(card('T-0001').meta.chain).toHaveLength(2);
    expect(card('T-0001').blocks).toEqual(['T-0002']);
    expect(card('T-0002').blocked).toEqual(['T-0001']);
    expect(card('T-0002').meta).toMatchObject({ parent: 'T-0001', blockedBy: ['T-0001'] });
    expect(card('T-0003').meta).toMatchObject({ claimedBy: 'ben.run-1', priority: 'high' });
    expect(card('T-0003').meta.claimedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('writes the shadow report against a files board that differs', async () => {
    const reportDir = path.join(root, 'shadow');
    const { assembleBoard } = await import('../core/ticket-board');
    const shown = assembleBoard({
      ...BASE,
      files: [
        { path: 'tickets/inbox/T-0001.md', text: '---\nid: T-0001\ntitle: "First: with a colon"\npriority: urgent\nrank: 99\npersona: ben\n---\n' },
        { path: 'tickets/inbox/T-0009.md', text: '---\nid: T-0009\ntitle: Only in files\npriority: normal\n---\n' },
      ],
    });
    const diff = await sourceFor(reportDir).runShadow({ ...settings, shadow: true }, BASE, shown);
    expect(diff?.onlyLeft).toEqual(['T-0009']);
    expect(diff?.onlyRight).toEqual(['T-0002', 'T-0003', 'T-0004']);
    const first = diff?.differing.find((d) => d.id === 'T-0001');
    expect(first?.fields.map((f) => f.field)).toContain('meta.rank');
    expect(readFileSync(path.join(reportDir, 'board-diff.md'), 'utf8')).toContain('`meta.rank`: `99` -> `10`');
  });
});
