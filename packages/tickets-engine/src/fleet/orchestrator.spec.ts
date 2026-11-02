import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  effectivePoolSizes,
  isQuotaError,
  failureBackoffMs,
  isRateLimitError,
  Orchestrator,
  QUOTA_PAUSE_MS,
  RATE_LIMIT_SHRINK_MS,
  RED_COOLDOWN_MS,
  type OrchestratorDeps,
  type StartOptions,
  type SupervisorPort,
} from './orchestrator';
import type { StartOutcome, StopOutcome, SupervisorRecord } from './runs';
import { normalizeFleetPools, type FleetPools, type RunInfo, type RunRequest } from './protocol';
import { newTicketFileText } from '../core/ticket-files';
import { listTicketDirs } from '../core/phase-dirs';
import { stripPhasePrefix } from '../contracts/tickets';

/**
 * The chain orchestrator against a REAL tickets vault (temp dir) and a
 * fake supervisor port — the dispatch planning runs against the same
 * assembled board Drey renders, so the file semantics cannot drift.
 */

let vaultDir = '';
let fleetRoot = '';

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode, model: zai/glm-5.3 }',
  '  - { id: plan-review, title: Plan review, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, claim: true }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'Prose.',
  '',
].join('\n');

const REPOS = [
  '---',
  'repos:',
  '  drey:',
  '    url: https://example.test/drey.git',
  '    branch: main',
  '    path: W:/drey',
  '---',
  'Prose.',
  '',
].join('\n');

function ticketText(id: string, phase: string): string {
  return newTicketFileText({
    id,
    title: `Ticket ${id}`,
    repo: 'drey',
    priority: 'normal',
    rank: 5000,
    firstPhase: phase,
    now: new Date('2026-10-18T10:00:00Z'),
    actor: 'owner@box',
    description: 'It should work.',
  }).replace(
    'Executable checks as backticked checkbox lines; the machine gate runs them.',
    '- [ ] `npm run verify:unit` — exits 0',
  );
}

/** Where a ticket of `phase` sits (T-0041: a machine move may create the
 *  numbered `NN-<phase>` folder); the unprefixed path when it is nowhere. */
async function phasePath(phase: string, id: string): Promise<string> {
  const root = path.join(vaultDir, 'tickets');
  for (const dir of await listTicketDirs(root)) {
    const candidate = path.join(root, dir, `${id}.md`);
    if (stripPhasePrefix(dir) === phase && (await fsp.access(candidate).then(() => true, () => false))) {
      return candidate;
    }
  }
  return path.join(root, phase, `${id}.md`);
}

async function writeTicket(id: string, phase: string): Promise<void> {
  const rel = path.join(vaultDir, 'tickets', phase, `${id}.md`);
  await fsp.mkdir(path.dirname(rel), { recursive: true });
  await fsp.writeFile(rel, ticketText(id, phase), 'utf8');
}

async function writeMeta(prompt = 'Work the plan step.'): Promise<void> {
  await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'prompts'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'repos.md'), REPOS, 'utf8');
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'plan-default.md'), prompt, 'utf8');
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'build-default.md'), 'Build it.', 'utf8');
}

function fakePort() {
  const records: SupervisorRecord[] = [];
  let counter = 0;
  const start = vi.fn(async (request: RunRequest, _options?: StartOptions): Promise<StartOutcome> => {
      counter += 1;
      const info: RunInfo = {
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
      };
      records.push({ info, request });
      return { ok: true, run: info };
  });
  const port: SupervisorPort = {
    start,
    stop: vi.fn(async (runId: string, reason: string | null): Promise<StopOutcome> => {
      const index = records.findIndex((r) => r.info.id === runId);
      if (index >= 0) {
        records[index] = { ...records[index]!, info: { ...records[index]!.info, state: 'stopped' } };
      }
      return { ok: true };
    }),
    records: () => [...records],
    reap: vi.fn(async (): Promise<void> => undefined),
  };
  return { port, records, start, stop: port.stop };
}

function orchestrator(over: Partial<OrchestratorDeps> = {}): { orch: Orchestrator; fleet: ReturnType<typeof fakePort> } {
  const fleet = fakePort();
  const orch = new Orchestrator({
    root: fleetRoot,
    log: (message) => console.log(`[orch] ${message}`),
    supervisorOf: () => fleet.port,
    scanIntervalMs: 60_000,
    ...over,
  });
  return { orch, fleet };
}

/** Two OpenCode slots shared by every column (req-63). */
const TWO: FleetPools = normalizeFleetPools({ opencode: { size: 2 } });
const ONE: FleetPools = normalizeFleetPools({});

const CONFIG = {
  ticketsVaultPath: '', // set in beforeEach
  git: 'git',
  defaultWorker: 'opencode',
  permissionMode: 'accept-edits' as const,
  pools: TWO,
};

/** A failed run of `ticket` whose gate failed with `failure` (T-0048's retry context). */
function failedRecord(ticket: string, failure: string): SupervisorRecord {
  return {
    info: {
      id: `R-old-${ticket}`,
      ticketId: ticket,
      provider: 'opencode',
      state: 'failed',
      pid: null,
      startedAt: '2026-10-18T11:00:00Z',
      endedAt: '2026-10-18T11:20:00Z',
      sessionRef: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: '2026-10-18T11:20:00Z',
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'W:/wt',
      branch: `t/${ticket}`,
      gateFailure: failure,
    },
    request: { ticketId: ticket, column: 'plan' } as RunRequest,
  };
}

