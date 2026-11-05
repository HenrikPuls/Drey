import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newTicketFileText } from '../core/ticket-files';
import type { PutOptions, TicketDetail } from '../ports/ticket-store';
import { detailFromContent } from '../store/dricket-ticket-store';
import { Orchestrator, type OrchestratorDeps, type StartOptions, type SupervisorPort } from './orchestrator';
import { normalizeFleetPools, type ChainStoreConfig, type RunInfo, type RunRequest } from './protocol';
import type { StartOutcome, StopOutcome, SupervisorRecord } from './runs';
import { StoreChainBoard, type ChainStoreIo } from './store-chain-board';

/**
 * E14-5b: the chain orchestrator on a dricket store. The board is assembled from the store's
 * records (a fake door here: what `dk` answers is dk's business, the real thing runs in
 * `chain-store-dk.spec.ts`); the meta vault only carries pipeline + repos + prompts. What must
 * hold: the dispatch carries the `dk` target, a claimed ticket is held, no ticket file appears
 * anywhere, and the chain's own writes (ci move) are `put`s with the rev they were made on.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode }',
  '  - { id: plan-review, title: Plan review, handover: ci, ci: npm run check }',
  '  - { id: build, title: Build, handover: agent build-default, claim: true }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'Prose.',
  '',
].join('\n');
const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.test/drey.git', '    branch: main', '    path: W:/drey', '---', 'Prose.', ''].join('\n');

const STORE: ChainStoreConfig = { dkPath: 'dk', dkStore: 'E:/store', dkDataDir: '', dkCheckout: 'E:/store', trailers: false };

/** A dricket document of a ticket in `stage`, its body the one Drey's own ticket template writes. */
function document(n: number, stage: string, rev: number, owner = ''): string {
  const legacy = newTicketFileText({
    id: `T-${String(n).padStart(4, '0')}`,
    title: `Ticket ${n}`,
    repo: 'drey',
    priority: 'normal',
    rank: 5000,
    firstPhase: stage,
    now: new Date('2026-10-18T10:00:00Z'),
    actor: 'owner@box',
    description: 'It should work.',
  }).replace('Executable checks as backticked checkbox lines; the machine gate runs them.', '- [ ] `npm run verify:unit` — exits 0');
  const body = legacy.slice(legacy.indexOf('\n---\n', 4) + 5);
  return [
    '---',
    `id: t-${n}`,
    'created_at: 2026-10-18T10:00:00Z',
    'created_by: owner',
    'schema_version: 1',
    `title: Ticket ${n}`,
    `stage: ${stage}`,
    `owner: ${owner}`,
    'kind: agent',
    'size: M',
    `claimed_at: ${owner === '' ? '' : '2026-10-18T11:00:00Z'}`,
    `lease_until: ${owner === '' ? '' : '2026-10-19T11:00:00Z'}`,
    'epoch: 0',
    `rev: ${rev}`,
    'extensions: 0',
    'priority: normal',
    'labels: ',
    'depends: ',
    'parent: ',
    'touches: ',
    'branch: ',
    'repos: drey',
    'x-rank: 5000',
    '---',
    body,
  ].join('\n');
}

class FakeIo implements ChainStoreIo {
  readonly docs = new Map<string, string>();
  readonly writes: { id: string; text: string; options: PutOptions }[] = [];
  readonly comments: { id: string; text: string; actor: string }[] = [];

  add(n: number, stage: string, owner = ''): void {
    this.docs.set(`T-${String(n).padStart(4, '0')}`, document(n, stage, 0, owner));
  }
  readAll(): Promise<readonly TicketDetail[]> {
    return Promise.resolve([...this.docs.values()].map((text) => detailFromContent(text)));
  }
  show(id: string): Promise<TicketDetail> {
    const text = this.docs.get(id);
    return text === undefined ? Promise.reject(new Error(`no ${id}`)) : Promise.resolve(detailFromContent(text));
  }
  write(id: string, text: string, options: PutOptions): ReturnType<ChainStoreIo['write']> {
    this.writes.push({ id, text, options });
    const rev = (options.expectedRev ?? 0) + 1;
    this.docs.set(id, text.replace(/^rev: .*$/m, `rev: ${rev}`));
    return Promise.resolve({ ok: true, result: { id, rev, commit: null, changedFields: ['stage'] } });
  }
  comment(id: string, text: string, options: { actor: string }): Promise<void> {
    this.comments.push({ id, text, actor: options.actor });
    return Promise.resolve();
  }
}

function fakePort() {
  const records: SupervisorRecord[] = [];
  let counter = 0;
  const start = vi.fn(async (request: RunRequest, _options?: StartOptions): Promise<StartOutcome> => {
    counter += 1;
    const info = {
      id: `R-${String(counter).padStart(3, '0')}`,
      ticketId: request.ticketId,
      provider: request.provider,
      state: 'running',
      pid: 4242,
      startedAt: '2026-10-18T12:00:00Z',
      endedAt: null,
      sessionRef: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: '2026-10-18T12:00:00Z',
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'W:/wt',
      branch: request.branch,
      gateFailure: null,
    } as RunInfo;
    records.push({ info, request });
    return { ok: true, run: info };
  });
  const port: SupervisorPort = {
    start,
    stop: vi.fn(async (): Promise<StopOutcome> => ({ ok: true })),
    records: () => [...records],
    reap: vi.fn(async (): Promise<void> => undefined),
  };
  return { port, records, start };
}

