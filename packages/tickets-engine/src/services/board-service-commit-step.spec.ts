import { execFileSync } from 'node:child_process';
import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PIPELINE_TEXT } from '../core/pipeline-states';
import { TicketsGit } from '../core/tickets-git';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools, type RunInfo, type RunRequest } from '../fleet/protocol';
import { assertDkVersion, MIN_DK_VERSION } from '../store/dk-process';
import { EngineBoardService } from './board-service';
import type { EngineHost, EngineVault, FleetPort } from './host';

/**
 * Accept on Ready to try (req-99a, build plan Q8): the commit step on the target
 * repository, and Done as its bookkeeping result. The first block is the files
 * backend over a temp vault; the second a REAL `dk` over a scratch store with the
 * six stages (skipped, with the reason, when `dk` is missing), because dk's own rule
 * shapes this: an agent never releases into the terminal stage.
 */

const COMMIT_PROMPT = 'You are the commit step.';
const REPOS = (repoPath: string): string => `---\nrepos:\n  kt:\n    url: https://example.test/kt.git\n    path: '${repoPath}'\n    branch: main\n---\n`;
const BODY = '\n## Description\n\nDo it.\n\n## Plan\n\n### Acceptance criteria\n\n- [ ] `echo ok`\n\n## Log\n\n';

function runInfo(id: string, ticketId: string, state: RunInfo['state'], extra: Partial<RunInfo> = {}): RunInfo {
  return { id, ticketId, provider: 'opencode', state, pid: null, startedAt: '2026-11-06T10:00:00Z', endedAt: '2026-11-06T10:05:00Z', sessionRef: null, tokensIn: 0, tokensOut: 0, costUsd: null, lastActivity: '2026-11-06T10:05:00Z', ...extra } as RunInfo;
}

function hostOver(vaultDir: string, vault: EngineVault, config: Record<string, string>): EngineHost {
  const abs = (p: string): string => path.join(vaultDir, ...p.split('/'));
  const write = async (_v: string, p: string, text: string): Promise<void> => {
    await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
    await fsp.writeFile(abs(p), text, 'utf8');
  };
  const list = async (dir = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await fsp.readdir(dir === '' ? vaultDir : abs(dir), { withFileTypes: true }).catch(() => [])) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(...(await list(rel)));
      } else if (entry.name.endsWith('.md')) {
        out.push(rel);
      }
    }
    return out;
  };
  return {
    listVaults: async () => [vault],
    read: async (_v, p) => fsp.readFile(abs(p), 'utf8'),
    writeAnnounced: write,
    write,
    listMarkdownFiles: () => list(),
    resolveAssetPath: (_v, p) => abs(p),
    announceChanges: () => undefined,
    markManaged: () => undefined,
    configGet: async <T>(key: string) => config[key] as T | undefined,
    configSet: async () => undefined,
    emitBoardChanged: () => undefined,
    log: () => undefined,
    userRoot: path.join(vaultDir, 'userroot'),
    pickFolder: async () => null,
    revealPath: async () => '',
    launchInConsole: () => undefined,
  };
}

function serviceOver(host: EngineHost, fleet: FleetPort): EngineBoardService {
  return new EngineBoardService(host, new TicketsGit(() => 'git', async () => { throw new Error('no git in the spec'); }), 'opencode', 'accept-edits', '', fleet, '/fleet', normalizeFleetCaps({}), normalizeFleetPools({}), normalizeFleetHandover({}), 'owner@test', {});
}