describe('Orchestrator', () => {
  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
    CONFIG.ticketsVaultPath = vaultDir;
  });

  afterEach(async () => {
    // A sweep or pass may still hold a temp file open for a beat.
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

  it('dispatches the plan pool from its own queue — never from prioritized', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'prioritized');
    await writeTicket('T-0002', 'prioritized');
    await writeTicket('T-0003', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');

    // The owner's queue (prioritized) is never touched: only the ticket
    // the owner moved into the worker column runs.
    const started = fleet.records.filter((r) => r.info.state === 'running');
    expect(started.map((r) => r.request.ticketId)).toEqual(['T-0003']);
    expect(started[0]!.request.phase).toBe('plan');
    expect(started[0]!.request.column).toBe('plan');
    expect(started[0]!.request.nextPhase).toBe('plan-review');
    expect(started[0]!.request.model).toBe('zai/glm-5.3');
    expect(started[0]!.request.instruction).toContain('Work the plan step.');
  });

  it('never pulls from a manual column: neither prioritized nor the checkpoint feeds a pool', async () => {
    await writeMeta();
    await writeTicket('T-0004', 'plan-review');
    await writeTicket('T-0005', 'commit');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toEqual([]);
  });

  it('the chain log says why nothing moves — once, not on every pass', async () => {
    await writeMeta();
    // T-0001 names a repo that is not in repos.md: the dispatch note.
    await writeTicket('T-0001', 'plan');
    await fsp.writeFile(
      path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'),
      ticketText('T-0001', 'plan').replace('repo: drey', 'repo: nowhere'),
      'utf8',
    );
    // T-0002 is dispatchable, but its column is held: the held note.
    await writeTicket('T-0002', 'plan-review');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
    await orch.configure(CONFIG);
    await orch.setColumn('plan-review', 'held');
    await orch.setMaster('run');
    await orch.setMaster('halted');
    await orch.setMaster('run'); // second pass — the notes must stay silent

    const skips = logs.filter((line) => line.includes('T-0001'));
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('repo "nowhere" is not in repos.md');
    const held = logs.filter((line) => line.includes('held column'));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('T-0002');
    expect(fleet.records).toEqual([]);
  });

  it('a refused start parks the column queue behind it — the chain log says so', async () => {
    await writeMeta();
    // one OpenCode slot — the plan takes one ticket, and its refused
    // start must not leave the queued one silently waiting (the outage
    // shape: one poisoned worktree parked a whole column).
    await writeTicket('T-0001', 'build');
    await writeTicket('T-0002', 'build');
    const logs: string[] = [];
    const fleet = fakePort();
    const refusing: SupervisorPort = {
      ...fleet.port,
      start: vi.fn(async (): Promise<StartOutcome> => ({
        ok: false,
        error: 'worktree failed: worktree W:/wt is on main, expected t/T-0001',
      })),
    };
    const orch = new Orchestrator({
      root: fleetRoot,
      log: (message) => logs.push(message),
      supervisorOf: () => refusing,
      scanIntervalMs: 60_000,
    });
    await orch.configure({ ...CONFIG, pools: ONE });
    await orch.setMaster('run');
    await orch.setMaster('halted');
    await orch.setMaster('run'); // second pass — the notes must stay silent

    expect(fleet.records).toEqual([]);
    const refusal = logs.filter((line) => line.startsWith('dispatch refused'));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain('is on main, expected');
    const waits = logs.filter((line) => line.startsWith('dispatch waits'));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain("build's dispatch of");
    expect(waits[0]).toContain('was refused — the queue cannot advance');
  });

  it('a queued candidate behind a live run says why it waits (no free slot)', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'build');
    await writeTicket('T-0002', 'build');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
    await orch.configure({ ...CONFIG, pools: ONE });
    await orch.setMaster('run');

    expect(fleet.records).toHaveLength(1); // one OpenCode slot — one runs, one queues
    const waits = logs.filter((line) => line.startsWith('dispatch waits'));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain('no free opencode pool slot yet');
  });

  it('the provider pool is shared: an idle slot serves the rightmost column first (req-63)', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'build');
    const { orch, fleet } = orchestrator();
    await orch.configure({ ...CONFIG, pools: ONE });
    await orch.setMaster('run');
    expect(fleet.records.map((r) => r.info.ticketId)).toEqual(['T-0002']);
  });

  it('a probed llama.cpp server caps the pool (req-63)', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    const logs: string[] = [];
    const probeSlots = vi.fn(async (): Promise<number | null> => 1);
    const { orch, fleet } = orchestrator({ log: (message) => logs.push(message), probeSlots });
    await orch.configure({
      ...CONFIG,
      pools: normalizeFleetPools({ opencode: { size: 4, probeUrl: 'http://127.0.0.1:8080' } }),
    });
    await orch.setMaster('run');
    expect(probeSlots).toHaveBeenCalledWith('http://127.0.0.1:8080');
    expect(fleet.records).toHaveLength(1);
    expect(logs.some((line) => line.includes('runs 1 parallel slot'))).toBe(true);
  });

  it('a run out of quota pauses its provider pool — no new run, no red gate', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    await writeTicket('T-0003', 'plan');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(2);
    const first = fleet.records[0]!;
    fleet.records[0] = {
      ...first,
      info: { ...first.info, state: 'failed', lastError: 'provider.quota 429: Usage limit reached for 5 hour.' },
    };
    await orch.onRunSettled(fleet.records[0].info);
    expect(logs.some((line) => line.includes('opencode is out of quota'))).toBe(true);
    expect(logs.some((line) => line.includes('red gate'))).toBe(false);
    expect(fleet.records).toHaveLength(2);
    // The board reads the pause off the status (chain alerts fix).
    expect(Object.keys(orch.status().quotaPausedUntil ?? {})).toEqual(['opencode']);
  });

  it('a rate-limited run shrinks its provider pool for a while (req-63)', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    await writeTicket('T-0003', 'plan');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(2);
    const first = fleet.records[0]!;
    fleet.records[0] = { ...first, info: { ...first.info, state: 'failed', lastError: 'prompt failed: 429' } };
    await orch.onRunSettled(fleet.records[0].info);
    expect(logs.some((line) => line.includes('opencode hit its rate limit'))).toBe(true);
    // two slots minus the shrink = one, and one run is still live — nothing new starts
    expect(fleet.records.filter((r) => r.info.state === 'running')).toHaveLength(1);
  });

  it('respects capacity, held columns and busy tickets', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    await writeTicket('T-0003', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    // two OpenCode slots — exactly two runs, no pull happened (none available).
    expect(fleet.records).toHaveLength(2);

    // A settled run frees the slot; the moved ticket leaves the plan
    // column (the success move), and the third ticket goes on the next pass.
    const first = fleet.records[0]!;
    fleet.records[0] = { ...first, info: { ...first.info, state: 'done' } };
    await fsp.mkdir(path.join(vaultDir, 'tickets', 'plan-review'), { recursive: true });
    await fsp.rename(
      path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'),
      path.join(vaultDir, 'tickets', 'plan-review', 'T-0001.md'),
    );
    await orch.setMaster('halted');
    await orch.setMaster('run');
    expect(fleet.records.filter((r) => r.info.state === 'running')).toHaveLength(2);
    expect(fleet.records.map((r) => r.request.ticketId)).toContain('T-0003');
  });

  it('Notaus aborts every live run and halts the chain', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    const status = await orch.setMaster('run');
    expect(status.master).toBe('run');
    expect(fleet.records).toHaveLength(2);

    const after = await orch.abortAll();
    expect(after.master).toBe('halted');
    expect(fleet.stop).toHaveBeenCalledTimes(2);
    expect(orch.status().master).toBe('halted');
  });

  it('stopping one column holds only that column and aborts only its runs', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1);
    const runId = fleet.records[0]!.info.id;

    await orch.stopColumn('plan');
    expect(fleet.stop).toHaveBeenCalledWith(runId, 'column plan stopped');
    expect(orch.status().columns['plan']).toBe('held');

    // Another configure pass dispatches nothing while the column holds.
    await orch.configure(CONFIG);
    expect(fleet.start).toHaveBeenCalledTimes(1);

    await orch.setColumn('plan', 'playing');
    expect(fleet.start).toHaveBeenCalledTimes(2);
  });

  it('persists column state in chain.json, but the master always boots halted', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    const first = orchestrator();
    await first.orch.configure(CONFIG);
    await first.orch.setMaster('run');
    await first.orch.setColumn('plan', 'held');
    first.orch.dispose();

    const second = orchestrator();
    await second.orch.load();
    const status = second.orch.status();
    expect(status.configured).toBe(true);
    // "An" is a per-session decision: the persisted master never resumes.
    expect(status.master).toBe('halted');
    expect(status.columns['plan']).toBe('held');
    // Halted means: no dispatch on boot either.
    expect(second.fleet.records).toEqual([]);
    // The owner's session: An, then the column's state applies again.
    await second.orch.setMaster('run');
    await second.orch.setColumn('plan', 'playing');
    expect(second.fleet.records).toHaveLength(1);
    second.orch.dispose();
  });

  it('drops the control state of phases the pipeline no longer has', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'build');
    const first = orchestrator();
    await first.orch.configure(CONFIG);
    await first.orch.setMaster('run');
    await first.orch.setColumn('plan-review', 'held');
    await first.orch.setColumn('build', 'held');
    first.orch.dispose();

    // The owner removes the plan-review column from the pipeline.
    const withoutCheckpoint = PIPELINE.split('\n').filter((line) => !line.includes('id: plan-review')).join('\n');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), withoutCheckpoint, 'utf8');

    const second = orchestrator();
    await second.orch.load();
    // Loaded — the stale key survives until a pass has read the pipeline.
    expect(second.orch.status().columns['plan-review']).toBe('held');
    await second.orch.configure(CONFIG);
    const status = second.orch.status();
    expect(status.columns['plan-review']).toBeUndefined();
    const chain = JSON.parse(
      await fsp.readFile(path.join(fleetRoot, 'chain.json'), 'utf8'),
    ) as { columns: Record<string, string> };
    expect(chain.columns['plan-review']).toBeUndefined();
    // A phase the pipeline still has keeps its state.
    expect(status.columns['build']).toBe('held');
    second.orch.dispose();
  });

  it('a handover to a newer build is no new session: the successor keeps the master running', async () => {
    await writeMeta();
    let current = new Date('2026-10-31T15:04:18Z');
    const first = orchestrator({ now: () => current });
    await first.orch.configure(CONFIG);
    await first.orch.setMaster('run');
    await first.orch.markHandover();
    first.orch.dispose();

    const second = orchestrator({ now: () => current });
    await second.orch.load();
    expect(second.orch.status().master).toBe('run');
    second.orch.dispose();

    // The stamp is spent: a later cold boot starts halted again.
    current = new Date(current.getTime() + 60_000);
    const third = orchestrator({ now: () => current });
    await third.orch.load();
    expect(third.orch.status().master).toBe('halted');
    third.orch.dispose();
  });

  it('a run-settled hook triggers a fresh pass (the slot feeds the next ticket)', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(2);
    await orch.setMaster('halted');

    // T-0003 arrives externally; a settle fires the pass that takes it.
    await writeTicket('T-0003', 'plan');
    await orch.setMaster('run');
    await orch.onRunSettled({
      ...fleet.records[0]!.info,
      state: 'done',
    });
    await vi.waitFor(() => expect(fleet.records.length).toBeGreaterThanOrEqual(2));
  });

  it('a missing prompt file skips the candidate instead of dispatching blind', async () => {
    await writeMeta();
    await fsp.rm(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'plan-default.md'));
    await writeTicket('T-0001', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toEqual([]);
  });

  it('the circuit breaker trips on three red gates in a row: held column, candidate parked', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    let current = new Date('2026-10-18T12:00:00Z');
    const { orch, fleet } = orchestrator({ now: () => current });
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1);

    // Three red gates: each settle cools the column down; past the
    // cooldown the pass re-dispatches (the fake never moves the
    // ticket), the streak raises, and the third red trips the breaker.
    for (let i = 0; i < 3; i++) {
      const record = fleet.records.find((r) => r.info.state === 'running')!;
      const failed = { ...record.info, state: 'failed' as const, gateFailure: 'gate command failed' };
      fleet.records[fleet.records.indexOf(record)] = { ...record, info: failed };
      await orch.onRunSettled(failed);
      // Past the cooldown the next pass fires again (in production the
      // safety-net timer; here the master flip that always triggers one).
      current = new Date(current.getTime() + Math.max(RED_COOLDOWN_MS, failureBackoffMs(i + 1)) + 1_000);
      if (i < 2) {
        await orch.setMaster('halted');
        await orch.setMaster('run');
      }
    }

    expect(orch.status().columns['plan']).toBe('held');
    expect(orch.status().redStreak['plan']).toBe(3);
    expect(orch.status().tripped?.['plan']?.reason).toBe('3 red gates in a row');
    // The candidate moved to inbox, parked with the reason (file semantics).
    const parked = await fsp.readFile(await phasePath('inbox', 'T-0001'), 'utf8');
    expect(parked).toContain('parked-reason');
    expect(parked).toContain('circuit breaker');
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'))).rejects.toBeDefined();

    // The owner's play is a fresh start: trip and streak are gone.
    await orch.setColumn('plan', 'playing');
    expect(orch.status().tripped?.['plan']).toBeUndefined();
    expect(orch.status().redStreak['plan']).toBe(0);
  });

  it('a green gate resets the streak; the cooldown only breathes between reds', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');

    const record = fleet.records[0]!;
    fleet.records[0] = { ...record, info: { ...record.info, state: 'done' } };
    await orch.onRunSettled({ ...record.info, state: 'done' });
    expect(orch.status().redStreak['plan'] ?? 0).toBe(0);
    expect(orch.status().columns['plan'] ?? 'playing').toBe('playing');
  });

  it('a run that ends done but blocked holds its ticket — no re-dispatch into the same wall', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1);

    const record = fleet.records[0]!;
    const settled = { ...record.info, state: 'done' as const, blocked: 'merge conflict in specs/changelog.md' };
    fleet.records[0] = { ...record, info: settled };
    await orch.onRunSettled(settled);

    // The ticket waits for the owner: a pass triggered afresh (the
    // master flip) must not dispatch it again.
    await orch.setMaster('halted');
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1); // held like an owner-stopped run
  });

  it('a run that fails without a gate verdict backs off per ticket instead of re-dispatching at once', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    let current = new Date('2026-10-18T12:00:00Z');
    const { orch, fleet } = orchestrator({ now: () => current });
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1);

    const record = fleet.records[0]!;
    const failed = { ...record.info, state: 'failed' as const, lastError: 'spawn failed' };
    fleet.records[0] = { ...record, info: failed };
    await orch.onRunSettled(failed);
    expect(fleet.records).toHaveLength(1); // still backing off — no hot loop

    current = new Date(current.getTime() + failureBackoffMs(1) + 1_000);
    await orch.setMaster('halted');
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(2);
  });

  it('repeated non-gate failures park the failing ticket, not the first one in the column', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    let current = new Date('2026-10-18T12:00:00Z');
    const { orch, fleet } = orchestrator({ now: () => current });
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records.map((r) => r.info.ticketId).sort()).toEqual(['T-0001', 'T-0002']);

    for (let i = 0; i < 3; i++) {
      const record = fleet.records.find((r) => r.info.ticketId === 'T-0002' && r.info.state === 'running')!;
      const failed = { ...record.info, state: 'failed' as const, lastError: 'provider crashed' };
      fleet.records[fleet.records.indexOf(record)] = { ...record, info: failed };
      await orch.onRunSettled(failed);
      current = new Date(current.getTime() + failureBackoffMs(i + 1) + 1_000);
      if (i < 2) {
        await orch.setMaster('halted');
        await orch.setMaster('run');
      }
    }

    const parked = await fsp.readFile(await phasePath('inbox', 'T-0002'), 'utf8');
    expect(parked).toContain('parked-reason');
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'))).resolves.toBeUndefined();
  });

  it('a run the owner stopped is not re-dispatched while the ticket stays where it is', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    const current = new Date('2026-10-18T12:00:00Z');
    const { orch, fleet } = orchestrator({ now: () => current });
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1);

    const record = fleet.records[0]!;
    const stopped = { ...record.info, state: 'stopped' as const };
    fleet.records[0] = { ...record, info: stopped };
    await orch.onRunSettled(stopped);
    await orch.setMaster('halted');
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1);
  });

  it('a worker waiting on the owner frees its pool slot but keeps its ticket', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure({ ...CONFIG, pools: ONE });
    await orch.setMaster('run');
    expect(fleet.records).toHaveLength(1); // one slot, one worker

    const first = fleet.records[0]!;
    fleet.records[0] = {
      ...first,
      info: { ...first.info, turn: 'idle', waiting: { kind: 'question', text: 'Which one?', since: '2026-10-18T12:01:00Z' } },
    };
    await orch.setMaster('halted');
    await orch.setMaster('run');
    const tickets = fleet.records.map((r) => r.info.ticketId);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets).size).toBe(2); // the other ticket got the slot, the waiting one is not run twice
  });

  it('says once that the vault prompt is older than the shipped one, and never sends the marker to the model', async () => {
    await writeMeta(`<!-- drey-prompt-version: 1 -->${String.fromCharCode(10)}Work the plan step.`);
    await writeTicket('T-0001', 'plan');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({
      log: (message) => logs.push(message),
      shippedPrompt: async () => `<!-- drey-prompt-version: 2 -->${String.fromCharCode(10)}Work the plan step, better.`,
    });
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    const started = fleet.records[0]!;
    expect(started.request.instruction).toContain('Work the plan step.');
    expect(started.request.instruction).not.toContain('drey-prompt-version');
    const notes = logs.filter((line) => line.includes('older than the shipped default'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('v1 < v2');
    await orch.setMaster('halted');
    await orch.setMaster('run');
    expect(logs.filter((line) => line.includes('older than the shipped default'))).toHaveLength(1);
  });

  it('a failed-then-requeued ticket dispatches with the gate failure section (T-0048 retry)', async () => {
    await writeMeta();
    await writeTicket('T-0041', 'plan');
    const { orch, fleet } = orchestrator();
    // The ticket's previous run failed its gate and was requeued.
    fleet.records.push(failedRecord('T-0041', '`npm run verify:unit` failed\n\nkeep row 39\nkeep row 40'));
    await orch.configure(CONFIG);
    await orch.setMaster('run');

    const started = fleet.records.find((r) => r.info.state === 'running')!;
    expect(started.request.instruction).toContain('The previous run failed the machine gate — fix this first');
    expect(started.request.instruction).toContain('keep row 40');
    // The instruction keeps the context pack's order: the phase template
    // before the plan, the retry section in the variable parts.
    expect(started.request.instruction.indexOf('Work the plan step.')).toBeLessThan(
      started.request.instruction.indexOf('The previous run failed the machine gate'),
    );
    // T-0049: the dispatcher asks the supervisor's rules to decide.
    expect(started.request.handover).toBe('auto');
  });

  it('caps from the chain config reach the composed instruction', async () => {
    await writeMeta();
    await writeTicket('T-0042', 'plan');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
    const failure = [...Array(10).keys()].map((i) => `drop row ${i + 1}`).join('\n');
    fleet.records.push(failedRecord('T-0042', `\`npm test\` failed\n\n${failure}\nkeep row 10`));
    await orch.configure({
      ...CONFIG,
      caps: { gateFailureLines: 1, gateFailureBytes: 4_096, diffStatLines: 50, diffStatBytes: 4_096 },
    });
    await orch.setMaster('run');

    const started = fleet.records.find((r) => r.info.state === 'running')!;
    expect(started.request.instruction).toContain('keep row 10');
    expect(started.request.instruction).not.toContain('drop row 9');
    expect(logs.some((line) => line.includes('T-0042 gateFailure truncated: true, originalSize'))).toBe(true);
  });

  it('the lease reaper is reachable through the ports', async () => {
    const { orch, fleet } = orchestrator();
    await orch.reapAll();
    expect(fleet.port.reap).toHaveBeenCalled();
  });

  describe('the ci handover', () => {
    const CI_PIPELINE = PIPELINE.replace(
      '  - { id: plan-review, title: Plan review, handover: manual }',
      '  - { id: plan-review, title: Plan review, handover: ci, ci: npm run check }',
    );

    let seam: { execShell: (command: string, cwd: string) => Promise<void> };

    beforeEach(() => {
      seam = { execShell: async () => undefined };
    });

    async function writeCiMeta(green: boolean): Promise<void> {
      await writeMeta();
      await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), CI_PIPELINE, 'utf8');
      seam.execShell = async (command) => {
        if (!green) {
          throw new Error('exit 1\ncheck failed');
        }
        void command;
      };
    }

    it('a green check moves the ticket one column right (and stamps the claim)', async () => {
      await writeCiMeta(true);
      await writeTicket('T-0009', 'plan-review');
      const { orch } = orchestrator({
        scanIntervalMs: 20,
        execShell: (command, cwd) => seam.execShell(command, cwd),
      });
      await orch.configure(CONFIG);
      await orch.setMaster('run');
      await vi.waitFor(
        async () => {
          await expect(fsp.access(await phasePath('build', 'T-0009'))).resolves.toBeUndefined();
        },
        { timeout: 5_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      orch.dispose();
      const moved = await fsp.readFile(await phasePath('build', 'T-0009'), 'utf8');
      expect(moved).toContain('ci check passed');
      expect(moved).toContain('claimed-by'); // build claims
      await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan-review', 'T-0009.md'))).rejects.toBeDefined();
    });

    it('a red check backs the ticket off — it stays put and the retry waits', async () => {
      await writeCiMeta(false);
      await writeTicket('T-0009', 'plan-review');
      const { orch } = orchestrator({
        scanIntervalMs: 20,
        execShell: (command, cwd) => seam.execShell(command, cwd),
      });
      await orch.configure(CONFIG);
      await orch.setMaster('run');
      await vi.waitFor(
        async () => {
          const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'plan-review', 'T-0009.md'), 'utf8');
          expect(text).toContain('ci check failed');
        },
        { timeout: 5_000 },
      );
      // The backoff suppresses the next sweep ticks' retries (10 min).
      await new Promise((resolve) => setTimeout(resolve, 80));
      orch.dispose();
      await expect(fsp.access(await phasePath('build', 'T-0009'))).rejects.toBeDefined();
      const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'plan-review', 'T-0009.md'), 'utf8');
      expect(text).toContain('retry in 10 min');
    });
  });

  describe('E7 event writes (the ledger and the status seams)', () => {
    function fakeEvents() {
      return { ledger: vi.fn(), status: vi.fn() };
    }

    it('a dispatch writes the ledger dispatched line and the working status line', async () => {
      await writeMeta();
      await writeTicket('T-0001', 'plan');
      const events = fakeEvents();
      const { orch, fleet } = orchestrator({ events, cardPathOf: async () => null });
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      expect(fleet.records).toHaveLength(1);
      expect(events.ledger).toHaveBeenCalledTimes(1);
      expect(events.ledger).toHaveBeenCalledWith({
        kind: 'dispatched',
        ticket: 'T-0001',
        persona: null,
        model: 'zai/glm-5.3',
      });
      expect(events.status).toHaveBeenCalledTimes(1);
      expect(events.status).toHaveBeenCalledWith(
        'tickets/plan/T-0001.md',
        expect.any(String),
        'working',
        'plan on zai/glm-5.3',
      );
    });

    it('a run that ends done writes `done: handed over on <column>` to its card path', async () => {
      await writeMeta();
      await writeTicket('T-0001', 'plan');
      const events = fakeEvents();
      const cardPathOf = vi.fn(async (ticketId: string) => `tickets/plan/${ticketId}.md`);
      const { orch, fleet } = orchestrator({ events, cardPathOf });
      await orch.configure(CONFIG);
      await orch.setMaster('run');
      await orch.setMaster('halted'); // no re-dispatch on the settle pass

      const record = fleet.records[0]!;
      const settled = { ...record.info, state: 'done' as const };
      fleet.records[0] = { ...record, info: settled };
      await orch.onRunSettled(settled);

      expect(cardPathOf).toHaveBeenCalledWith('T-0001');
      expect(events.status).toHaveBeenLastCalledWith(
        'tickets/plan/T-0001.md',
        expect.any(String),
        'done',
        'handed over on plan',
      );
      expect(events.status).toHaveBeenCalledTimes(2); // working + done
    });

    it('a run that ends done but blocked writes `blocked:` with the worker reason', async () => {
      await writeMeta();
      await writeTicket('T-0001', 'plan');
      const events = fakeEvents();
      const { orch, fleet } = orchestrator({
        events,
        cardPathOf: async () => 'tickets/plan/T-0001.md',
      });
      await orch.configure(CONFIG);
      await orch.setMaster('run');
      await orch.setMaster('halted');

      const record = fleet.records[0]!;
      const settled = { ...record.info, state: 'done' as const, blocked: 'merge conflict in specs/changelog.md' };
      fleet.records[0] = { ...record, info: settled };
      await orch.onRunSettled(settled);

      expect(events.status).toHaveBeenLastCalledWith(
        'tickets/plan/T-0001.md',
        expect.any(String),
        'blocked',
        'merge conflict in specs/changelog.md',
      );
    });

    it('a failed run writes the short gate line, or the last error first line without a gate', async () => {
      await writeMeta();
      await writeTicket('T-0001', 'plan');
      const events = fakeEvents();
      const { orch, fleet } = orchestrator({
        events,
        cardPathOf: async () => 'tickets/plan/T-0001.md',
      });
      await orch.configure(CONFIG);
      await orch.setMaster('run');
      await orch.setMaster('halted');

      const record = fleet.records[0]!;
      const gated = { ...record.info, state: 'failed' as const, gateFailure: '`npm test` failed\n\noutput details' };
      fleet.records[0] = { ...record, info: gated };
      await orch.onRunSettled(gated);
      expect(events.status).toHaveBeenLastCalledWith('tickets/plan/T-0001.md', expect.any(String), 'failed', '`npm test` failed');

      const noGate = { ...record.info, state: 'failed' as const, gateFailure: null, lastError: 'spawn failed\nat somewhere' };
      fleet.records[0] = { ...record, info: noGate };
      await orch.onRunSettled(noGate);
      expect(events.status).toHaveBeenLastCalledWith('tickets/plan/T-0001.md', expect.any(String), 'failed', 'spawn failed');
    });

    it('absent seams stay silent: no cardPathOf means no settle line, no events means no writes at all', async () => {
      await writeMeta();
      await writeTicket('T-0001', 'plan');

      // Events wired, cardPathOf not: the dispatch lines still fire, the settle writes nothing.
      const withEvents = fakeEvents();
      const first = orchestrator({ events: withEvents });
      await first.orch.configure(CONFIG);
      await first.orch.setMaster('run');
      await first.orch.setMaster('halted');
      const dispatched = first.fleet.records[0]!;
      const settledDone = { ...dispatched.info, state: 'done' as const };
      first.fleet.records[0] = { ...dispatched, info: settledDone };
      await first.orch.onRunSettled(settledDone);
      expect(withEvents.ledger).toHaveBeenCalledTimes(1);
      expect(withEvents.status).toHaveBeenCalledTimes(1); // only the dispatch's working line

      // An unresolvable path is silent too.
      const unresolvable = fakeEvents();
      const second = orchestrator({ events: unresolvable, cardPathOf: async () => null });
      await second.orch.configure(CONFIG);
      await second.orch.setMaster('run');
      await second.orch.setMaster('halted');
      const record = second.fleet.records[0]!;
      const settled = { ...record.info, state: 'done' as const };
      second.fleet.records[0] = { ...record, info: settled };
      await second.orch.onRunSettled(settled);
      expect(unresolvable.status).toHaveBeenCalledTimes(1); // the dispatch line only

      // No events at all (the pre-E7 construction): everything stays silent.
      const silent = orchestrator();
      await silent.orch.configure(CONFIG);
      await silent.orch.setMaster('run');
      await silent.orch.setMaster('halted');
      const quietRecord = silent.fleet.records[0]!;
      const quietSettled = { ...quietRecord.info, state: 'done' as const };
      silent.fleet.records[0] = { ...quietRecord, info: quietSettled };
      await silent.orch.onRunSettled(quietSettled);
      expect(silent.fleet.records).toHaveLength(1);
    });
  });

  describe('scout dispatch (E8, concept §5.6)', () => {
    /** A scout ticket: `form: scout`, no acceptance criteria. */
    async function writeScoutTicket(id: string, phase: string, over: { repo?: string } = {}): Promise<void> {
      const rel = path.join(vaultDir, 'tickets', phase, `${id}.md`);
      await fsp.mkdir(path.dirname(rel), { recursive: true });
      const text = ticketText(id, phase)
        .replace('repo: drey', `repo: ${over.repo ?? 'drey'}\nform: scout`)
        .replace('- [ ] `npm run verify:unit` — exits 0\n', '');
      await fsp.writeFile(rel, text, 'utf8');
    }

    const SCOUT_PLAN_LINE =
      '  - { id: plan, title: Plan, handover: agent scout-default, worker: opencode, model: zai/glm-5.3 }';
    const PLAN_LINE =
      '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode, model: zai/glm-5.3 }';

    /** The plan column runs scout tickets on the shipped scout template. */
    async function writeScoutMeta(scoutPrompt = 'You are the scout of the pipeline.'): Promise<void> {
      await writeMeta();
      await fsp.writeFile(
        path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'),
        PIPELINE.replace(PLAN_LINE, SCOUT_PLAN_LINE),
        'utf8',
      );
      await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'scout-default.md'), scoutPrompt, 'utf8');
    }

    it('a scout ticket dispatches an exploration: the column template in the brief, no gate, no move', async () => {
      await writeScoutMeta();
      await writeScoutTicket('T-0004', 'plan');
      const logs: string[] = [];
      const events = { ledger: vi.fn(), status: vi.fn() };
      const { orch, fleet } = orchestrator({ log: (message) => logs.push(message), events, cardPathOf: async () => null });
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      expect(fleet.records).toHaveLength(1);
      const started = fleet.records[0]!;
      expect(started.request.form).toBe('scout');
      expect(started.request.gate).toBe('none');
      expect(started.request.acceptance).toEqual([]);
      expect(started.request.nextPhase).toBeNull();
      expect(started.request.nextPhaseDir).toBeNull();
      expect(started.request.worktreePath).toBe('W:/drey'); // the read ground
      // The column's scout template rides the brief, the built-in
      // exploration frame around it.
      expect(started.request.instruction).toContain('You are the scout of the pipeline.');
      expect(started.request.instruction).toContain('Scout discipline');
      expect(started.request.instruction).toContain('Read ground: W:/drey (the "drey" checkout)');
      expect(started.request.instruction).not.toContain('Completion discipline');
      expect(logs.some((line) => line.startsWith('dispatched T-0004') && line.includes('scout'))).toBe(true);
      // The E7 writes fire like for any dispatch.
      expect(events.ledger).toHaveBeenCalledWith({ kind: 'dispatched', ticket: 'T-0004', persona: null, model: 'zai/glm-5.3' });
    });

    it('a missing scout template skips the dispatch like any missing phase prompt', async () => {
      await writeScoutMeta();
      await fsp.rm(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'scout-default.md'));
      await writeScoutTicket('T-0004', 'plan');
      const logs: string[] = [];
      const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      expect(fleet.records).toHaveLength(0);
      expect(logs.some((line) => line.includes('dispatch skips T-0004') && line.includes('scout-default'))).toBe(true);
    });

    it('a scout ticket naming no repo explores the tickets vault itself', async () => {
      await writeMeta();
      await writeScoutTicket('T-0005', 'plan', { repo: '' });
      const { orch, fleet } = orchestrator();
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      expect(fleet.records).toHaveLength(1);
      const started = fleet.records[0]!;
      expect(started.request.worktreePath).toBe(vaultDir);
      expect(started.request.instruction).toContain(`Read ground: ${vaultDir} (the tickets vault)`);
    });

    it('a scout ticket with an unknown named repo is skipped, never guessed', async () => {
      await writeMeta();
      await writeScoutTicket('T-0006', 'plan', { repo: 'ghost' });
      const logs: string[] = [];
      const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      expect(fleet.records).toHaveLength(0);
      expect(logs.some((line) => line.includes('dispatch skips T-0006') && line.includes('ghost'))).toBe(true);
    });

    it('a persona scout signs the report and rides the dispatch like everywhere', async () => {
      await writeMeta();
      await fsp.writeFile(
        path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'),
        PIPELINE.replace(PLAN_LINE, `${PLAN_LINE.slice(0, -2)}, persona: pia }`),
        'utf8',
      );
      const dir = path.join(vaultDir, 'tickets', '_meta', 'personas', 'pia');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, 'persona.md'),
        [
          '---',
          'title: pia',
          'role: explorer',
          'worker: claude-code',
          'models:',
          '  default: sonnet',
          '  pool: [sonnet]',
          '  router: off',
          "color: '#a78bfa'",
          'skills: []',
          '---',
          '',
        ].join('\n'),
        'utf8',
      );
      await fsp.writeFile(path.join(dir, 'prompt.md'), 'You are Pia — explore thoroughly.', 'utf8');
      await writeScoutTicket('T-0007', 'plan');
      const { orch, fleet } = orchestrator();
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      const started = fleet.records[0]!;
      expect(started.request.provider).toBe('claude-code'); // the persona's harness
      expect(started.request.form).toBe('scout');
      expect(started.request.instruction).toContain('You are Pia — explore thoroughly.');
      expect(started.request.instruction).toContain('by pia.');
      expect(fleet.start.mock.calls[0]![1]).toEqual({ persona: 'pia' });
    });

    it('a settled scout run writes the done line that names the report card', async () => {
      await writeMeta();
      await writeScoutTicket('T-0004', 'plan');
      const events = { ledger: vi.fn(), status: vi.fn() };
      const { orch, fleet } = orchestrator({ events, cardPathOf: async () => 'tickets/plan/T-0004.md' });
      await orch.configure(CONFIG);
      await orch.setMaster('run');
      await orch.setMaster('halted'); // no re-dispatch on the settle pass

      const record = fleet.records[0]!;
      const settled = { ...record.info, state: 'done' as const, form: 'scout' as const };
      fleet.records[0] = { ...record, info: settled };
      await orch.onRunSettled(settled);

      expect(events.status).toHaveBeenLastCalledWith(
        'tickets/plan/T-0004.md',
        expect.any(String),
        'done',
        'scout report ready — the owner promotes from Needs you',
      );
    });
  });

  describe('persona dispatch (E3, ADR-0088)', () => {
    const PLAN_LINE =
      '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode, model: zai/glm-5.3 }';

    /** The plan column carries the phase persona. */
    async function writePersonaPipeline(): Promise<void> {
      await writeMeta();
      await fsp.writeFile(
        path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'),
        PIPELINE.replace(PLAN_LINE, `${PLAN_LINE.slice(0, -2)}, persona: pia }`),
        'utf8',
      );
    }

    async function writePersona(
      id: string,
      over: { worker?: string; model?: string; prompt?: string | null; memory?: string } = {},
    ): Promise<void> {
      const dir = path.join(vaultDir, 'tickets', '_meta', 'personas', id);
      await fsp.mkdir(dir, { recursive: true });
      const model = over.model ?? 'opus';
      await fsp.writeFile(
        path.join(dir, 'persona.md'),
        [
          '---',
          `title: ${id}`,
          'role: builder',
          `worker: ${over.worker ?? 'opencode'}`,
          'models:',
          `  default: ${model}`,
          `  pool: [${model}]`,
          '  router: off',
          "color: '#a78bfa'",
          'skills: []',
          '---',
          '',
        ].join('\n'),
        'utf8',
      );
      if (over.prompt != null) {
        await fsp.writeFile(path.join(dir, 'prompt.md'), over.prompt, 'utf8');
      }
      if (over.memory != null) {
        await fsp.writeFile(path.join(dir, 'memory.md'), over.memory, 'utf8');
      }
    }

    async function writePinnedTicket(id: string, phase: string, persona: string): Promise<void> {
      await writeTicket(id, phase);
      const rel = path.join(vaultDir, 'tickets', phase, `${id}.md`);
      await fsp.writeFile(rel, ticketText(id, phase).replace('repo: drey', `repo: drey\npersona: ${persona}`), 'utf8');
    }

    it('a resolved persona beats the assignment ring: harness, model, prompt, memory', async () => {
      await writePersonaPipeline();
      await writePersona('pia', {
        worker: 'claude-code',
        model: 'sonnet',
        prompt: 'You are Pia — plan with care.',
        memory: '# Memory\n\n- 2026-10-30 · T-0099 · handed-over · 900 tokens\n',
      });
      await writeTicket('T-0100', 'plan');
      const logs: string[] = [];
      const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      expect(fleet.records).toHaveLength(1);
      const started = fleet.records[0]!;
      // the legacy ring would have said opencode/zai-glm — the persona wins
      expect(started.request.provider).toBe('claude-code');
      expect(started.request.model).toBe('sonnet');
      expect(started.request.instruction).toContain('You are Pia — plan with care.');
      expect(started.request.instruction).not.toContain('Work the plan step.');
      // the persona's curated memory is the instruction's ## Memory slice
      expect(started.request.instruction).toContain('## Memory');
      expect(started.request.instruction).toContain('T-0099');
      // the resolved id rides the start options — RunInfo.persona stamps from it
      expect(fleet.start.mock.calls[0]![1]).toEqual({ persona: 'pia' });
      expect(logs.some((line) => line.startsWith('dispatched T-0100') && line.includes('persona pia'))).toBe(true);
    });

    it('the ladder: the ticket pin beats the phase persona', async () => {
      await writePersonaPipeline();
      await writePersona('pia', { worker: 'opencode', model: 'gpt-5' });
      await writePersona('tessa', { worker: 'claude-code', model: 'haiku' });
      await writePinnedTicket('T-0101', 'plan', 'tessa');
      const { orch, fleet } = orchestrator();
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      const started = fleet.records[0]!;
      expect(started.request.provider).toBe('claude-code'); // tessa's harness, not pia's
      expect(started.request.model).toBe('haiku');
      expect(fleet.start.mock.calls[0]![1]).toEqual({ persona: 'tessa' });
    });

    it('the ladder: the engine default persona applies when nothing else names one', async () => {
      await writeMeta(); // no persona anywhere in the pipeline
      await writePersona('pia', { worker: 'claude-code', model: 'sonnet' });
      await writeTicket('T-0102', 'plan');
      const { orch, fleet } = orchestrator();
      await orch.configure({ ...CONFIG, defaultPersona: 'pia' });
      await orch.setMaster('run');

      const started = fleet.records[0]!;
      expect(started.request.provider).toBe('claude-code');
      expect(fleet.start.mock.calls[0]![1]).toEqual({ persona: 'pia' });
    });

    it('a missing persona file falls back to the ring — byte for byte', async () => {
      await writePersonaPipeline();
      // no tickets/_meta/personas/ghost at all
      await writeTicket('T-0103', 'plan');
      const logs: string[] = [];
      const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      const started = fleet.records[0]!;
      expect(started.request.provider).toBe('opencode'); // the ring's column pin
      expect(started.request.model).toBe('zai/glm-5.3');
      expect(started.request.instruction).toContain('Work the plan step.');
      expect(fleet.start.mock.calls[0]![1]).toEqual({ persona: null });
      expect(logs.filter((line) => line.includes('"pia" is missing or invalid'))).toHaveLength(1);
    });

    it("a persona without a prompt.md keeps the phase template — and still beats the ring", async () => {
      await writePersonaPipeline();
      await writePersona('pia', { worker: 'claude-code', model: 'sonnet' }); // no prompt.md
      await writeTicket('T-0104', 'plan');
      const logs: string[] = [];
      const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
      await orch.configure(CONFIG);
      await orch.setMaster('run');

      const started = fleet.records[0]!;
      expect(started.request.provider).toBe('claude-code');
      expect(started.request.instruction).toContain('Work the plan step.');
      expect(started.request.instruction).not.toContain('## Memory');
      expect(fleet.start.mock.calls[0]![1]).toEqual({ persona: 'pia' });
      expect(logs.filter((line) => line.includes('has no prompt.md'))).toHaveLength(1);
    });

    it('the persona takes its own provider pool slot', async () => {
      await writePersonaPipeline();
      await writePersona('pia', { worker: 'claude-code', model: 'sonnet' });
      await writeTicket('T-0105', 'plan'); // persona → the claude-code pool
      await writeTicket('T-0106', 'build'); // the ring → the opencode pool
      const logs: string[] = [];
      const fleet = fakePort();
      // One claude-code slot, already taken: the persona ticket waits while
      // the ring ticket dispatches on the free opencode slot.
      fleet.records.push({
        info: {
          ...failedRecord('T-0098', '').info,
          id: 'R-seed',
          state: 'running',
          provider: 'claude-code',
        },
        request: { ticketId: 'T-0098', column: 'plan' } as RunRequest,
      });
      const orch = new Orchestrator({
        root: fleetRoot,
        log: (message) => logs.push(message),
        supervisorOf: () => fleet.port,
        scanIntervalMs: 60_000,
      });
      await orch.configure({
        ...CONFIG,
        pools: normalizeFleetPools({ opencode: { size: 1 }, 'claude-code': { size: 1 } }),
      });
      await orch.setMaster('run');

      expect(fleet.records.filter((r) => r.info.state === 'running' && r.info.id !== 'R-seed')).toHaveLength(1);
      expect(fleet.records.find((r) => r.info.id !== 'R-seed')!.request.ticketId).toBe('T-0106');
      const waits = logs.filter((line) => line.startsWith('dispatch waits'));
      expect(waits).toHaveLength(1);
      expect(waits[0]).toContain('T-0105');
      expect(waits[0]).toContain('no free claude-code pool slot yet');
    });
  });
});