let vaultDir = '';
let fleetRoot = '';
let io: FakeIo;

function orchestrator(over: Partial<OrchestratorDeps> = {}) {
  const fleet = fakePort();
  const orch = new Orchestrator({
    root: fleetRoot,
    log: () => undefined,
    supervisorOf: () => fleet.port,
    scanIntervalMs: 60_000,
    storeChainFor: () => new StoreChainBoard(io, () => undefined),
    ...over,
  });
  return { orch, fleet };
}

const config = (): Parameters<Orchestrator['configure']>[0] => ({
  ticketsVaultPath: vaultDir,
  store: STORE,
  git: 'git',
  defaultWorker: 'opencode',
  permissionMode: 'accept-edits',
  pools: normalizeFleetPools({ opencode: { size: 2 } }),
});

async function treeOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(...(entry.isDirectory() ? (await treeOf(full)).map((p) => `${entry.name}/${p}`) : [entry.name]));
  }
  return out;
}

describe('Orchestrator on a dricket store (E14-5b)', () => {
  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-meta-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
    await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'prompts'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'repos.md'), REPOS, 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'plan-default.md'), 'Work the plan step.', 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'build-default.md'), 'Build it.', 'utf8');
    io = new FakeIo();
  });

  afterEach(async () => {
    for (const dir of [vaultDir, fleetRoot]) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fsp.rm(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  });

  it('dispatches from the store: the request carries the dk target and the stage-named next phase, no ticket file appears', async () => {
    io.add(1, 'prioritized');
    io.add(3, 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(config());
    await orch.setMaster('run');
    orch.dispose();

    const started = fleet.records.filter((r) => r.info.state === 'running');
    expect(started.map((r) => r.request.ticketId)).toEqual(['T-0003']);
    const request = started[0]!.request;
    expect(request.column).toBe('plan');
    expect(request.nextPhase).toBe('plan-review');
    expect(request.nextPhaseDir).toBe('plan-review');
    expect(request.dk).toMatchObject({ bin: 'dk', store: 'E:/store', checkout: 'E:/store', retreatStage: 'prioritized', parkStage: null, needsInputStage: null, trailers: false });
    expect(request.instruction).toContain('Work the plan step.');
    expect(request.acceptance).toEqual(['npm run verify:unit']);
    expect(io.writes).toEqual([]); // dispatch itself writes nothing: the run's claim is the stamp
    expect(await treeOf(vaultDir)).toEqual(['tickets/_meta/pipeline.md', 'tickets/_meta/prompts/build-default.md', 'tickets/_meta/prompts/plan-default.md', 'tickets/_meta/repos.md']);
  });

  it('a ticket someone holds is held: the pool waits, the chain log says whose claim it is', async () => {
    io.add(3, 'plan', 'henrik');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({ log: (m) => logs.push(m) });
    await orch.configure(config());
    await orch.setMaster('run');
    orch.dispose();
    expect(fleet.records).toEqual([]);
    expect(logs.join('\n')).toContain('claimed by henrik');
  });

  it('the first dispatch of a store releases a killed runner\'s leftover claims, once, then reads the board again', async () => {
    io.add(3, 'plan', 'agent-r-old@box');
    const releaseLeftovers = vi.fn(async () => {
      io.docs.set('T-0003', document(3, 'plan', 1)); // the runner released it
    });
    const { orch, fleet } = orchestrator({ releaseLeftovers });
    await orch.configure(config());
    await orch.setMaster('run');
    await orch.configure(config());
    orch.dispose();
    expect(releaseLeftovers).toHaveBeenCalledTimes(1);
    expect(releaseLeftovers).toHaveBeenCalledWith(STORE, expect.arrayContaining([expect.objectContaining({ id: 'plan' })]));
    expect(fleet.records.map((r) => r.request.ticketId)).toEqual(['T-0003']); // dispatched on the re-read board
  });

  it('a green ci check moves the ticket with one put on the rev it read; no claim is stamped by the chain', async () => {
    io.add(9, 'plan-review');
    const { orch } = orchestrator({ scanIntervalMs: 20, execShell: async () => undefined });
    await orch.configure(config());
    await orch.setMaster('run');
    await vi.waitFor(() => expect(io.writes).toHaveLength(1), { timeout: 5_000 });
    orch.dispose();
    const write = io.writes[0]!;
    expect(write.id).toBe('T-0009');
    expect(write.options.expectedRev).toBe(0);
    expect(write.text).toMatch(/^stage: build$/m);
    expect(write.text).toContain('ci check passed');
    expect(write.text).not.toMatch(/^owner: \S/m); // a claim is dk's and the run's, never the chain's
  });

  it('a red ci check leaves a Log line through put and backs the ticket off', async () => {
    io.add(9, 'plan-review');
    const { orch } = orchestrator({
      scanIntervalMs: 20,
      execShell: async () => {
        throw new Error('exit 1\ncheck failed');
      },
    });
    await orch.configure(config());
    await orch.setMaster('run');
    await vi.waitFor(() => expect(io.writes).toHaveLength(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    orch.dispose();
    expect(io.writes).toHaveLength(1); // the backoff holds the retry
    expect(io.writes[0]!.text).toContain('ci check failed');
    expect(io.writes[0]!.text).toMatch(/^stage: plan-review$/m);
  });
});
