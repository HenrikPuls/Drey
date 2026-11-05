import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertDkVersion, MIN_DK_VERSION } from '../store/dk-process';
import { Orchestrator, type SupervisorPort } from './orchestrator';
import { normalizeFleetPools, type ChainStoreConfig, type RunRequest } from './protocol';
import type { StartOutcome, SupervisorRecord } from './runs';

/**
 * E14-5b against a REAL `dk` and a real checkout: the chain reads its board from the store's
 * files, dispatches a ticket with the dk target, and moves a ci-green ticket with one real
 * `dk put` (legacy patch -> bridge -> document, validated by dk itself). Skipped when `dk` is missing.
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
  console.warn(`[chain store dk] SKIPPED: ${found.reason}`);
}

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode }',
  '  - { id: plan-review, title: Plan review, handover: ci, ci: npm run check }',
  '  - { id: build, title: Build, handover: agent build-default, claim: true }',
  '  - { id: commit, title: Commit, claim: true, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  'priorities: [urgent, high, normal, low]',
  '---',
  'Prose.',
  '',
].join('\n');
const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.test/drey.git', '    branch: main', '    path: W:/drey', '---', 'Prose.', ''].join('\n');

describe.skipIf(!found.ok)('the chain over a real dk store (E14-5b)', { timeout: 120_000 }, () => {
  let root = '';
  let storeDir = '';
  let metaDir = '';
  let fleetRoot = '';
  let env: NodeJS.ProcessEnv;
  let store: ChainStoreConfig;

  const dk = (args: string[], owner = 'owner@scratch'): string =>
    execFileSync(bin, args, { env: { ...env, DK_OWNER: owner }, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: storeDir, env, windowsHide: true, stdio: 'pipe' });
  };

  /** A ticket with Drey's description and acceptance chapters, moved into `stage`. */
  const ticket = (title: string, stage: string): string => {
    dk(['add', '--unclaimed', '-m', title, '--set', 'x-rank=5000']);
    const n = Number(/t-(\d+)/.exec(dk(['ls']).split('\n').filter((l) => l.startsWith('t-')).at(-1) ?? '')?.[1]);
    const id = `t-${n}`;
    const shown = dk(['show', id]);
    const withBody = shown
      .replace(/^stage: .*$/m, `stage: ${stage}`)
      .replace(/^repos:.*$/m, 'repos: drey')
      .replace('(no description)', 'It should work.\n\n## Plan\n\n### Acceptance criteria\n\n- [ ] `npm run verify:unit` - exits 0');
    const file = path.join(root, `${id}.md`);
    writeFileSync(file, withBody, 'utf8');
    dk(['put', id, '-F', file, '--claim', '--if-version', /^rev: (\d+)/m.exec(shown)![1]!]);
    return id;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-dk-chain-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    storeDir = path.join(root, 'store');
    metaDir = path.join(root, 'meta');
    fleetRoot = path.join(root, 'fleet');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Chain Test',
      GIT_AUTHOR_EMAIL: 'chain@test.invalid',
      GIT_COMMITTER_NAME: 'Chain Test',
      GIT_COMMITTER_EMAIL: 'chain@test.invalid',
      DK_DATA_DIR: path.join(root, 'data'),
    };
    // dk reads HOME and the git identity from the process environment of the engine's own calls.
    Object.assign(process.env, { HOME: env['HOME'], USERPROFILE: env['USERPROFILE'], GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Chain Test', GIT_AUTHOR_EMAIL: 'chain@test.invalid', GIT_COMMITTER_NAME: 'Chain Test', GIT_COMMITTER_EMAIL: 'chain@test.invalid', DK_DATA_DIR: env['DK_DATA_DIR'], DK_OWNER: 'agent@scratch' });
    dk(['init', storeDir, 't']);
    git(['checkout', '-q', 'main']);
    const tomlPath = path.join(storeDir, 'dricket.toml');
    const toml = readFileSync(tomlPath, 'utf8')
      .replace(/\[transitions\.agent\][\s\S]*?(?=\n\[|$)/, '')
      .replace('values = ["critical", "high", "normal", "low"]', 'values = ["urgent", "high", "normal", "low"]');
    writeFileSync(
      tomlPath,
      `${toml}\n[stages]\nvalues = ["inbox", "prioritized", "plan", "plan-review", "build", "commit", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["plan", "build", "commit"]\ncancelled = "cancelled"\n`,
    );
    git(['commit', '-q', '-am', 'stages']);
    git(['checkout', '-q', 'tickets']);
    env = { ...env, DK_STORE: storeDir };
    process.env['DK_STORE'] = storeDir;

    mkdirSync(path.join(metaDir, 'tickets', '_meta', 'prompts'), { recursive: true });
    writeFileSync(path.join(metaDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE);
    writeFileSync(path.join(metaDir, 'tickets', '_meta', 'repos.md'), REPOS);
    writeFileSync(path.join(metaDir, 'tickets', '_meta', 'prompts', 'plan-default.md'), 'Work the plan step.');
    writeFileSync(path.join(metaDir, 'tickets', '_meta', 'prompts', 'build-default.md'), 'Build it.');
    mkdirSync(fleetRoot, { recursive: true });
    store = { dkPath: bin === 'dk' ? '' : bin, dkStore: storeDir, dkDataDir: path.join(root, 'data'), dkCheckout: '', trailers: false };
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function fakePort(): { port: SupervisorPort; requests: RunRequest[] } {
    const requests: RunRequest[] = [];
    const records: SupervisorRecord[] = [];
    const port: SupervisorPort = {
      start: vi.fn(async (request: RunRequest): Promise<StartOutcome> => {
        requests.push(request);
        const info = { id: `R-${requests.length}`, ticketId: request.ticketId, provider: request.provider, state: 'running' } as never;
        records.push({ info, request });
        return { ok: true, run: info };
      }),
      stop: vi.fn(async () => ({ ok: true as const })),
      records: () => [...records],
      reap: vi.fn(async () => undefined),
    };
    return { port, requests };
  }

  it('dispatches a plan ticket from the checkout with the dk target, then moves a ci-green ticket with one real put', async () => {
    const planTicket = ticket('Plan me', 'plan');
    const heldTicket = ticket('Held by a human', 'plan');
    dk(['claim', '--size', 'S', heldTicket], 'henrik');
    const ciTicket = ticket('Check me', 'plan-review');

    const fleet = fakePort();
    const orch = new Orchestrator({
      root: fleetRoot,
      log: () => undefined,
      supervisorOf: () => fleet.port,
      scanIntervalMs: 50,
      execShell: async () => undefined,
    });
    await orch.configure({
      ticketsVaultPath: metaDir,
      store,
      git: 'git',
      defaultWorker: 'opencode',
      permissionMode: 'accept-edits',
      pools: normalizeFleetPools({ opencode: { size: 2 } }),
    });
    await orch.setMaster('run');
    await vi.waitFor(() => expect(dk(['show', ciTicket])).toMatch(/^stage: build$/m), { timeout: 30_000 });
    orch.dispose();

    // The dispatch: only the free plan ticket, with what the store holds.
    const number = (id: string): number => Number(id.slice(2));
    const display = (id: string): string => `T-${String(number(id)).padStart(4, '0')}`;
    expect(fleet.requests.map((r) => r.ticketId)).toEqual([display(planTicket)]);
    expect(fleet.requests[0]).toMatchObject({ column: 'plan', nextPhase: 'plan-review', acceptance: ['npm run verify:unit'] });
    expect(fleet.requests[0]!.dk).toMatchObject({ store: storeDir, retreatStage: 'prioritized' });

    // The ci move: one real put - the stage changed, the claim fields are dk's own (nobody holds it), the Log line is in the body.
    const moved = dk(['show', ciTicket]);
    expect(moved).toMatch(/^stage: build$/m);
    expect(moved).toMatch(/^owner: *$/m);
    expect(moved).toContain('ci check passed');
    expect(() => dk(['validate'])).not.toThrow(); // dk's own validation (history replay included) accepts every commit the chain made
  });
});
