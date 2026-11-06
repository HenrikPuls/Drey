import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator, type OrchestratorDeps, type SupervisorPort } from './orchestrator';
import type { StartOutcome, StopOutcome, SupervisorRecord } from './runs';
import { normalizeFleetPools, type RunInfo, type RunRequest } from './protocol';
import { newTicketFileText } from '../core/ticket-files';

/**
 * The Autopilot over the chain master (req-95) against a real tickets
 * vault and a fake supervisor: what each state dispatches, the boot rule
 * over `chain.json`, and the resume time firing on the scan tick.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, worker: opencode }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  '',
].join('\n');
const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.test/drey.git', '    branch: main', '    path: W:/drey', '---', ''].join('\n');

const NOON = new Date('2026-11-06T12:00:00Z');
const AT_SIX = '2026-11-06T18:00:00.000Z';

let vaultDir = '';
let fleetRoot = '';

function config(): Parameters<Orchestrator['configure']>[0] {
  return {
    ticketsVaultPath: vaultDir,
    git: 'git',
    defaultWorker: 'opencode',
    permissionMode: 'accept-edits',
    pools: normalizeFleetPools({ opencode: { size: 1 } }),
  };
}

async function writeTicket(id: string): Promise<void> {
  const file = path.join(vaultDir, 'tickets', 'plan', `${id}.md`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    newTicketFileText({ id, title: id, repo: 'drey', priority: 'normal', rank: 5000, firstPhase: 'plan', now: NOON, actor: 'owner@box', description: 'x' }),
    'utf8',
  );
}

function fakePort(): { port: SupervisorPort; records: SupervisorRecord[] } {
  const records: SupervisorRecord[] = [];
  const port: SupervisorPort = {
    start: vi.fn(async (request: RunRequest): Promise<StartOutcome> => {
      const info = {
        id: `R-${records.length + 1}`,
        ticketId: request.ticketId,
        provider: request.provider,
        state: 'running',
        startedAt: NOON.toISOString(),
        endedAt: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: null,
        gateFailure: null,
      } as unknown as RunInfo;
      records.push({ info, request });
      return { ok: true, run: info };
    }),
    stop: vi.fn(async (runId: string): Promise<StopOutcome> => {
      const index = records.findIndex((r) => r.info.id === runId);
      records[index] = { ...records[index]!, info: { ...records[index]!.info, state: 'stopped' } };
      return { ok: true };
    }),
    records: () => [...records],
    reap: vi.fn(async (): Promise<void> => undefined),
  };
  return { port, records };
}

/** An orchestrator whose clock the spec moves. */
function build(over: Partial<OrchestratorDeps> = {}): {
  orch: Orchestrator;
  fleet: ReturnType<typeof fakePort>;
  clock: { now: Date };
  logs: string[];
} {
  const fleet = fakePort();
  const clock = { now: NOON };
  const logs: string[] = [];
  const orch = new Orchestrator({
    root: fleetRoot,
    log: (message) => logs.push(message),
    supervisorOf: () => fleet.port,
    scanIntervalMs: 60_000,
    now: () => clock.now,
    ...over,
  });
  return { orch, fleet, clock, logs };
}

const chainFile = async (): Promise<{ master: string; autopilot?: unknown }> =>
  JSON.parse(await fsp.readFile(path.join(fleetRoot, 'chain.json'), 'utf8')) as { master: string; autopilot?: unknown };

