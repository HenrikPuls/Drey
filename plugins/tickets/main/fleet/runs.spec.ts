import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, WorkerHandle } from './providers';
import { RunSupervisor, usageSummary, type RunSupervisorDeps } from './runs';
import type { RunRequest } from './protocol';
import { newTicketFileText, patchTicketFile, parseTicketFile } from '../ticket-files';
import { TicketsGit, type GitExecFn } from '../tickets-git';

/**
 * The run supervisor against seams: a scripted adapter, a recorded git
 * seam, a no-op worktree. The ticket files are REAL (temp dir) — the
 * stamps and the success move are file semantics, and that is exactly
 * what must not drift from the board's.
 */

function fakeAdapter() {
  const handles: Array<
    WorkerHandle & { fail: (code: number | null) => void; onEvent: (text: string) => void; result: () => void }
  > = [];
  const adapter: ProviderAdapter = {
    id: 'opencode',
    label: 'OpenCode',
    liveInject: true,
    spawn: (start) => {
      let exitResolve: ((code: number | null) => void) | null = null;
      const handle: WorkerHandle & {
        fail: (code: number | null) => void;
        onEvent: (text: string) => void;
        result: () => void;
      } = {
        pid: 4242,
        exited: new Promise<number | null>((resolve) => {
          exitResolve = resolve;
        }),
        steer: vi.fn(async () => 'inject' as const),
        setHold: vi.fn(),
        interrupt: vi.fn(async () => true),
        stop: vi.fn(async () => {
          exitResolve?.(null);
        }),
        fail: (code) => exitResolve?.(code),
        onEvent: (text) => start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'note', text }),
        result: () => start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'result', text: 'done' }),
      };
      handles.push(handle);
      return handle;
    },
  };
  return { adapter, handles };
}

function gitRecorder() {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  let worktreeList = '';
  const exec: GitExecFn = async (_exe, args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'rev-parse') {
      return `${path.sep}root${path.sep}tk\n`;
    }
    // The default prepareWorktree: an existing registration at the same
    // path throws ("already exists") — the reuse rule answers with the list.
    if (args[0] === 'worktree' && args[1] === 'add') {
      throw new Error(`fatal: '${args[2] ?? ''}' already exists`);
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return worktreeList;
    }
    return '';
  };
  const ticketsGit = new TicketsGit(() => 'git', exec);
  return {
    ticketsGit,
    calls,
    set worktreeList(value: string) {
      worktreeList = value;
    },
  };
}

let vaultDir = '';
let fleetRoot = '';

const ticketText = (): string =>
  newTicketFileText({
    id: 'T-0001',
    title: 'Add the thing',
    repo: 'kt',
    priority: 'normal',
    rank: 5000,
    firstPhase: 'plan',
    now: new Date('2026-10-17T10:00:00Z'),
    actor: 'owner@box',
    description: 'It should work.',
  });

async function writeTicket(): Promise<string> {
  const rel = 'tickets/plan/T-0001.md';
  await fsp.mkdir(path.dirname(path.join(vaultDir, rel)), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, rel), ticketText(), 'utf8');
  return rel;
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'T-0001',
    ticketsVaultPath: vaultDir,
    ticketRelPath: 'tickets/plan/T-0001.md',
    phase: 'plan',
    repoPath: 'W:/kt',
    branch: 't/T-0001',
    baseRef: null,
    provider: 'opencode',
    model: null,
    permissionMode: 'accept-edits',
    instruction: 'Do the ticket.',
    acceptance: ['npm run verify:unit'],
    gate: 'commands',
    git: 'git',
    nextPhase: 'build',
    claimIdentity: null,
    ...overrides,
  };
}

function supervisor(overrides: Partial<RunSupervisorDeps> = {}): {
  sup: RunSupervisor;
  adapter: ReturnType<typeof fakeAdapter>;
  git: ReturnType<typeof gitRecorder>;
  gate: string[][];
} {
  const adapter = fakeAdapter();
  const git = gitRecorder();
  const gate: string[][] = [];
  const sup = new RunSupervisor({
    root: fleetRoot,
    adapter: adapter.adapter,
    git: 'git',
    log: () => undefined,
    now: () => new Date('2026-10-17T12:00:00Z'),
    prepareWorktree: async () => undefined,
    execShell: async (command) => {
      gate.push([command]);
    },
    ticketsGit: git.ticketsGit,
    ...overrides,
  });
  return { sup, adapter, git, gate };
}

