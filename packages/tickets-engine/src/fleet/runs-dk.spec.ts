import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketStoreError } from '../ports/ticket-store';
import type { ProviderAdapter, ProviderStart, WorkerHandle } from './providers';
import { RunSupervisor, type RunSupervisorDeps } from './runs';
import type { RunDkTarget, RunRequest, RunState } from './protocol';
import { FakeStore, FakeTimers } from './run-lease.fake';

/**
 * E14-5: the run supervisor on a dricket store. The store is a scripted fake (what `dk`
 * answers is dk's business, specified in dricket); what must hold here is the ORDER and the
 * ABSENCE: the claim comes before the worktree and the worker, the ticket is given up through
 * release (never a file write), exit 13 stops the worker, and nothing is written afterwards.
 */

interface Handle extends WorkerHandle {
  fail: (code: number | null) => void;
  result: (blocked?: string | null) => void;
}

function fakeAdapter(order: string[]): { adapter: ProviderAdapter; handles: Handle[]; starts: ProviderStart[] } {
  const handles: Handle[] = [];
  const starts: ProviderStart[] = [];
  const adapter: ProviderAdapter = {
    id: 'opencode',
    label: 'OpenCode',
    liveInject: true,
    spawn: (start) => {
      order.push('spawn');
      starts.push(start);
      let exit: ((code: number | null) => void) | null = null;
      const handle: Handle = {
        pid: 4242,
        exited: new Promise<number | null>((resolve) => {
          exit = resolve;
        }),
        steer: vi.fn(async () => 'inject' as const),
        setHold: vi.fn(),
        interrupt: vi.fn(async () => true),
        answerPermission: vi.fn(async () => true),
        answerQuestion: vi.fn(async () => true),
        stop: vi.fn(async () => {
          exit?.(null);
        }),
        fail: (code) => exit?.(code),
        result: (blocked) =>
          start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'result', text: 'done', ...(blocked !== undefined ? { blocked } : {}) }),
      };
      handles.push(handle);
      return handle;
    },
    attach: () => {
      throw new Error('not used');
    },
  };
  return { adapter, handles, starts };
}

const TARGET: RunDkTarget = {
  bin: 'dk',
  store: 'E:/store',
  dataDir: '',
  checkout: '',
  parkStage: null,
  retreatStage: 'prioritized',
  trailers: false,
};

let fleetRoot = '';
let vaultDir = '';
const settledRuns = new WeakMap<RunSupervisor, Set<string>>();

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'T-0001',
    ticketsVaultPath: vaultDir,
    ticketRelPath: 'tickets/build/T-0001.md',
    phase: 'build',
    repoPath: 'W:/kt',
    worktreePath: 'W:/fleet-worktrees/T-0001',
    branch: 't/T-0001',
    baseRef: null,
    provider: 'opencode',
    model: null,
    permissionMode: 'accept-edits',
    instruction: 'Do the ticket.',
    acceptance: ['npm run verify:unit'],
    gate: 'commands',
    git: 'git',
    nextPhase: 'commit',
    nextPhaseDir: 'commit',
    pushRemote: null,
    claimIdentity: null,
    dk: TARGET,
    ...overrides,
  };
}

function setup(overrides: Partial<RunSupervisorDeps> = {}) {
  const order: string[] = [];
  const store = new FakeStore();
  const timers = new FakeTimers();
  const adapter = fakeAdapter(order);
  const logs: string[] = [];
  const sup: RunSupervisor = new RunSupervisor({
    root: fleetRoot,
    adapter: adapter.adapter,
    git: 'git',
    log: (m) => logs.push(m),
    now: () => new Date('2026-10-17T12:00:00Z'),
    prepareWorktree: async () => {
      order.push('worktree');
      return { outcome: 'created', sessionInvalidated: false, movedTo: null };
    },
    execShell: async (command) => {
      order.push(`gate:${command}`);
    },
    storeFor: () => store,
    leaseTimers: timers,
    ...overrides,
    onRunSettled: (info) => {
      settledRuns.get(sup)?.add(info.id);
    },
  });
  settledRuns.set(sup, new Set());
  const original = store.claim.bind(store);
  store.claim = (id, options) => {
    order.push('claim');
    return original(id, options);
  };
  return { sup, store, timers, adapter, order, logs };
}

async function settled(sup: RunSupervisor, id: string, state: RunState): Promise<void> {
  await vi.waitFor(() => expect(settledRuns.get(sup)?.has(id) === true ? sup.get(id)?.state : 'not settled yet').toBe(state));
}

async function started(sup: RunSupervisor, req: RunRequest): Promise<string> {
  const outcome = await sup.start(req);
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.run.id;
}

