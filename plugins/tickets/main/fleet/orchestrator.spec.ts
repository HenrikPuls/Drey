import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  effectivePoolSizes,
  isQuotaError,
  isRateLimitError,
  Orchestrator,
  QUOTA_PAUSE_MS,
  RATE_LIMIT_SHRINK_MS,
  RED_COOLDOWN_MS,
  type OrchestratorDeps,
  type SupervisorPort,
} from './orchestrator';
import type { StartOutcome, StopOutcome, SupervisorRecord } from './runs';
import { normalizeFleetPools, type FleetPools, type RunInfo, type RunRequest } from './protocol';
import { newTicketFileText } from '../ticket-files';
import { listTicketDirs } from '../phase-dirs';
import { stripPhasePrefix } from '../../shared/tickets';

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
  const port: SupervisorPort = {
    start: vi.fn(async (request: RunRequest): Promise<StartOutcome> => {
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
    }),
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
  return { port, records, start: port.start, stop: port.stop };
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
    request: { ticketId: ticket } as RunRequest,
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
      current = new Date(current.getTime() + RED_COOLDOWN_MS + 1_000);
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