describe('RunSupervisor', () => {
  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
  });

  afterEach(async () => {
    await fsp.rm(vaultDir, { recursive: true, force: true });
    await fsp.rm(fleetRoot, { recursive: true, force: true });
  });

  it('refuses a second live run for the ticket', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    await sup.start(request({ ticketRelPath: rel }));
    const second = await sup.start(request({ ticketRelPath: rel }));
    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toContain('already has a live run');
    expect(adapter.handles).toHaveLength(1);
  });

  it('takeover holds the run, interrupt needs it, release hands it back', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    const handle = adapter.handles[0]!;

    const early = await sup.interrupt(runId);
    expect(early.ok).toBe(false);
    expect((early as { error: string }).error).toContain('not taken over');

    expect((await sup.takeover(runId)).ok).toBe(true);
    expect(handle.setHold).toHaveBeenLastCalledWith(true);
    expect(sup.get(runId)?.held).toBe(true);

    expect((await sup.interrupt(runId)).ok).toBe(true);
    expect(handle.interrupt).toHaveBeenCalledTimes(1);

    expect((await sup.release(runId)).ok).toBe(true);
    expect(handle.setHold).toHaveBeenLastCalledWith(false);
    expect(sup.get(runId)?.held).toBe(false);
  });

  it('refuses a takeover for a worker that cannot be held, and for an unknown run', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    (adapter.handles[0] as { setHold?: unknown }).setHold = undefined;
    const refused = await sup.takeover(runId);
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toContain('cannot be taken over');
    expect((await sup.takeover('R-nope')).ok).toBe(false);
  });

  it('validates the deterministic branch and the machine gate before spawning', async () => {
    const { sup } = supervisor();
    await writeTicket();
    const wrongBranch = await sup.start(request({ branch: 'feature/x' }));
    expect(wrongBranch.ok).toBe(false);
    const noGate = await sup.start(request({ acceptance: [] }));
    expect(noGate.ok).toBe(false);
    expect((noGate as { error: string }).error).toContain('no acceptance criteria');
    // The first worker column may take the ticket anyway: its run gates
    // structurally (the plan writes the criteria).
    const structural = await sup.start(request({ acceptance: [], gate: 'structural' }));
    expect(structural.ok).toBe(true);
  });

  it('a structural run fails red when no acceptance criteria came into existence', async () => {
    const { sup, adapter, gate } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ acceptance: [], gate: 'structural' }));
    const id = (started as { run: { id: string } }).run.id;

    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('failed'));

    expect(gate).toEqual([]); // no commands to run — the gate reads instead
    expect(sup.get(id)?.gateFailure).toContain('no executable acceptance criteria');
    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(parseTicketFile(text, rel).meta.run).toBeNull();
  });

  it('a structural run passes when the plan produced acceptance criteria', async () => {
    const { sup, adapter, gate } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ acceptance: [], gate: 'structural' }));
    const id = (started as { run: { id: string } }).run.id;

    // The plan's deliverable: acceptance criteria appear in the ticket…
    const live = path.join(vaultDir, rel);
    await fsp.writeFile(
      live,
      (await fsp.readFile(live, 'utf8')).replace(
        '### Acceptance criteria',
        '### Acceptance criteria\n\n- [ ] `node -e "process.exit(0)"` — exits 0',
      ),
      'utf8',
    );

    // …and the gate reads them as green (no commands to run).
    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));
    expect(gate).toEqual([]);
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'build', 'T-0001.md'))).resolves.toBeUndefined();
  });

  it('a green worker passes the gate and moves the ticket on (one commit)', async () => {
    const { sup, adapter, git, gate } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    expect(started.ok).toBe(true);

    const info = (started as { run: { id: string; state: string } }).run;
    expect(info.state).toBe('running');
    // The ticket carries the live run now.
    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(parseTicketFile(text, rel).meta.run?.stream).toBe(info.id);

    adapter.handles[0]!.onEvent('working…');
    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(info.id)?.state).toBe('done'));

    // The gate ran exactly the ticket's commands, in the worktree.
    expect(gate[0]).toEqual(['npm run verify:unit']);
    // The ticket moved to the next phase; the run map is gone.
    const movedRel = 'tickets/build/T-0001.md';
    const moved = await fsp.readFile(path.join(vaultDir, movedRel), 'utf8');
    expect(parseTicketFile(moved, movedRel).meta.run).toBeNull();
    expect(parseTicketFile(moved, movedRel).meta.entered['build']).toBeDefined();
    // Exactly the moved pair was committed for the transition.
    const commit = git.calls.find((c) => c.args[0] === 'commit');
    expect(commit?.args).toContain('--');
    expect(git.calls.some((c) => c.args[0] === 'add')).toBe(true);
    await expect(fsp.access(path.join(vaultDir, rel))).rejects.toBeDefined();
  });

  it('a fleet move into a non-claim phase releases a stale claim', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    // A claim left over from an earlier round rides on the live ticket…
    const live = path.join(vaultDir, rel);
    await fsp.writeFile(
      live,
      patchTicketFile(await fsp.readFile(live, 'utf8'), {
        to: 'plan',
        from: null,
        now: new Date('2026-10-17T12:00:01Z'),
        actor: 'owner@desk',
        claimBy: 'owner@desk',
      }),
      'utf8',
    );

    // …but the fleet's own move never carries it into the next column.
    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));

    const movedRel = 'tickets/build/T-0001.md';
    const moved = await fsp.readFile(path.join(vaultDir, movedRel), 'utf8');
    expect(parseTicketFile(moved, movedRel).meta.claimedBy).toBeNull();
  });

  it('a red gate fails the run and the ticket stays put', async () => {
    const { sup, adapter } = supervisor({
      execShell: async () => Promise.reject(new Error('exit 1\nTests failed')),
    });
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    expect(started.ok).toBe(true);
    const id = (started as { run: { id: string } }).run.id;

    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('failed'));
    expect(sup.get(id)?.gateFailure).toContain('exit 1');

    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    const meta = parseTicketFile(text, rel).meta;
    expect(meta.run).toBeNull(); // the slot is free again
    expect(text).toContain('machine gate failed');
  });

  it('stop kills the worker and frees the run slot', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    const stopped = await sup.stop(id, 'wrong direction');
    expect(stopped.ok).toBe(true);
    expect(adapter.handles[0]!.stop).toHaveBeenCalled();
    await vi.waitFor(async () => {
      const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
      expect(parseTicketFile(text, rel).meta.run).toBeNull();
    });
    await expect(sup.get(id)?.state).toBe('stopped');

    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(text).toContain('stopped by the owner — wrong direction');
  });

  it('steer reaches the worker and lands in the ticket Log', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    const sent = await sup.send(id, 'Focus on the parser first');
    expect(sent.ok).toBe(true);
    expect((sent as { rung: string }).rung).toBe('inject');
    expect(adapter.handles[0]!.steer).toHaveBeenCalledWith('Focus on the parser first');

    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(text).toContain('steer (inject): Focus on the parser first');
  });

  it('a runner restart marks live runs detached and frees the ticket', async () => {
    const { sup: first, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await first.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;
    // The first supervisor "crashes" without the worker ever exiting.

    const second = supervisor();
    await second.sup.adopt();
    const adopted = second.sup.get(id);
    expect(adopted?.state).toBe('detached');

    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(parseTicketFile(text, rel).meta.run).toBeNull();
    void adapter;
  });

  it('the start patch records the dialog\'s worker choice on the ticket', async () => {
    const { sup } = supervisor();
    const rel = await writeTicket();
    await sup.start(request({ ticketRelPath: rel, recordWorker: 'claude-code/sonnet' }));
    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(parseTicketFile(text, rel).meta.worker).toBe('claude-code/sonnet');
  });

  it('a second opinion re-runs the step before it moves — once', async () => {
    let opinions = 0;
    const { sup, adapter } = supervisor({
      secondOpinion: async () => {
        opinions += 1;
        return 'You are the sampling auditor — review the step.';
      },
    });
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    // The first worker's green gate hands the step to the auditor.
    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(adapter.handles.length).toBe(2));
    // The ticket has not moved yet — the audit round runs first.
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'))).resolves.toBeUndefined();

    // The auditor's green gate moves the ticket, and no third round starts.
    adapter.handles[1]!.result();
    adapter.handles[1]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'build', 'T-0001.md'))).resolves.toBeUndefined();
    expect(opinions).toBe(1);
    expect(adapter.handles).toHaveLength(2);
    const stream = await fsp.readFile(path.join(fleetRoot, 'runs', id, 'stream.jsonl'), 'utf8');
    expect(stream).toContain('second opinion');
  });

  it('a red gate in the audit round parks the ticket', async () => {
    let gateCalls = 0;
    const gateGreenRounds = 1;
    const { sup, adapter } = supervisor({
      secondOpinion: async () => 'audit brief',
      execShell: async (command) => {
        // The first gate is green, the auditor's gate runs the same
        // commands — fail from the second round on via the call count.
        gateCalls += 1;
        if (gateCalls > gateGreenRounds) {
          throw new Error('exit 1\naudit gate red');
        }
        void command;
      },
    });
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(adapter.handles.length).toBe(2));
    adapter.handles[1]!.result();
    adapter.handles[1]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('failed'));
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'))).resolves.toBeUndefined();
    expect(sup.get(id)?.gateFailure).toContain('failed — exit 1');
  });

  it('a worker that ends without a result fails red — the gate never runs', async () => {
    const { sup, adapter, gate } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    // A crash (or a spawn that never came up): the turn never finished,
    // so there is no agent-done for the gate to judge.
    adapter.handles[0]!.fail(-1);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('failed'));

    expect(gate).toEqual([]); // the safety net judges claimed-done work only
    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(parseTicketFile(text, rel).meta.run).toBeNull(); // the slot is free again
    expect(text).toContain('no agent-done, the step fails');
    // The ticket did not move.
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'))).resolves.toBeUndefined();
  });

  it('reuses an existing registered worktree for a re-run', async () => {
    const { sup, git } = supervisor({ prepareWorktree: undefined });
    git.worktreeList = [
      `worktree ${path.join(fleetRoot, 'worktrees', 'kt-T-0001').replace(/\\/g, '/')}`,
      'branch refs/heads/t/T-0001',
      '',
      `worktree ${path.join(fleetRoot, 'worktrees', 'kt-other')}`,
      'branch refs/heads/other',
      '',
    ].join('\n');
    const rel = await writeTicket();

    // `git worktree add` throws on the existing path; the registration
    // for the same branch makes the start succeed anyway.
    const started = await sup.start(request({ ticketRelPath: rel }));
    expect(started.ok).toBe(true);
  });

  it('refuses a start whose worktree path is registered for another branch', async () => {
    const { sup, git } = supervisor({ prepareWorktree: undefined });
    git.worktreeList = [
      `worktree ${path.join(fleetRoot, 'worktrees', 'kt-T-0001').replace(/\\/g, '/')}`,
      'branch refs/heads/other',
      '',
    ].join('\n');
    const rel = await writeTicket();

    const refused = await sup.start(request({ ticketRelPath: rel }));
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toContain('worktree failed');
  });
});

describe('usageSummary — what the ticket Log says a run used', () => {
  it('names tokens and leaves a zero cost out (flat plans report 0)', () => {
    expect(usageSummary({ tokensIn: 331_122, tokensOut: 1_511, costUsd: 0 })).toBe(' — 331k in / 2k out');
    expect(usageSummary({ tokensIn: 3_400_000, tokensOut: 800, costUsd: null })).toBe(' — 3.4M in / 800 out');
  });

  it('adds a real cost and stays silent when nothing was used', () => {
    expect(usageSummary({ tokensIn: 1_000, tokensOut: 10, costUsd: 0.124 })).toBe(' — 1k in / 10 out · $0.12');
    expect(usageSummary({ tokensIn: 0, tokensOut: 0, costUsd: null })).toBe('');
  });
});