describe('RunSupervisor on a dricket store (E14-5)', () => {
  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
  });
  afterEach(async () => {
    await fsp.rm(vaultDir, { recursive: true, force: true });
    await fsp.rm(fleetRoot, { recursive: true, force: true });
  });

  it('claims BEFORE the worktree and the worker, as a per-run owner', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    expect(t.order.slice(0, 3)).toEqual(['claim', 'worktree', 'spawn']);
    expect(t.store.of('claim')[0]?.actor).toMatch(/^agent-r-.*@/);
    expect(t.store.of('claim')[0]?.actor).toContain(id.toLowerCase());
    t.adapter.handles[0]!.fail(null);
    await settled(t.sup, id, 'failed');
  });

  it('a ticket someone else holds refuses the start: no worktree, no worker', async () => {
    const t = setup();
    t.store.failNext('claim', new TicketStoreError('claimed', 'ticket t-1 is claimed by henrik (lease until 2026-10-18T00:00:00Z)', 11));
    const outcome = await t.sup.start(request());
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false && outcome.error).toContain('claimed by henrik');
    expect(t.order).toEqual(['claim']);
    expect(t.adapter.handles).toHaveLength(0);
  });

  it('a green gate releases to the next phase with a comment - and writes no ticket file', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    t.adapter.handles[0]!.result();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'done');
    const releases = t.store.of('release');
    expect(releases.map((c) => c.stage)).toEqual(['commit']);
    expect(t.store.of('comment')[0]?.text).toContain('moving to commit');
    expect(t.store.calls.map((c) => c.op)).not.toContain('extend');
    expect(await fsp.readdir(vaultDir)).toEqual([]); // not a single ticket file, folder or commit
    expect(t.timers.armed).toBeNull(); // the keep-alive ended with the release
  });

  it('a red gate gives the ticket back where it came from (release is the one door)', async () => {
    const t = setup({
      execShell: async () => {
        throw Object.assign(new Error('boom'), { stdout: 'red', stderr: '' });
      },
    });
    const id = await started(t.sup, request());
    t.adapter.handles[0]!.result();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'failed');
    expect(t.store.of('release').map((c) => c.stage)).toEqual(['prioritized']); // preStage
    expect(t.store.of('comment')).toHaveLength(1);
  });

  it('a release that may not stay put retreats to the stage before the working one', async () => {
    const t = setup();
    t.store.stage = 'build'; // the ticket already sat in the claim stage
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null }));
    t.adapter.handles[0]!.fail(1); // no agent-done: the step fails
    await settled(t.sup, id, 'failed');
    expect(t.store.of('release').map((c) => c.stage)).toEqual(['build', 'prioritized']);
  });

  it('park = the park stage plus a comment; without a park stage the ticket keeps its own', async () => {
    const withStage = setup();
    const id = await started(withStage.sup, request({ nextPhase: null, nextPhaseDir: null, parkFor: 'owner', dk: { ...TARGET, parkStage: 'inbox' } }));
    withStage.adapter.handles[0]!.result();
    withStage.adapter.handles[0]!.fail(0);
    await settled(withStage.sup, id, 'done');
    expect(withStage.store.of('release')[0]?.stage).toBe('inbox');
    expect(withStage.store.of('comment')[0]?.text).toContain('parked for owner');

    const without = setup();
    const id2 = await started(without.sup, request({ nextPhase: null, nextPhaseDir: null, parkFor: 'owner' }));
    without.adapter.handles[0]!.result();
    without.adapter.handles[0]!.fail(0);
    await settled(without.sup, id2, 'done');
    expect(without.store.of('release')[0]?.stage).toBe('prioritized');
  });

  it('a stage the store does not have falls back to the ticket\'s own stage', async () => {
    const t = setup();
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null, parkFor: 'owner', dk: { ...TARGET, parkStage: 'blocked' } }));
    t.adapter.handles[0]!.result();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'done');
    expect(t.store.of('release').map((c) => c.stage)).toEqual(['blocked', 'prioritized']);
  });

  it('a worker that declares itself blocked releases the claim with its words as the comment', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    t.adapter.handles[0]!.result('BLOCKED: needs the API key');
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'done');
    expect(t.store.of('comment')[0]?.text).toContain('needs the API key');
    expect(t.store.of('release')).toHaveLength(1);
    expect(t.order.filter((o) => o.startsWith('gate:'))).toEqual([]); // no gate on a blocked end
  });

  it('exit 13 on an extension stops the worker, fails the run and writes nothing more', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    t.store.loseClaim();
    await t.timers.fire();
    await settled(t.sup, id, 'failed');
    expect(t.adapter.handles[0]!.stop).toHaveBeenCalled();
    expect(t.store.of('release')).toHaveLength(0);
    expect(t.store.of('comment')).toHaveLength(0);
    expect(t.sup.get(id)?.gateFailure).toContain('claim lost');
  });

  it('exit 13 on the release (taken over during the gate) is a failed move, never a second write', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    t.adapter.handles[0]!.result();
    t.store.loseClaim();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'failed');
    expect(t.store.of('release')).toHaveLength(0);
  });

  it('trailers: the worker is told the epoch and a trailer-less branch is a red gate', async () => {
    const validate = vi.fn(async () => 'commit abc123 has no Dricket-Epoch trailer');
    const t = setup({ validateTrailers: validate });
    const id = await started(t.sup, request({ baseRef: 'main', dk: { ...TARGET, trailers: true } }));
    const instruction = t.adapter.starts[0]!.instruction;
    expect(instruction).toContain('Dricket-Ticket: t-1');
    expect(instruction).toContain('Dricket-Epoch: 1');
    expect(instruction).toContain('Dricket-Actor: agent-r-');
    t.adapter.handles[0]!.result();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'failed');
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ trailers: true }), 'W:/fleet-worktrees/T-0001', 'main..HEAD');
    expect(t.sup.get(id)?.gateFailure).toContain('no Dricket-Epoch trailer');
    expect(t.store.of('release').map((c) => c.stage)).toEqual(['prioritized']);
  });

  it('without a dk target nothing changes: no store call at all', async () => {
    const t = setup();
    const req = request();
    const { dk: _dk, ...legacy } = req;
    void _dk;
    const ticketRel = 'tickets/build/T-0001.md';
    await fsp.mkdir(path.join(vaultDir, 'tickets', 'build'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, ticketRel), '---\nid: T-0001\n---\n', 'utf8');
    const id = await started(t.sup, legacy);
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
    expect(t.store.calls).toEqual([]);
  });
});