describe('provider pools (req-63)', () => {
  const pools = normalizeFleetPools({ opencode: { size: 4 }, 'claude-code': { size: 2 } });

  it('normalizes sizes and probe URLs per provider', () => {
    expect(normalizeFleetPools(undefined)).toEqual({
      opencode: { size: 1, probeUrl: null },
      'claude-code': { size: 1, probeUrl: null },
    });
    expect(normalizeFleetPools({ opencode: { size: 0, probeUrl: 'ftp://x' } }).opencode).toEqual({
      size: 1,
      probeUrl: null,
    });
    expect(normalizeFleetPools({ opencode: { size: 3, probeUrl: ' http://h:8080 ' } }).opencode).toEqual({
      size: 3,
      probeUrl: 'http://h:8080',
    });
  });

  it('the effective size is capped by a probe and shrunk by a rate limit, never below one', () => {
    expect(effectivePoolSizes(pools, {}, {}, 0)).toEqual({ opencode: 4, 'claude-code': 2 });
    expect(effectivePoolSizes(pools, { opencode: 2 }, {}, 0).opencode).toBe(2);
    expect(effectivePoolSizes(pools, { opencode: 8 }, {}, 0).opencode).toBe(4);
    const shrink = { 'claude-code': { count: 5, untilMs: RATE_LIMIT_SHRINK_MS } };
    expect(effectivePoolSizes(pools, {}, shrink, 0)['claude-code']).toBe(1);
    expect(effectivePoolSizes(pools, {}, shrink, RATE_LIMIT_SHRINK_MS)['claude-code']).toBe(2);
  });

  it('a provider paused for its quota has no slot until the pause ends', () => {
    const paused = { opencode: QUOTA_PAUSE_MS };
    expect(effectivePoolSizes(pools, {}, {}, 0, paused).opencode).toBe(0);
    expect(effectivePoolSizes(pools, {}, {}, 0, paused)['claude-code']).toBe(2);
    expect(effectivePoolSizes(pools, {}, {}, QUOTA_PAUSE_MS, paused).opencode).toBe(4);
  });

  it('reads a spent usage quota', () => {
    expect(isQuotaError('provider.quota 429: Usage limit reached for 5 hour.')).toBe(true);
    expect(isQuotaError('insufficient_quota')).toBe(true);
    expect(isQuotaError('prompt failed: 429')).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it('reads 429 and rate-limit errors', () => {
    expect(isRateLimitError('prompt failed: 429')).toBe(true);
    expect(isRateLimitError('Error: rate_limit_error')).toBe(true);
    expect(isRateLimitError('Too Many Requests')).toBe(true);
    expect(isRateLimitError('prompt failed: 500')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});
