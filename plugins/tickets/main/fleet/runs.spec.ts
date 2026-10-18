import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, WorkerHandle } from './providers';
import { RunSupervisor, type RunSupervisorDeps } from './runs';
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
  const handles: Array<WorkerHandle & { fail: (code: number | null) => void; onEvent: (text: string) => void }> = [];
  const adapter: ProviderAdapter = {
    id: 'opencode',
    label: 'OpenCode',
    liveInject: true,
    spawn: (start) => {
      let exitResolve: ((code: number | null) => void) | null = null;
      const handle: WorkerHandle & {
        fail: (code: number | null) => void;
        onEvent: (text: string) => void;
      } = {
        pid: 4242,
        exited: new Promise<number | null>((resolve) => {
          exitResolve = resolve;
        }),
        steer: vi.fn(async () => 'inject' as const),
        stop: vi.fn(async () => {
          exitResolve?.(null);
        }),
        fail: (code) => exitResolve?.(code),
        onEvent: (text) => start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'note', text }),
      };
      handles.push(handle);
      return handle;
    },
  };
  return { adapter, handles };
}

function gitRecorder() {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const exec: GitExecFn = async (_exe, args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'rev-parse') {
      return `${path.sep}root${path.sep}tk\n`;
    }
    return '';
  };
  const ticketsGit = new TicketsGit(() => 'git', exec);
  return { ticketsGit, calls };
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

  it('validates the deterministic branch and the machine gate before spawning', async () => {
    const { sup } = supervisor();
    await writeTicket();
    const wrongBranch = await sup.start(request({ branch: 'feature/x' }));
    expect(wrongBranch.ok).toBe(false);
    const noGate = await sup.start(request({ acceptance: [] }));
    expect(noGate.ok).toBe(false);
    expect((noGate as { error: string }).error).toContain('no acceptance criteria');
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

  it('a red gate fails the run and the ticket stays put', async () => {
    const { sup, adapter } = supervisor({
      execShell: async () => Promise.reject(new Error('exit 1\nTests failed')),
    });
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    expect(started.ok).toBe(true);
    const id = (started as { run: { id: string } }).run.id;

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
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(adapter.handles.length).toBe(2));
    // The ticket has not moved yet — the audit round runs first.
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'))).resolves.toBeUndefined();

    // The auditor's green gate moves the ticket, and no third round starts.
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

    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(adapter.handles.length).toBe(2));
    adapter.handles[1]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('failed'));
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'plan', 'T-0001.md'))).resolves.toBeUndefined();
    expect(sup.get(id)?.gateFailure).toContain('failed — exit 1');
  });
});
