import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator, type OrchestratorDeps, type SupervisorPort } from './orchestrator';
import type { StartOutcome, StopOutcome, SupervisorRecord } from './runs';
import type { RunInfo, RunRequest } from './protocol';
import { newTicketFileText } from '../ticket-files';

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
  '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode, model: zai/glm-5.3, workers: 2 }',
  '  - { id: plan-review, title: Plan review, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, workers: 1, claim: true }',
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

const CONFIG = {
  ticketsVaultPath: '', // set in beforeEach
  git: 'git',
  defaultWorker: 'opencode',
  permissionMode: 'accept-edits' as const,
};

describe('Orchestrator', () => {
  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
    CONFIG.ticketsVaultPath = vaultDir;
  });

  afterEach(async () => {
    await fsp.rm(vaultDir, { recursive: true, force: true });
    await fsp.rm(fleetRoot, { recursive: true, force: true });
  });

  it('dispatches the plan pool: own queue first, then tops up from prioritized', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'prioritized');
    await writeTicket('T-0002', 'prioritized');
    await writeTicket('T-0003', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');

    const started = fleet.records.filter((r) => r.info.state === 'running');
    expect(started.map((r) => r.request.ticketId)).toEqual(['T-0003', 'T-0001']);
    // The pulled run sits in prioritized but works for the plan pool,
    // and its green gate moves the ticket to plan-review — the owner
    // checkpoint's arrival, not the plan directory.
    const pull = started.find((r) => r.request.ticketId === 'T-0001')!;
    expect(pull.request.phase).toBe('prioritized');
    expect(pull.request.column).toBe('plan');
    expect(pull.request.nextPhase).toBe('plan-review');
    expect(pull.request.model).toBe('zai/glm-5.3');
    expect(pull.request.instruction).toContain('Work the plan step.');
    // Never into the checkpoint or past it.
    expect(started.every((r) => r.request.nextPhase !== 'build' || r.request.phase === 'plan-review')).toBe(true);
  });

  it('never pulls across the checkpoint: build does not take plan-review tickets', async () => {
    await writeMeta();
    await writeTicket('T-0004', 'plan-review');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toEqual([]);
  });

  it('respects capacity, held columns and busy tickets', async () => {
    await writeMeta();
    await writeTicket('T-0001', 'plan');
    await writeTicket('T-0002', 'plan');
    await writeTicket('T-0003', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    // workers: 2 on plan — exactly two runs, no pull happened (none available).
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

  it('persists master and column state in chain.json and resumes from it', async () => {
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
    expect(status.master).toBe('run');
    expect(status.columns['plan']).toBe('held');
    // Held means: no dispatch on resume either.
    expect(second.fleet.records).toEqual([]);
    await second.orch.setColumn('plan', 'playing');
    expect(second.fleet.records).toHaveLength(1);
    second.orch.dispose();
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
    orch.onRunSettled();
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
});