describe('Accept on the files backend', () => {
  let vaultDir = '';
  let started: RunRequest[] = [];
  let runs: RunInfo[] = [];
  let service: EngineBoardService;

  const fleet: FleetPort = {
    runs: async () => runs,
    start: async (request) => {
      started.push(request);
      return { ok: true, run: runInfo('R-1', request.ticketId, 'running') };
    },
    configureChain: async () => undefined,
  };
  const abs = (...parts: string[]): string => path.join(vaultDir, 'tickets', ...parts);

  async function ticket(id: string, phase: string, header: Record<string, string> = { repo: 'kt' }): Promise<void> {
    const keys = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
    await fsp.mkdir(abs(phase), { recursive: true });
    await fsp.writeFile(abs(phase, `${id}.md`), ['---', `id: ${id}`, `title: ${id}`, 'priority: normal', 'rank: 5000', ...keys, '---', BODY].join('\n'), 'utf8');
  }

  async function usePipeline(text: string): Promise<void> {
    await fsp.writeFile(abs('_meta', 'pipeline.md'), text, 'utf8');
  }

  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-commit-step-'));
    started = [];
    runs = [];
    await fsp.mkdir(abs('_meta', 'prompts'), { recursive: true });
    await usePipeline(DEFAULT_PIPELINE_TEXT);
    await fsp.writeFile(abs('_meta', 'repos.md'), REPOS(path.join(vaultDir, 'kt').split(path.sep).join('/')), 'utf8');
    await fsp.writeFile(abs('_meta', 'prompts', 'commit-default.md'), COMMIT_PROMPT, 'utf8');
    service = serviceOver(hostOver(vaultDir, { id: 'v', name: 'vault', path: vaultDir, exists: true, active: true }, {}), fleet);
  });

  afterEach(async () => {
    await fsp.rm(vaultDir, { recursive: true, force: true });
  });

  it('starts the commit step instead of moving; the run itself moves the ticket into Done', async () => {
    await ticket('T-0001', 'ready');
    expect(await service.acceptTicket({ id: 'T-0001' })).toEqual({ ok: true, runId: 'R-1' });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ ticketId: 'T-0001', nextPhase: 'done', gate: 'commands', acceptance: ['echo ok'], permissionMode: 'accept-edits' });
    expect(started[0]!.instruction).toContain(COMMIT_PROMPT);
    await expect(fsp.stat(abs('ready', 'T-0001.md'))).resolves.toBeDefined();
  });

  it('runs under no persona of the ticket or the column, and under the crew\'s commit persona when there is one', async () => {
    const persona = async (id: string, prompt: string): Promise<void> => {
      const dir = abs('_meta', 'personas', id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'persona.md'), `---\ntitle: ${id}\nrole: builder\nworker: opencode\nmodels:\n  default: sonnet\n  pool: [sonnet]\n  router: off\ncolor: '#a78bfa'\n---\n`, 'utf8');
      await fsp.writeFile(path.join(dir, 'prompt.md'), prompt, 'utf8');
    };
    await persona('ben', 'The builder speaks.');
    await ticket('T-0001', 'ready', { repo: 'kt', persona: 'ben' });
    await service.acceptTicket({ id: 'T-0001' });
    expect(started[0]!.instruction).toContain(COMMIT_PROMPT);
    expect(started[0]!.instruction).not.toContain('The builder speaks.');

    await persona('commit-default', 'The crew member who commits speaks.');
    await service.acceptTicket({ id: 'T-0001' });
    expect(started[1]!.instruction).toContain('The crew member who commits speaks.');
    expect(started[1]!.instruction).not.toContain('The builder speaks.');
  });

  it('refuses while a run is live, and names the missing prompt', async () => {
    await ticket('T-0001', 'ready');
    runs = [runInfo('R-9', 'T-0001', 'running')];
    expect(await service.acceptTicket({ id: 'T-0001' })).toMatchObject({ ok: false, error: expect.stringContaining('live run') });
    runs = [];
    await fsp.rm(abs('_meta', 'prompts', 'commit-default.md'));
    expect(await service.acceptTicket({ id: 'T-0001' })).toMatchObject({ ok: false, error: expect.stringContaining('commit-default.md is missing') });
    expect(started).toEqual([]);
  });

  it('a ticket without a repository has nothing to merge: Accept is the plain move into Done', async () => {
    await ticket('T-0002', 'ready', {});
    expect(await service.acceptTicket({ id: 'T-0002' })).toMatchObject({ ok: true });
    expect(started).toEqual([]);
    await expect(fsp.stat(abs('60-done', 'T-0002.md'))).resolves.toBeDefined();
  });

  it('elsewhere on the six stages Accept stays the ordinary next move', async () => {
    await ticket('T-0003', 'shaping');
    expect(await service.acceptTicket({ id: 'T-0003' })).toMatchObject({ ok: true });
    await expect(fsp.stat(abs('30-prioritized', 'T-0003.md'))).resolves.toBeDefined();
    expect(started).toEqual([]);
  });

  it('an older board keeps its Accept: Sign Off is the plain move, nothing starts', async () => {
    await usePipeline(['---', 'phases:', '  - { id: inbox, title: Inbox, handover: manual }', '  - { id: build, title: Build, claim: true, handover: agent build-default }', '  - { id: sign-off, title: Sign Off, handover: manual }', '  - { id: done, title: Done, handover: none }', '---', ''].join('\n'));
    await ticket('T-0004', 'sign-off');
    expect(await service.acceptTicket({ id: 'T-0004' })).toMatchObject({ ok: true });
    expect(started).toEqual([]);
    await expect(fsp.stat(abs('40-done', 'T-0004.md'))).resolves.toBeDefined();
  });
});

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
  console.warn(`[commit step on a store] SKIPPED: ${found.reason}`);
}

