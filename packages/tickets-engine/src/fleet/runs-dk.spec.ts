import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketStoreError } from '../ports/ticket-store';
import type { ProviderAdapter, ProviderStart, WorkerHandle } from './providers';
import { RunSupervisor, type RunSupervisorDeps } from './runs';
import type { RunDkTarget, RunRequest } from './protocol';
import { drainSupervisors, markSettled, settled, trackSupervisor, waitFor } from './run-spec-support';
import { FakeStore, FakeTimers } from './run-lease.fake';
import { runOwnerId } from './run-lease';

const runOwnerHost = (): string => runOwnerId('x').slice('agent-x@'.length);

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

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    origin: 'spec',
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
      markSettled(sup, info.id);
    },
  });
  trackSupervisor(sup);
  const original = store.claim.bind(store);
  store.claim = (id, options) => {
    order.push('claim');
    return original(id, options);
  };
  return { sup, store, timers, adapter, order, logs };
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
    await drainSupervisors();
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
    expect(t.store.of('comment')[0]?.text).toMatch(/^done: handed over on /); // E14-6: the keyed status verb leads
    expect(t.store.calls.map((c) => c.op)).not.toContain('extend');
    expect((await fsp.readdir(vaultDir)).filter((name) => name !== '_worktrees')).toEqual([]); // not a single ticket file or commit (D-30)
    expect(await fsp.readdir(path.join(vaultDir, '_worktrees')).catch(() => [])).toEqual([]); // the working copy went with the run
    expect(t.timers.armed).toBeNull(); // the keep-alive ended with the release
  });

  it('the worker gets a working copy of the ticket, and what it changed lands in the store before the release (D-30)', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    const copy = path.join(vaultDir, '_worktrees', 'T-0001.ticket.md');
    expect(await fsp.readFile(copy, 'utf8')).toBe(t.store.text);
    expect(t.order.indexOf('spawn')).toBeGreaterThan(t.order.indexOf('claim'));
    await fsp.writeFile(copy, t.store.text.replace('## Log', '## Handover\n\nState: done\n\n## Log').replace('stage: prioritized', 'stage: done'), 'utf8');
    t.adapter.handles[0]!.result();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'done');
    expect(t.store.text).toContain('## Handover\n\nState: done');
    expect(t.store.text).not.toContain('stage: done'); // the worker's frontmatter does not count
    const ops = t.store.calls.map((c) => c.op);
    expect(ops.indexOf('put')).toBeLessThan(ops.lastIndexOf('release'));
    await expect(fsp.access(copy)).rejects.toThrow();
  });

  it('a plan run gates on the criteria the worker wrote into its copy (D-30, E14-5c)', async () => {
    const t = setup();
    const id = await started(t.sup, request({ gate: 'structural', acceptance: [] }));
    const copy = path.join(vaultDir, '_worktrees', 'T-0001.ticket.md');
    await fsp.writeFile(copy, t.store.text.replace('## Log', '## Plan\n\n### Acceptance criteria\n\n- [ ] \`echo ok\`\n\n## Log'), 'utf8');
    t.adapter.handles[0]!.result();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'done');
    expect(t.store.of('release').map((c) => c.stage)).toEqual(['commit']);
  });

  it('a stopped run still hands back what the worker wrote (D-30)', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    const copy = path.join(vaultDir, '_worktrees', 'T-0001.ticket.md');
    await fsp.writeFile(copy, t.store.text.replace('## Log', '## Handover\n\nState: blocked\n\n## Log'), 'utf8');
    await t.sup.stop(id, 'owner');
    await settled(t.sup, id, 'stopped');
    expect(t.store.text).toContain('State: blocked');
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
    expect(t.store.of('comment')[0]?.text).toMatch(/^failed: /);
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
    expect(t.store.of('comment')[0]?.text).toMatch(/^blocked: \[run-[a-z0-9-]+\] BLOCKED: needs the API key/); // a closable key, the worker's words
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

  it('R-31: a failed run that sat in the claim stage ends where it sat - release back, then put --claim writes the stage back', async () => {
    const t = setup();
    t.store.stage = 'build';
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null }));
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
    expect(t.store.of('release').map((c) => c.stage)).toEqual(['build', 'prioritized']);
    const puts = t.store.of('put');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.put).toMatchObject({ expectedRev: 4 }); // the ticket is nobody's now: a normal put --claim --if-version
    expect(puts[0]?.put?.holdsClaim).not.toBe(true);
    expect(t.store.stage).toBe('build');
  });

  it('a retreat whose write-back fails leaves the ticket in the retreat stage (and the run still settles)', async () => {
    const t = setup();
    t.store.stage = 'build';
    t.store.failNext('put', new TicketStoreError('invalid', 'put refused', 14));
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null }));
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
    expect(t.store.stage).toBe('prioritized');
    expect(t.logs.join('\n')).toContain('stays in its retreat stage');
  });

  it('writes the Verlauf line INSIDE the claim: one put without --claim, before the release', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    t.adapter.starts[0]!.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'usage', tokensIn: 1200, tokensOut: 300 });
    await waitFor(() => expect(t.sup.get(id)?.tokensIn).toBe(1200));
    t.adapter.handles[0]!.result();
    t.adapter.handles[0]!.fail(0);
    await settled(t.sup, id, 'done');
    const ops = t.store.calls.map((c) => c.op);
    const put = ops.indexOf('put');
    expect(put).toBeGreaterThan(-1);
    expect(put).toBeLessThan(ops.indexOf('release')); // inside the claim, before it is given up
    expect(t.store.of('put')[0]?.put).toEqual({ holdsClaim: true, actor: expect.stringMatching(/^agent-r-/) });
    expect(t.store.text).toContain('## Verlauf');
    expect(t.store.text).toContain('tokens');
    expect(t.store.of('put')).toHaveLength(1); // the settle wrote no second one
  });

  it('a run that consumed nothing writes no Verlauf line', async () => {
    const t = setup();
    const id = await started(t.sup, request());
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
    expect(t.store.of('put').filter((c) => c.put?.holdsClaim === true)).toHaveLength(0);
  });

  it('Q-03: a worker that waits for the owner gives the claim up and re-claims on the answer', async () => {
    const t = setup();
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null }));
    t.adapter.starts[0]!.onEvent({
      ts: '2026-10-17T12:00:01Z',
      kind: 'note',
      waiting: { kind: 'question', text: 'Which shortcut?', requestId: 'q1', questions: [{ question: 'Which shortcut?', header: 'Key', options: [{ label: 'Ctrl+K', description: '' }] }] } as never,
    });
    await waitFor(() => expect(t.store.of('release')).toHaveLength(1));
    const wait = t.store.of('comment')[0]?.text ?? '';
    expect(wait).toMatch(/^needs-decision: \[run-[a-z0-9-]+-waits\] /);
    expect(t.timers.armed).toBeNull(); // no keep-alive while nobody holds the claim
    expect(t.store.of('claim')).toHaveLength(1);

    const answer = await t.sup.answerQuestion(id, { 'Which shortcut?': ['Ctrl+K'] } as never);
    expect(answer.ok).toBe(true);
    expect(t.store.of('claim')).toHaveLength(2); // re-claimed BEFORE the worker went on
    expect(t.store.of('comment').map((c) => (c.text ?? '').split('\n')[0])).toContainEqual(expect.stringMatching(/^resolved: run-/));
    expect(t.timers.armed).not.toBeNull(); // the keep-alive runs again
    expect(t.adapter.handles[0]!.answerQuestion).toHaveBeenCalled();
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
  });

  it('Q-03: an answer for a ticket someone else took meanwhile is refused and the worker gets nothing', async () => {
    const t = setup();
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null }));
    t.adapter.starts[0]!.onEvent({ ts: '2026-10-17T12:00:01Z', kind: 'note', waiting: { kind: 'question', text: 'Which?', requestId: 'q1', questions: [{ question: 'Which?', header: 'k', options: [{ label: 'a', description: '' }] }] } as never });
    await waitFor(() => expect(t.store.of('release')).toHaveLength(1));
    t.store.failNext('claim', new TicketStoreError('claimed', 'ticket t-1 is claimed by henrik', 11));
    const answer = await t.sup.answerQuestion(id, { 'Which?': ['a'] } as never);
    expect(answer.ok).toBe(false);
    expect(t.adapter.handles[0]!.answerQuestion).not.toHaveBeenCalled();
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
  });

  it('Q-03: with commit trailers on, the claim is kept through the wait (the epoch the trailers carry must stand)', async () => {
    const t = setup();
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null, dk: { ...TARGET, trailers: true } }));
    t.adapter.starts[0]!.onEvent({ ts: '2026-10-17T12:00:01Z', kind: 'note', waiting: { kind: 'permission', text: 'edit x', requestId: 'p1' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.store.of('release')).toHaveLength(0);
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
  });

  it('release leftover claims: an agent claim of this host with no live run goes back; humans and live runs are left alone', async () => {
    const t = setup();
    const host = runOwnerHost();
    const records = [
      { id: 'T-0007', stage: 'build', owner: `agent-r-dead@${host}` },
      { id: 'T-0008', stage: 'build', owner: 'henrik' },
      { id: 'T-0009', stage: 'build', owner: `agent-r-x@other-host` },
      { id: 'T-0001', stage: 'build', owner: `agent-r-live@${host}` }, // a live run holds T-0001
    ];
    t.store.list = (() => Promise.resolve(records)) as never;
    const id = await started(t.sup, request({ nextPhase: null, nextPhaseDir: null }));
    const report = await t.sup.releaseLeftoverClaims(TARGET, { build: 'prioritized' });
    expect(report.released).toEqual(['T-0007']);
    const releases = t.store.of('release').filter((c) => c.id === 'T-0007');
    expect(releases[0]?.actor).toBe(`agent-r-dead@${host}`); // released AS the dead run
    expect(releases.map((c) => c.stage)).toEqual(['build', 'prioritized']);
    expect(t.store.of('release').filter((c) => c.id !== 'T-0007')).toHaveLength(0);
    t.adapter.handles[0]!.fail(1);
    await settled(t.sup, id, 'failed');
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
