import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator, type OrchestratorDeps, type SupervisorPort } from './orchestrator';
import type { StartOutcome, StopOutcome, SupervisorRecord } from './runs';
import type { RunInfo, RunRequest } from './protocol';
import { newTicketFileText } from '../ticket-files';

/**
 * The fleet respects blocked-by (T-0050): the real orchestrator over a
 * REAL tickets vault (temp dir) and a fake supervisor port — a blocked
 * ticket is never picked by a worker column; the chain log says why.
 */

let vaultDir = '';
let fleetRoot = '';

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode, workers: 2 }',
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

function ticketText(id: string, phase: string, extra: readonly string[] = [], rank = 5000): string {
  return newTicketFileText({
    id,
    title: `Ticket ${id}`,
    repo: 'drey',
    priority: 'normal',
    rank,
    firstPhase: phase,
    now: new Date('2026-10-29T10:00:00Z'),
    actor: 'owner@box',
    description: 'It should work.',
  })
    .replace(
      'Executable checks as backticked checkbox lines; the machine gate runs them.',
      '- [ ] `npm run verify:unit` — exits 0',
    )
    .replace(
      `branch: t/${id}\n`,
      extra.length === 0 ? `branch: t/${id}\n` : `branch: t/${id}\n${extra.join('\n')}\n`,
    );
}

async function writeTicket(
  id: string,
  phase: string,
  extra: readonly string[] = [],
  rank = 5000,
): Promise<void> {
  const rel = path.join(vaultDir, 'tickets', phase, `${id}.md`);
  await fsp.mkdir(path.dirname(rel), { recursive: true });
  await fsp.writeFile(rel, ticketText(id, phase, extra, rank), 'utf8');
}

async function writeMeta(): Promise<void> {
  await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'prompts'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'repos.md'), REPOS, 'utf8');
  await fsp.writeFile(
    path.join(vaultDir, 'tickets', '_meta', 'prompts', 'plan-default.md'),
    'Work the plan step.',
    'utf8',
  );
  await fsp.writeFile(
    path.join(vaultDir, 'tickets', '_meta', 'prompts', 'build-default.md'),
    'Build it.',
    'utf8',
  );
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
        startedAt: '2026-10-29T12:00:00Z',
        endedAt: null,
        sessionRef: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: null,
        lastActivity: '2026-10-29T12:00:00Z',
        steerCount: 0,
        lastSteerRung: null,
        worktreePath: 'W:/wt',
        branch: request.branch,
        gateFailure: null,
      };
      records.push({ info, request });
      return { ok: true, run: info };
    }),
    stop: vi.fn(async (runId: string, _reason: string | null): Promise<StopOutcome> => {
      const index = records.findIndex((r) => r.info.id === runId);
      if (index >= 0) {
        records[index] = { ...records[index]!, info: { ...records[index]!.info, state: 'stopped' } };
      }
      return { ok: true };
    }),
    records: () => [...records],
    reap: vi.fn(async (): Promise<void> => undefined),
  };
  return { port, records };
}

function orchestrator(over: Partial<OrchestratorDeps> = {}): { orch: Orchestrator; fleet: ReturnType<typeof fakePort> } {
  const fleet = fakePort();
  const orch = new Orchestrator({
    root: fleetRoot,
    log: () => undefined,
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

describe('the fleet respects blocked-by (T-0050)', () => {
  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
    CONFIG.ticketsVaultPath = vaultDir;
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

  it('a pass starts only the free ticket and logs the blocked id with its blockers', async () => {
    await writeMeta();
    await writeTicket('T-0002', 'build'); // the blocker — nowhere near done
    // The blocked ticket sorts ABOVE the free one (the id tiebreak).
    await writeTicket('T-0001', 'plan', ['blocked-by: [T-0002]']);
    await writeTicket('T-0003', 'plan');
    const logs: string[] = [];
    const { orch, fleet } = orchestrator({ log: (message) => logs.push(message) });
    await orch.configure(CONFIG);
    await orch.setMaster('run');

    const started = fleet.records.filter((r) => r.info.state === 'running');
    // The plan pool takes only the free ticket; the blocker itself may
    // run in its own build pool — it is not the blocked one.
    expect(started.filter((r) => r.request.column === 'plan').map((r) => r.request.ticketId)).toEqual([
      'T-0003',
    ]);
    expect(started.map((r) => r.request.ticketId)).toContain('T-0002');
    const holds = logs.filter((line) => line.includes('T-0001'));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toContain('blocked by T-0002');
    orch.dispose();
  });

  it('with the blocker in done, the blocked ticket dispatches', async () => {
    await writeMeta();
    await writeTicket('T-0002', 'done');
    await writeTicket('T-0001', 'plan', ['blocked-by: [T-0002]']);
    await writeTicket('T-0003', 'plan');
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records.filter((r) => r.info.state === 'running').map((r) => r.request.ticketId)).toEqual([
      'T-0001',
      'T-0003',
    ]);
    orch.dispose();
  });

  it('a claim or a live run stamp on the blocker changes nothing — only the phase matters', async () => {
    await writeMeta();
    await writeTicket('T-0002', 'build', [
      "claimed-by: 'worker@box'",
      "claimed-at: '2026-10-29T11:00:00Z'",
      "run: {pid: 1, 'started-at': '2026-10-29T11:00:00Z', stream: R-001}",
    ]);
    await writeTicket('T-0001', 'plan', ['blocked-by: [T-0002]']);
    const { orch, fleet } = orchestrator();
    await orch.configure(CONFIG);
    await orch.setMaster('run');
    expect(fleet.records).toEqual([]);
    orch.dispose();
  });
});