describe.skipIf(!found.ok)('Accept on a store with the six stages (real dk)', { timeout: 240_000 }, () => {
  let root = '';
  let storeDir = '';
  let vaultDir = '';
  let service: EngineBoardService;
  const saved: Record<string, string | undefined> = {};
  const started: RunRequest[] = [];
  let runs: RunInfo[] = [];

  const envSet = (key: string, value: string): void => {
    if (!(key in saved)) {
      saved[key] = process.env[key];
    }
    process.env[key] = value;
  };
  const dk = (args: string[], owner?: string): string =>
    execFileSync(bin, args, { windowsHide: true, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...(owner === undefined ? {} : { DK_OWNER: owner }) } });
  const stageOf = (id: string): string => /^stage: (.*)$/m.exec((JSON.parse(dk(['show', id, '--json'])) as { data: { content: string } }).data.content)?.[1]?.trim() ?? '';

  /** The way a run works the ticket: an agent's claim (dk moves it into Building), then its stay-put release. */
  function agentRun(id: string, runId: string): void {
    dk(['--json', 'claim', id, '--size', 'S', '--kind', 'agent'], `agent-${runId}@test`);
  }

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-commit-dk-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    storeDir = path.join(root, 'store');
    for (const [k, v] of Object.entries({
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
      DK_OWNER: 'owner@test',
    })) {
      envSet(k, v);
    }
    dk(['init', storeDir, 't']);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: storeDir, windowsHide: true, stdio: 'pipe' });
    };
    git(['config', 'core.autocrlf', 'false']);
    git(['checkout', '-q', 'main']);
    const tomlPath = path.join(storeDir, 'dricket.toml');
    const toml = readFileSync(tomlPath, 'utf8')
      .replace(/\[transitions\.agent\][\s\S]*?(?=\n\[|$)/, '')
      .replace('values = ["critical", "high", "normal", "low"]', 'values = ["urgent", "high", "normal", "low"]');
    writeFileSync(tomlPath, `${toml}\n[stages]\nvalues = ["inbox", "shaping", "prioritized", "building", "ready", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["building"]\ncancelled = "cancelled"\n`);
    git(['commit', '-q', '-am', 'the six stages']);
    git(['checkout', '-q', 'tickets']);
    envSet('DK_STORE', storeDir);

    vaultDir = path.join(root, 'meta');
    const kt = path.join(root, 'kt');
    mkdirSync(kt);
    await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'prompts'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), DEFAULT_PIPELINE_TEXT, 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'repos.md'), REPOS(kt.split(path.sep).join('/')), 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'commit-default.md'), COMMIT_PROMPT, 'utf8');

    const fleet: FleetPort = {
      runs: async () => runs,
      start: async (request) => {
        started.push(request);
        return { ok: true, run: runInfo(`R-${started.length}`, request.ticketId, 'running') };
      },
      configureChain: async () => undefined,
    };
    const config = { backend: 'dricket', 'dk.path': bin === 'dk' ? '' : bin, 'dk.store': storeDir, 'dk.dataDir': path.join(root, 'data') };
    service = serviceOver(hostOver(vaultDir, { id: 'v', name: 'vault', path: vaultDir, exists: true, active: true }, config), fleet);
  });

  afterAll(async () => {
    service.dispose();
    await service.idle();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function readyTicket(title: string): Promise<{ id: string; dkId: string }> {
    const dkId = dk(['add', '--unclaimed', '-m', title]).trim();
    const text = (JSON.parse(dk(['show', dkId, '--json'])) as { data: { content: string; rev?: number } }).data.content;
    const file = path.join(root, `${dkId}.md`);
    writeFileSync(file, `${text.replace(/^stage: .*$/m, 'stage: ready').replace(/^repos:.*$/m, 'repos: kt').replace(/\s*$/, '\n')}\n## Plan\n\n### Acceptance criteria\n\n- [ ] \`echo ok\`\n`);
    const rev = /^rev: (\d+)$/m.exec(text)?.[1] ?? '1';
    dk(['put', dkId, '-F', file, '--claim', '--if-version', rev]);
    return { id: `T-${dkId.slice(2).padStart(4, '0')}`, dkId };
  }

  it('dk itself forbids the short way: an agent may not release into Done', async () => {
    const { dkId } = await readyTicket('Rule check');
    agentRun(dkId, 'probe');
    expect(stageOf(dkId)).toBe('building');
    expect(() => dk(['--json', 'release', '--stage', 'done', '-m', 'x', dkId], 'agent-probe@test')).toThrow(/may not release/);
    dk(['--json', 'release', '--stage', 'ready', '-m', 'x', dkId], 'agent-probe@test');
    expect(stageOf(dkId)).toBe('ready');
  });

  it('a green commit step leaves the ticket for the bookkeeping move, which lands it in Done', async () => {
    const { id, dkId } = await readyTicket('Green');
    const accepted = await service.acceptTicket({ id });
    expect(accepted).toMatchObject({ ok: true });
    const request = started[started.length - 1]!;
    expect(request).toMatchObject({ ticketId: id, nextPhase: null, gate: 'commands' });
    expect(request.dk).toMatchObject({ store: storeDir, retreatStage: 'building' });
    const runId = (accepted as { runId?: string }).runId!;

    // Still running: nothing moves.
    runs = [runInfo(runId, id, 'running')];
    await service.settleCommitSteps();
    expect(stageOf(dkId)).toBe('ready');

    // The run claims, works and hands back as the runner does when it moved nothing.
    agentRun(dkId, 'green');
    dk(['--json', 'release', '--stage', 'ready', '-m', 'merged', dkId], 'agent-green@test');
    runs = [runInfo(runId, id, 'done', { gateResult: 'green' })];
    await service.settleCommitSteps();
    expect(stageOf(dkId)).toBe('done');

    // Idempotent: the list is empty now.
    await service.settleCommitSteps();
    expect(stageOf(dkId)).toBe('done');
    expect(() => dk(['validate'])).not.toThrow();
  });

  it('a run that reads done while its claim is still held waits for the release, then lands in Done (D-32)', async () => {
    const { id, dkId } = await readyTicket('Late release');
    const accepted = (await service.acceptTicket({ id })) as { runId?: string };
    const runId = accepted.runId!;
    // The runner's record says done + green, but its claim is not released yet: the ticket is still in Building.
    agentRun(dkId, 'late');
    runs = [runInfo(runId, id, 'done', { gateResult: 'green' })];
    await service.settleCommitSteps();
    expect(stageOf(dkId)).toBe('building');
    // The release a moment later: the next settle books the move.
    dk(['--json', 'release', '--stage', 'ready', '-m', 'merged', dkId], 'agent-late@test');
    await service.settleCommitSteps();
    expect(stageOf(dkId)).toBe('done');
  });

  it('a blocked or failed commit step leaves the ticket on Ready to try', async () => {
    const blocked = await readyTicket('Blocked');
    const a = (await service.acceptTicket({ id: blocked.id })) as { runId?: string };
    runs = [runInfo(a.runId!, blocked.id, 'done', { blocked: 'the policy merge awaits the owner' })];
    await service.settleCommitSteps();
    expect(stageOf(blocked.dkId)).toBe('ready');

    const failed = await readyTicket('Failed');
    const b = (await service.acceptTicket({ id: failed.id })) as { runId?: string };
    runs = [runInfo(b.runId!, failed.id, 'failed')];
    await service.settleCommitSteps();
    expect(stageOf(failed.dkId)).toBe('ready');
  });

  it('reading the board settles a finished step', async () => {
    const { id, dkId } = await readyTicket('By read');
    const accepted = (await service.acceptTicket({ id })) as { runId?: string };
    runs = [runInfo(accepted.runId!, id, 'done', { gateResult: 'green' })];
    await service.snapshot();
    await service.idle();
    expect(stageOf(dkId)).toBe('done');
  });
});