describe('the Autopilot', () => {
  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-autopilot-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-autopilot-fleet-'));
    await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'prompts'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'repos.md'), REPOS, 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'prompts', 'plan-default.md'), 'Plan it.', 'utf8');
    await writeTicket('T-0001');
    await writeTicket('T-0002');
  });

  afterEach(async () => {
    await fsp.rm(vaultDir, { recursive: true, force: true });
    await fsp.rm(fleetRoot, { recursive: true, force: true });
  });

  describe('transitions', () => {
    it('starts Off: nothing dispatches, the master is halted', async () => {
      const { orch, fleet } = build();
      const status = await orch.configure(config());
      expect(status.autopilot).toEqual({ state: 'off' });
      expect(status.master).toBe('halted');
      expect(fleet.records).toEqual([]);
      orch.dispose();
    });

    it('On derives run and dispatches at once', async () => {
      const { orch, fleet } = build();
      await orch.configure(config());
      const status = await orch.setAutopilot({ state: 'on' });
      expect(status.master).toBe('run');
      expect(status.autopilot).toEqual({ state: 'on' });
      expect(fleet.records).toHaveLength(1);
      orch.dispose();
    });

    it('Paused lets the running step finish and starts nothing new', async () => {
      const { orch, fleet } = build();
      await orch.configure(config());
      await orch.setAutopilot({ state: 'on' });
      const status = await orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });
      expect(status.master).toBe('halted');
      expect(status.autopilot).toEqual({ state: 'paused', resumeAt: AT_SIX });
      expect(fleet.port.stop).not.toHaveBeenCalled();
      expect(fleet.records[0]!.info.state).toBe('running');

      fleet.records[0] = { ...fleet.records[0]!, info: { ...fleet.records[0]!.info, state: 'done' } };
      await orch.onRunSettled(fleet.records[0]!.info);
      await orch.configure(config());
      expect(fleet.records).toHaveLength(1);
      orch.dispose();
    });

    it('Off halts the same way and leaves a running step alone', async () => {
      const { orch, fleet } = build();
      await orch.configure(config());
      await orch.setAutopilot({ state: 'on' });
      const status = await orch.setAutopilot({ state: 'off' });
      expect(status.master).toBe('halted');
      expect(fleet.port.stop).not.toHaveBeenCalled();
      orch.dispose();
    });

    it('On after Paused cancels the resume time and dispatches', async () => {
      const { orch, fleet, clock } = build();
      await orch.configure(config());
      await orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });
      const status = await orch.setAutopilot({ state: 'on' });
      expect(status.autopilot).toEqual({ state: 'on' });
      expect(fleet.records).toHaveLength(1);
      await orch.setAutopilot({ state: 'off' });
      clock.now = new Date(AT_SIX);
      await orch.resumeIfDue();
      expect(orch.status().autopilot).toEqual({ state: 'off' });
      orch.dispose();
    });

    it('the master API keeps working: run is On, halted is Off and ends a pending resume', async () => {
      const { orch, clock } = build();
      await orch.configure(config());
      expect((await orch.setMaster('run')).autopilot).toEqual({ state: 'on' });
      await orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });
      expect((await orch.setMaster('halted')).autopilot).toEqual({ state: 'off' });
      clock.now = new Date(AT_SIX);
      await orch.resumeIfDue();
      expect(orch.status().master).toBe('halted');
      orch.dispose();
    });

    it('stop-now aborts every live run and ends as Off, from any state', async () => {
      const { orch, fleet, clock } = build();
      await orch.configure(config());
      await orch.setAutopilot({ state: 'on' });
      await orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });
      const status = await orch.abortAll();
      expect(fleet.port.stop).toHaveBeenCalledTimes(1);
      expect(status.autopilot).toEqual({ state: 'off' });
      expect(await chainFile()).toMatchObject({ master: 'halted', autopilot: { state: 'off' } });
      clock.now = new Date(AT_SIX);
      await orch.resumeIfDue();
      expect(fleet.records).toHaveLength(1);
      orch.dispose();
    });

    it('persists the record beside the derived master', async () => {
      const { orch } = build();
      await orch.configure(config());
      await orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });
      expect(await chainFile()).toMatchObject({ master: 'halted', autopilot: { state: 'paused', resumeAt: AT_SIX } });
      await orch.setAutopilot({ state: 'on' });
      expect(await chainFile()).toMatchObject({ master: 'run', autopilot: { state: 'on' } });
      orch.dispose();
    });

    it('On and Paused keep the runner from its idle shutdown, Off does not', async () => {
      const { orch } = build();
      await orch.setAutopilot({ state: 'on' });
      expect(orch.keepsRunnerAlive).toBe(false); // no chain config yet: nothing to drain
      await orch.configure(config());
      expect(orch.keepsRunnerAlive).toBe(true);
      await orch.setAutopilot({ state: 'paused' });
      expect(orch.keepsRunnerAlive).toBe(true);
      expect(orch.active).toBe(false);
      await orch.setAutopilot({ state: 'off' });
      expect(orch.keepsRunnerAlive).toBe(false);
      orch.dispose();
    });
  });

  describe('the resume time', () => {
    it('does nothing before its time, turns On and dispatches once it has come', async () => {
      const { orch, fleet, clock, logs } = build();
      await orch.configure(config());
      await orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });

      clock.now = new Date(Date.parse(AT_SIX) - 1);
      await orch.resumeIfDue();
      expect(orch.status().autopilot).toEqual({ state: 'paused', resumeAt: AT_SIX });
      expect(fleet.records).toEqual([]);

      clock.now = new Date(AT_SIX);
      await orch.resumeIfDue();
      expect(orch.status().autopilot).toEqual({ state: 'on' });
      expect(orch.status().master).toBe('run');
      expect(fleet.records).toHaveLength(1);
      expect(await chainFile()).toMatchObject({ master: 'run', autopilot: { state: 'on' } });
      expect(logs).toContain(`autopilot: paused until ${AT_SIX}`);
      expect(logs).toContain('autopilot: on');
      orch.dispose();
    });

    it('a Paused without a time waits for the owner', async () => {
      const { orch, clock } = build();
      await orch.configure(config());
      await orch.setAutopilot({ state: 'paused' });
      clock.now = new Date('2030-01-01T00:00:00Z');
      await orch.resumeIfDue();
      expect(orch.status().autopilot).toEqual({ state: 'paused' });
      orch.dispose();
    });

    it('fires on the scan tick by itself', async () => {
      const { orch, fleet, clock } = build({ scanIntervalMs: 5 });
      await orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });
      await orch.configure(config());
      clock.now = new Date(AT_SIX);
      await vi.waitFor(() => expect(fleet.records).toHaveLength(1));
      expect(orch.status().autopilot).toEqual({ state: 'on' });
      await orch.setAutopilot({ state: 'off' });
      orch.dispose();
    });
  });

  describe('the boot rule', () => {
    async function persisted(autopilot: unknown, master: string, handoverAt?: string): Promise<void> {
      await fsp.writeFile(
        path.join(fleetRoot, 'chain.json'),
        JSON.stringify({ version: 1, config: config(), master, autopilot, columns: {}, redStreak: {}, cooldownUntil: {}, tokensDay: {}, tokensUsed: {}, ciBackoff: {}, handoverAt }),
        'utf8',
      );
    }

    it('On comes back as Off, on disk too', async () => {
      await persisted({ state: 'on' }, 'run');
      const { orch, fleet } = build();
      await orch.load();
      expect(orch.status().autopilot).toEqual({ state: 'off' });
      expect(orch.status().master).toBe('halted');
      expect(fleet.records).toEqual([]);
      expect(await chainFile()).toMatchObject({ master: 'halted', autopilot: { state: 'off' } });
      orch.dispose();
    });

    it('a Paused whose time has not passed comes back as Off, and the time never fires', async () => {
      await persisted({ state: 'paused', resumeAt: AT_SIX }, 'halted');
      const { orch, fleet, clock, logs } = build();
      await orch.load();
      expect(orch.status().autopilot).toEqual({ state: 'off' });
      expect(await chainFile()).toMatchObject({ autopilot: { state: 'off' } });
      expect(logs.some((line) => line.includes('boot rule'))).toBe(true);
      clock.now = new Date(AT_SIX);
      await orch.resumeIfDue();
      expect(orch.status().autopilot).toEqual({ state: 'off' });
      expect(fleet.records).toEqual([]);
      orch.dispose();
    });

    it('a Paused whose time passed while the runner was down comes back as Off too, never On', async () => {
      await persisted({ state: 'paused', resumeAt: '2026-11-06T11:00:00.000Z' }, 'halted');
      const { orch } = build();
      await orch.load();
      expect(orch.status().autopilot).toEqual({ state: 'off' });
      orch.dispose();
    });

    it('an older file without the record reads through its master', async () => {
      await persisted(undefined, 'run');
      const first = build();
      await first.orch.load();
      expect(first.orch.status().autopilot).toEqual({ state: 'off' });
      first.orch.dispose();

      await persisted(undefined, 'run', NOON.toISOString());
      const second = build();
      await second.orch.load();
      expect(second.orch.status().autopilot).toEqual({ state: 'on' });
      second.orch.dispose();
    });
  });

  describe('a handover to a newer build is no start', () => {
    it('Paused and its time go on under the successor, and the stamp is spent', async () => {
      const first = build();
      await first.orch.configure(config());
      await first.orch.setAutopilot({ state: 'paused', resumeAt: AT_SIX });
      await first.orch.markHandover();
      first.orch.dispose();

      const second = build();
      await second.orch.load();
      expect(second.orch.status().autopilot).toEqual({ state: 'paused', resumeAt: AT_SIX });
      second.clock.now = new Date(AT_SIX);
      await second.orch.resumeIfDue();
      expect(second.orch.status().autopilot).toEqual({ state: 'on' });
      expect(second.fleet.records).toHaveLength(1);
      await second.orch.setAutopilot({ state: 'paused', resumeAt: '2026-11-07T18:00:00.000Z' });
      second.orch.dispose();

      const third = build();
      await third.orch.load();
      expect(third.orch.status().autopilot).toEqual({ state: 'off' });
      third.orch.dispose();
    });
  });
});
