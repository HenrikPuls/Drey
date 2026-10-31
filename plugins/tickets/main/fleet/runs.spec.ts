import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachInfo, ProviderAdapter, ProviderStart, WorkerHandle } from './providers';
import { HANDOVER_CONTINUE, probeExec, RunSupervisor, usageSummary, type RunSupervisorDeps } from './runs';
import { processAlive } from './procs';
import type { RunInfo, RunRequest, RunState } from './protocol';
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
  const attachInfos: AttachInfo[] = [];
  const starts: ProviderStart[] = [];
  const adapter: ProviderAdapter = {
    id: 'opencode',
    label: 'OpenCode',
    liveInject: true,
    spawn: (start) => make(start),
    attach: (start, info) => {
      attachInfos.push(info);
      return make(start);
    },
  };
  const make = (start: ProviderStart) => {
      starts.push(start);
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
        answerPermission: vi.fn(async () => true),
        answerQuestion: vi.fn(async () => true),
        stop: vi.fn(async () => {
          exitResolve?.(null);
        }),
        fail: (code) => exitResolve?.(code),
        onEvent: (text) => start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'note', text }),
        result: () => start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'result', text: 'done' }),
      };
      handles.push(handle);
      return handle;
  };
  return { adapter, handles, attachInfos, starts };
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
    nextPhase: 'build',
    nextPhaseDir: 'build',
    pushRemote: null,
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
    prepareWorktree: async () => ({ outcome: 'created', sessionInvalidated: false, movedTo: null }),
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

  // --- the session handover (T-0049) --------------------------------

  /** A settled record the next start may resume — seeded as a runner
   *  boot would adopt it (the supervisor's `now` is fixed at 12:00). */
  async function seedRun(
    id: string,
    over: {
      ticket?: string;
      model?: string | null;
      phase?: string;
      state?: RunState;
      sessionRef?: string | null;
      endedAt?: string | null;
      startedAt?: string;
      lastTurnContext?: number | null;
    } = {},
  ): Promise<void> {
    const ticket = over.ticket ?? 'T-0001';
    const started = over.startedAt ?? '2026-10-17T10:00:00Z';
    const info: RunInfo = {
      id,
      ticketId: ticket,
      provider: 'opencode',
      state: over.state ?? 'failed',
      pid: null,
      startedAt: started,
      endedAt: over.endedAt ?? '2026-10-17T11:57:00Z',
      sessionRef: over.sessionRef ?? `ses_${id}`,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: started,
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'W:/gone',
      branch: `t/${ticket}`,
      ...(over.model !== undefined ? { model: over.model } : {}),
      ...(over.phase !== undefined ? { phase: over.phase } : {}),
      ...(over.lastTurnContext !== undefined ? { lastTurnContext: over.lastTurnContext } : {}),
      gateFailure: null,
    };
    const dir = path.join(fleetRoot, 'runs', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'run.json'),
      JSON.stringify({
        request: request({
          ...(ticket !== 'T-0001' ? { ticketId: ticket, branch: `t/${ticket}`, ticketRelPath: `tickets/plan/${ticket}.md` } : {}),
          ...(over.model !== undefined ? { model: over.model } : {}),
          ...(over.phase !== undefined ? { phase: over.phase, ticketRelPath: `tickets/${over.phase}/T-0001.md` } : {}),
        }),
        info,
      }),
      'utf8',
    );
  }

  it('an auto handover resumes a warm same-phase retry and stamps mode and lineage (T-0049)', async () => {
    const rel = await writeTicket();
    await seedRun('R-old', { endedAt: '2026-10-17T11:57:00Z' }); // 3 min before the fixed now
    const { sup, adapter } = supervisor();
    await sup.adopt();

    const started = await sup.start(request({ ticketRelPath: rel, handover: 'auto' }));
    const id = (started as { run: { id: string } }).run.id;
    expect(adapter.starts[0]!.resumeRef).toBe('ses_R-old');
    expect(adapter.starts[0]!.compactFirst).not.toBe(true);

    const info = sup.get(id)!;
    expect(info.handoverMode).toBe('resume');
    expect(info.resumedFrom).toBe('ses_R-old');
    expect(info.sessionRef).toBe('ses_R-old');
    // The stamps are durable and the decision is on the record's trail.
    const stored = JSON.parse(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8')) as {
      info: { handoverMode?: string; resumedFrom?: string | null };
    };
    expect(stored.info.handoverMode).toBe('resume');
    expect(stored.info.resumedFrom).toBe('ses_R-old');
    const stream = await fsp.readFile(path.join(fleetRoot, 'runs', id, 'stream.jsonl'), 'utf8');
    expect(stream).toContain('handover: resume');
    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    expect(text).toContain('handover resume');
  });

  it('the resolution picks the newest terminal run of the same ticket and model — other tickets and models never', async () => {
    const rel = await writeTicket();
    await seedRun('R-match', { startedAt: '2026-10-17T10:00:00Z', endedAt: '2026-10-17T11:57:00Z' });
    await seedRun('R-newer-match', { startedAt: '2026-10-17T10:30:00Z', endedAt: '2026-10-17T11:58:00Z' });
    await seedRun('R-other-ticket', { ticket: 'T-0002', startedAt: '2026-10-17T11:00:00Z' });
    await seedRun('R-other-model', { model: 'glm-x', startedAt: '2026-10-17T11:30:00Z' });
    const { sup, adapter } = supervisor();
    await sup.adopt();

    await sup.start(request({ ticketRelPath: rel, handover: 'auto' }));
    expect(adapter.starts[0]!.resumeRef).toBe('ses_R-newer-match');
  });

  it('a candidate of another phase (build after plan) resolves fresh (T-0049)', async () => {
    await fsp.mkdir(path.join(vaultDir, 'tickets', 'build'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, 'tickets', 'build', 'T-0001.md'), ticketText(), 'utf8');
    await seedRun('R-plan', { phase: 'plan', endedAt: '2026-10-17T11:57:00Z' });
    const { sup, adapter } = supervisor();
    await sup.adopt();

    const started = await sup.start(
      request({ ticketRelPath: 'tickets/build/T-0001.md', phase: 'build', nextPhase: 'review', handover: 'auto' }),
    );
    expect((started as { run: { handoverMode?: string } }).run.handoverMode).toBe('fresh');
    expect(adapter.starts[0]!.resumeRef).toBeNull();
    const stream = await fsp.readFile(
      path.join(fleetRoot, 'runs', (started as { run: { id: string } }).run.id, 'stream.jsonl'),
      'utf8',
    );
    expect(stream).toContain('worked the plan phase');
  });

  it('a recreated or moved-aside worktree resolves fresh — the session is stale (T-0049)', async () => {
    await seedRun('R-stale', { endedAt: '2026-10-17T11:57:00Z' });
    const { sup, adapter } = supervisor({
      prepareWorktree: async () => ({ outcome: 'recreated', sessionInvalidated: true, movedTo: null }),
    });
    await sup.adopt();
    const rel = await writeTicket();

    const started = await sup.start(request({ ticketRelPath: rel, handover: 'auto' }));
    expect((started as { run: { handoverMode?: string } }).run.handoverMode).toBe('fresh');
    expect(adapter.starts[0]!.resumeRef).toBeNull();
    const stream = await fsp.readFile(
      path.join(fleetRoot, 'runs', (started as { run: { id: string } }).run.id, 'stream.jsonl'),
      'utf8',
    );
    expect(stream).toContain('stale');
  });

  it('a session another non-terminal run holds resolves fresh — never double-resumed (T-0049)', async () => {
    // The ticket's candidate session…
    await seedRun('R-held', { endedAt: '2026-10-17T11:57:00Z', sessionRef: 'ses_busy' });
    // …is held by another ticket's live worker (adopted as running).
    await seedRun('R-live2', {
      ticket: 'T-0002',
      state: 'running',
      endedAt: null,
      sessionRef: 'ses_busy',
      startedAt: '2026-10-17T11:00:00Z',
    });
    const { sup, adapter } = supervisor();
    await sup.adopt();
    const rel = await writeTicket();

    const started = await sup.start(request({ ticketRelPath: rel, handover: 'auto' }));
    expect((started as { run: { handoverMode?: string } }).run.handoverMode).toBe('fresh');
    expect(adapter.starts[0]!.resumeRef).toBeNull();
    const stream = await fsp.readFile(
      path.join(fleetRoot, 'runs', (started as { run: { id: string } }).run.id, 'stream.jsonl'),
      'utf8',
    );
    expect(stream).toContain('twice');
  });

  it('a cold pause above the configured threshold resumes with a native compact first (T-0049)', async () => {
    const rel = await writeTicket();
    await seedRun('R-big', {
      endedAt: '2026-10-17T10:00:00Z', // two hours before the fixed now: cold
      sessionRef: 'ses_big',
      lastTurnContext: 30_000,
    });
    const { sup, adapter } = supervisor();
    await sup.adopt();
    sup.setHandoverConfig({ compactAboveTokens: 20_000, resumePauseTtlMin: 15 });
    const started = await sup.start(request({ ticketRelPath: rel, handover: 'auto' }));
    expect(adapter.starts[0]!.compactFirst).toBe(true);
    expect((started as { run: { handoverMode?: string } }).run.handoverMode).toBe('resume-compact');

    // The same record with the default threshold is below the bar: a plain resume.
    const plain = supervisor();
    await plain.sup.adopt();
    await plain.sup.start(request({ ticketRelPath: rel, handover: 'auto' }));
    expect(plain.adapter.starts[0]!.compactFirst).not.toBe(true);
  });

  it('a resume the adapter cannot establish respawns fresh under the same run id (T-0049)', async () => {
    const rel = await writeTicket();
    await seedRun('R-gone', { sessionRef: 'ses_gone', endedAt: '2026-10-17T11:57:00Z' });
    const { sup, adapter } = supervisor();
    await sup.adopt();

    const started = await sup.start(request({ ticketRelPath: rel, handover: 'resume' }));
    const id = (started as { run: { id: string } }).run.id;
    expect(adapter.starts[0]!.resumeRef).toBe('ses_gone');

    adapter.starts[0]!.onResumeFailed!('the session answered HTTP 404');
    await vi.waitFor(() => expect(adapter.starts.length).toBe(2));
    expect(adapter.handles[0]!.stop).toHaveBeenCalled();
    expect(adapter.starts[1]!.resumeRef).toBeNull();
    expect(adapter.starts[1]!.instruction).toBe('Do the ticket.');

    // One run id, fresh stamps, the note on the stream — and the run is alive.
    const info = sup.get(id)!;
    expect(sup.list().filter((r) => !['done', 'stopped', 'failed'].includes(r.state))).toHaveLength(1);
    expect(info.handoverMode).toBe('fresh');
    expect(info.resumedFrom).toBeNull();
    const stream = await fsp.readFile(path.join(fleetRoot, 'runs', id, 'stream.jsonl'), 'utf8');
    expect(stream).toContain('the run starts fresh');

    // The replacement worker's turn decides the run as usual.
    adapter.handles[1]!.result();
    adapter.handles[1]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));
  });

  it('resume strips the stored handover ask from the copied request (T-0049)', async () => {
    const rel = await writeTicket();
    const dir = path.join(fleetRoot, 'runs', 'R-det');
    await fsp.mkdir(dir, { recursive: true });
    const info = {
      id: 'R-det',
      ticketId: 'T-0001',
      provider: 'opencode',
      state: 'detached',
      pid: null,
      startedAt: '2026-10-17T11:00:00Z',
      endedAt: null,
      sessionRef: 'ses_det',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: '2026-10-17T11:00:00Z',
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'x',
      branch: 't/T-0001',
      gateFailure: null,
    };
    await fsp.writeFile(
      path.join(dir, 'run.json'),
      JSON.stringify({ request: request({ ticketRelPath: rel, handover: 'auto' }), info }),
      'utf8',
    );
    const { sup } = supervisor();
    await sup.adopt();

    const outcome = await sup.resume('R-det');
    expect(outcome.ok).toBe(true);
    const id = (outcome as { run: { id: string } }).run.id;
    const stored = JSON.parse(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8')) as {
      request: { handover?: string };
    };
    expect(stored.request.handover).toBeUndefined();
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

  it('takeover holds the run, an interrupt takes over by itself, release hands it back', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    const handle = adapter.handles[0]!;

    expect((await sup.takeover(runId)).ok).toBe(true);
    expect(handle.setHold).toHaveBeenLastCalledWith(true);
    expect(sup.get(runId)?.held).toBe(true);

    expect((await sup.interrupt(runId)).ok).toBe(true);
    expect(handle.interrupt).toHaveBeenCalledTimes(1);

    expect((await sup.release(runId)).ok).toBe(true);
    expect(handle.setHold).toHaveBeenLastCalledWith(false);
    expect(sup.get(runId)?.held).toBe(false);
  });

  it('the first prompt takes the run over by itself; opening and watching never do', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    expect(sup.get(runId)?.held).not.toBe(true);

    expect((await sup.send(runId, 'look at the spec')).ok).toBe(true);
    expect(adapter.handles[0]!.setHold).toHaveBeenLastCalledWith(true);
    expect(sup.get(runId)?.held).toBe(true);
  });

  it('a waiting worker is recorded with its question and logged; the answer is no takeover (req-64)', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    adapter.starts[0]!.onEvent({ ts: '2026-10-20T10:05:00Z', kind: 'usage', waiting: { kind: 'question', text: 'Which API?' } });
    await vi.waitFor(async () => {
      expect(sup.get(runId)?.waiting).toEqual({ kind: 'question', text: 'Which API?', since: '2026-10-20T10:05:00Z' });
      expect(await fsp.readFile(path.join(vaultDir, rel), 'utf8')).toContain('asks the owner — Which API?');
    });

    expect((await sup.send(runId, 'v2')).ok).toBe(true);
    expect(adapter.handles[0]!.setHold).not.toHaveBeenCalled();
    expect(sup.get(runId)?.held).not.toBe(true);
    expect(await fsp.readFile(path.join(vaultDir, rel), 'utf8')).toContain('answered by the owner: v2');

    adapter.starts[0]!.onEvent({ ts: '2026-10-20T10:06:00Z', kind: 'usage', waiting: null });
    await vi.waitFor(() => expect(sup.get(runId)?.waiting).toBeNull());
  });

  it('passes the owner\'s approval to the worker, and refuses when nothing waits for one (req-64)', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    expect((await sup.answerPermission(runId, 'once')).ok).toBe(false);

    adapter.starts[0]!.onEvent({
      ts: '2026-10-20T10:05:00Z',
      kind: 'usage',
      waiting: { kind: 'permission', text: 'bash rm -rf dist', requestId: 'per_1' },
    });
    await vi.waitFor(() => expect(sup.get(runId)?.waiting?.kind).toBe('permission'));
    expect((await sup.answerPermission(runId, 'reject')).ok).toBe(true);
    expect(adapter.handles[0]!.answerPermission).toHaveBeenCalledWith('per_1', 'reject');
    expect(await fsp.readFile(path.join(vaultDir, rel), 'utf8')).toContain('rejected by the owner — bash rm -rf dist');
  });

  it("answers a question form with the owner's choices or typed words — no takeover, no prompt", async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    expect((await sup.answerQuestion(runId, { q0: 'Rebase' })).ok).toBe(false);

    const questions = [{ key: 'q0', header: 'Merge', question: 'How should I merge?', options: [{ label: 'Rebase' }, { label: 'Merge' }], multiple: false }];
    adapter.starts[0]!.onEvent({
      ts: '2026-10-20T10:05:00Z',
      kind: 'usage',
      waiting: { kind: 'question', text: 'How should I merge?', requestId: 'frm_1', questions },
    });
    await vi.waitFor(() => expect(sup.get(runId)?.waiting?.requestId).toBe('frm_1'));
    expect((await sup.answerQuestion(runId, { q0: 'Rebase' })).ok).toBe(true);
    expect(adapter.handles[0]!.answerQuestion).toHaveBeenLastCalledWith('frm_1', { q0: 'Rebase' });

    expect((await sup.send(runId, '2')).ok).toBe(true);
    expect(adapter.handles[0]!.answerQuestion).toHaveBeenLastCalledWith('frm_1', { q0: 'Merge' });
    expect(adapter.handles[0]!.steer).not.toHaveBeenCalled();
    expect(adapter.handles[0]!.setHold).not.toHaveBeenCalled();
    expect(await fsp.readFile(path.join(vaultDir, rel), 'utf8')).toContain('answered by the owner: Merge');
  });

  it('an interrupt of a run nobody holds takes it over first', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    expect((await sup.interrupt(runId)).ok).toBe(true);
    expect(adapter.handles[0]!.setHold).toHaveBeenCalledWith(true);
    expect(sup.get(runId)?.held).toBe(true);
  });

  it('a reported context window survives later events without it (T-0052)', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    const fire = adapter.starts[0]!.onEvent;
    fire({ ts: '2026-10-17T12:00:00Z', kind: 'usage', contextWindow: 1_000_000 });
    await vi.waitFor(() => expect(sup.get(runId)?.contextWindow).toBe(1_000_000));
    // A later event without the field must not erase the once-set value.
    fire({ ts: '2026-10-17T12:00:01Z', kind: 'note', text: 'working' });
    await vi.waitFor(() => expect(sup.get(runId)?.lastActivity).toBe('2026-10-17T12:00:01Z'));
    expect(sup.get(runId)?.contextWindow).toBe(1_000_000);
  });

  // --- the elapsed clock's busy spans (req-67) -----------------------

  it('the clock presumes working from the start and closes its span when a wait begins', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    const fire = adapter.starts[0]!.onEvent;
    fire({ ts: '2026-10-17T12:05:00Z', kind: 'usage', turn: 'busy' });
    await vi.waitFor(() => expect(sup.get(runId)?.execSince).toBe('2026-10-17T12:00:00.000Z'));

    fire({ ts: '2026-10-17T12:10:00Z', kind: 'usage', waiting: { kind: 'question', text: 'Which API?' } });
    await vi.waitFor(() => expect(sup.get(runId)).toMatchObject({ execMs: 10 * 60_000, execSince: null }));

    fire({ ts: '2026-10-17T12:15:00Z', kind: 'usage', turn: 'busy', waiting: null });
    await vi.waitFor(() => expect(sup.get(runId)?.execSince).toBe('2026-10-17T12:15:00Z'));
    expect(sup.get(runId)?.execMs).toBe(10 * 60_000);
  });

  it('a standing held worker pauses the clock the same way, and startup counts', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    const fire = adapter.starts[0]!.onEvent;
    fire({ ts: '2026-10-17T12:10:00Z', kind: 'usage', turn: 'idle' });
    await vi.waitFor(() => expect(sup.get(runId)).toMatchObject({ execMs: 10 * 60_000, execSince: null }));

    fire({ ts: '2026-10-17T12:12:00Z', kind: 'usage', turn: 'busy' });
    await vi.waitFor(() => expect(sup.get(runId)?.execSince).toBe('2026-10-17T12:12:00Z'));
    expect(sup.get(runId)?.execMs).toBe(10 * 60_000);
  });

  it('the clock freezes when the run ends, on the record as well', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    const fire = adapter.starts[0]!.onEvent;
    // Rapid-fire on purpose: two events, no settling between them — the
    // fold must serialize them in arrival order (the req-67 clock-freeze
    // flake used to let the older idle event land last).
    fire({ ts: '2026-10-17T12:10:00Z', kind: 'usage', turn: 'idle' });
    fire({ ts: '2026-10-17T12:12:00Z', kind: 'usage', turn: 'busy' });
    await vi.waitFor(() => expect(sup.get(runId)?.execSince).toBe('2026-10-17T12:12:00Z'));

    await sup.stop(runId, 'enough');
    await vi.waitFor(async () => {
      expect(sup.get(runId)?.state).toBe('stopped');
      const stored = JSON.parse(await fsp.readFile(path.join(fleetRoot, 'runs', runId, 'run.json'), 'utf8')) as {
        info: RunInfo;
      };
      expect(stored.info).toMatchObject({ execMs: 10 * 60_000, execSince: null });
    });
  });

  it('an adopted run detached mid-busy is frozen at its last stamp', async () => {
    const rel = await writeTicket();
    const dir = path.join(fleetRoot, 'runs', 'R-ex');
    await fsp.mkdir(dir, { recursive: true });
    const info: RunInfo = {
      id: 'R-ex',
      ticketId: 'T-0001',
      provider: 'opencode',
      state: 'running',
      pid: null,
      startedAt: '2026-10-17T10:00:00Z',
      endedAt: null,
      sessionRef: 'ses_ex',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: '2026-10-17T11:30:00Z',
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'x',
      branch: 't/T-0001',
      turn: 'busy',
      execMs: 30 * 60_000,
      execSince: '2026-10-17T11:00:00Z',
      gateFailure: null,
    };
    await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify({ request: request({ ticketRelPath: rel }), info }), 'utf8');
    const { sup } = supervisor();
    await sup.adopt();
    expect(sup.get('R-ex')).toMatchObject({ execMs: 60 * 60_000, execSince: null });
  });

  it('a re-attached busy run resumes its clock at the next busy report, without the unwatched gap', async () => {
    const rel = await writeTicket();
    const dir = path.join(fleetRoot, 'runs', 'R-busy');
    await fsp.mkdir(dir, { recursive: true });
    const info: RunInfo = {
      id: 'R-busy',
      ticketId: 'T-0001',
      provider: 'opencode',
      state: 'running',
      pid: process.pid,
      startedAt: '2026-10-17T11:00:00Z',
      endedAt: null,
      sessionRef: 'ses_busy',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: '2026-10-17T11:30:00Z',
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'x',
      branch: 't/T-0001',
      turn: 'busy',
      execMs: 20 * 60_000,
      execSince: '2026-10-17T11:10:00Z',
      gateFailure: null,
    };
    await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify({ request: request({ ticketRelPath: rel }), info }), 'utf8');
    await fsp.writeFile(
      path.join(dir, 'attach.json'),
      JSON.stringify({ address: 'http://127.0.0.1:50003', password: 'pw', pid: process.pid, pidStartedMs: null }),
      'utf8',
    );
    const { sup, adapter } = supervisor({ exec: probeExec(os.tmpdir()) });
    await sup.adopt();
    // The unwatched gap closed the span at the record's last stamp.
    expect(sup.get('R-busy')).toMatchObject({ execMs: 40 * 60_000, execSince: null });

    adapter.starts[0]!.onEvent({ ts: '2026-10-17T12:05:00Z', kind: 'usage', turn: 'busy' });
    await vi.waitFor(() => expect(sup.get('R-busy')?.execSince).toBe('2026-10-17T12:05:00Z'));
    expect(sup.get('R-busy')?.execMs).toBe(40 * 60_000);
  });

  it('resume ends a detached run and resumes its session in a new run', async () => {
    const rel = await writeTicket();
    const dir = path.join(fleetRoot, 'runs', 'R-gone');
    await fsp.mkdir(dir, { recursive: true });
    const info = { id: 'R-gone', ticketId: 'T-0001', provider: 'opencode', state: 'detached', pid: null, startedAt: '2026-10-17T11:00:00Z', endedAt: null, sessionRef: 'ses_gone', tokensIn: 0, tokensOut: 0, costUsd: null, lastActivity: '2026-10-17T11:00:00Z', steerCount: 0, lastSteerRung: null, worktreePath: 'x', branch: 't/T-0001', gateFailure: null };
    await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify({ request: request({ ticketRelPath: rel }), info }), 'utf8');
    const { sup, adapter } = supervisor();
    await sup.adopt();

    const outcome = await sup.resume('R-gone');
    expect(outcome.ok).toBe(true);
    expect(sup.get('R-gone')?.state).toBe('stopped');
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.starts[0]!.resumeRef).toBe('ses_gone');
    expect(adapter.starts[0]!.instruction).toContain('session was resumed');
  });

  it('resume refuses a run that is not detached or never reported a session', async () => {
    const { sup } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;
    expect((await sup.resume(runId)).ok).toBe(false);
    expect((await sup.resume('R-nope')).ok).toBe(false);
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

  it('stop kills the worker first and the ticket Log line comes with the run\'s end', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const runId = (started as { run: { id: string } }).run.id;

    const outcome = await sup.stop(runId, 'because');
    expect(outcome.ok).toBe(true);
    expect(adapter.handles[0]!.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      expect(sup.get(runId)?.state).toBe('stopped');
      expect(await fsp.readFile(path.join(vaultDir, rel), 'utf8')).toContain('stopped by the owner — because');
    });
  });

  it('re-attaches a live worker of a restarted runner, a held run stays held', async () => {
    const rel = await writeTicket();
    const dir = path.join(fleetRoot, 'runs', 'R-live');
    await fsp.mkdir(dir, { recursive: true });
    const info = {
      id: 'R-live',
      ticketId: 'T-0001',
      provider: 'opencode',
      state: 'running',
      held: true,
      pid: process.pid,
      startedAt: '2026-10-17T11:00:00Z',
      endedAt: null,
      sessionRef: 'ses_live',
      tokensIn: 5,
      tokensOut: 1,
      costUsd: null,
      lastActivity: '2026-10-17T11:30:00Z',
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'x',
      branch: 't/T-0001',
      gateFailure: null,
    };
    await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify({ request: request({ ticketRelPath: rel }), info }), 'utf8');
    // the worker is "alive": the recorded process is this very test process
    await fsp.writeFile(
      path.join(dir, 'attach.json'),
      JSON.stringify({ address: 'http://127.0.0.1:50001', password: 'pw', pid: process.pid, pidStartedMs: null }),
      'utf8',
    );

    const { sup, adapter } = supervisor({ exec: probeExec(os.tmpdir()) });
    await sup.adopt();

    expect(sup.get('R-live')?.state).toBe('running');
    expect(adapter.attachInfos).toHaveLength(1);
    expect(adapter.attachInfos[0]).toMatchObject({ address: 'http://127.0.0.1:50001', password: 'pw', sessionRef: 'ses_live', pid: process.pid });
    expect(adapter.handles[0]!.setHold).toHaveBeenCalledWith(true);
    // the credential never rides in the run record the board reads
    expect(await fsp.readFile(path.join(dir, 'run.json'), 'utf8')).not.toContain('pw"');
  });

  it('does not re-attach when the recorded process is gone or no attach file exists', async () => {
    const rel = await writeTicket();
    for (const [id, attach] of [
      ['R-nofile', null],
      ['R-dead', { address: 'http://127.0.0.1:50002', password: 'pw', pid: 2_147_483_000, pidStartedMs: null }],
    ] as const) {
      const dir = path.join(fleetRoot, 'runs', id);
      await fsp.mkdir(dir, { recursive: true });
      const info = { id, ticketId: 'T-0001', provider: 'opencode', state: 'running', pid: null, startedAt: '2026-10-17T11:00:00Z', endedAt: null, sessionRef: 'ses_x', tokensIn: 0, tokensOut: 0, costUsd: null, lastActivity: '2026-10-17T11:00:00Z', steerCount: 0, lastSteerRung: null, worktreePath: 'x', branch: 't/T-0001', gateFailure: null };
      await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify({ request: request({ ticketRelPath: rel }), info }), 'utf8');
      if (attach !== null) {
        await fsp.writeFile(path.join(dir, 'attach.json'), JSON.stringify(attach), 'utf8');
      }
    }
    const { sup, adapter } = supervisor({ exec: probeExec(os.tmpdir()) });
    await sup.adopt();
    expect(adapter.attachInfos).toHaveLength(0);
    expect(sup.get('R-nofile')?.state).toBe('detached');
    expect(sup.get('R-dead')?.state).toBe('detached');
  });

  it('adopts a live leftover as detached once, and stop ends a detached run (frees the ticket)', async () => {
    const rel = await writeTicket();
    const dir = path.join(fleetRoot, 'runs', 'R-old');
    await fsp.mkdir(dir, { recursive: true });
    const info = {
      id: 'R-old',
      ticketId: 'T-0001',
      provider: 'opencode',
      state: 'running',
      pid: null,
      startedAt: '2026-10-17T11:00:00Z',
      endedAt: null,
      sessionRef: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: '2026-10-17T11:00:00Z',
      steerCount: 0,
      lastSteerRung: null,
      worktreePath: 'x',
      branch: 't/T-0001',
      gateFailure: null,
    };
    await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify({ request: request({ ticketRelPath: rel }), info }), 'utf8');

    const first = supervisor();
    await first.sup.adopt();
    expect(first.sup.get('R-old')?.state).toBe('detached');

    // A second boot leaves the detached record alone (no re-detach, no new stamp).
    const before = await fsp.readFile(path.join(dir, 'run.json'), 'utf8');
    const second = supervisor();
    await second.sup.adopt();
    expect(await fsp.readFile(path.join(dir, 'run.json'), 'utf8')).toBe(before);

    const stopped = await second.sup.stop('R-old', 'owner');
    expect(stopped.ok).toBe(true);
    expect(second.sup.get('R-old')?.state).toBe('stopped');
  });

  it('validates the deterministic branch and the machine gate before spawning', async () => {
    const { sup } = supervisor();
    await writeTicket();
    const wrongBranch = await sup.start(request({ branch: 'feature/x' }));
    expect(wrongBranch.ok).toBe(false);
    const noGate = await sup.start(request({ acceptance: [] }));
    expect(noGate.ok).toBe(false);
    expect((noGate as { error: string }).error).toContain('no acceptance criteria');
    const wrongPath = await sup.start(request({ ticketRelPath: 'tickets/build/T-0001.md' }));
    expect(wrongPath.ok).toBe(false);
    expect((wrongPath as { error: string }).error).toContain('does not match id and phase');
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

  it('accepts a numbered phase directory in the ticket path (T-0041)', async () => {
    const { sup } = supervisor();
    const rel = 'tickets/30-plan/T-0001.md';
    await fsp.mkdir(path.join(vaultDir, 'tickets', '30-plan'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, rel), ticketText(), 'utf8');
    const started = await sup.start(request({ ticketRelPath: rel }));
    expect(started.ok).toBe(true);
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

  it('an interactive dialog starts held, lays the run stamp and the reservation, and ends without gate or move (req-65)', async () => {
    const { sup, adapter, gate } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(
      request({
        ticketRelPath: rel,
        acceptance: [],
        gate: 'structural',
        nextPhase: null,
        nextPhaseDir: null,
        interactive: 'plan',
      }),
    );
    expect(started.ok).toBe(true);
    const info = (started as { run: { id: string; state: string; held?: boolean; interactive?: string } }).run;
    // Held from turn one — before the worker says anything.
    expect(adapter.handles[0]!.setHold).toHaveBeenCalledWith(true);
    expect(info.held).toBe(true);
    expect(info.interactive).toBe('plan');
    expect(info.state).toBe('running');

    // The ticket carries the live run AND the dialog reservation.
    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    const meta = parseTicketFile(text, rel).meta;
    expect(meta.run?.stream).toBe(info.id);
    expect(meta.interactive).toBe(true);

    // The worker ends its turn without a result — a dialog turn, not a
    // claim: the run still ends done, and nothing gates or moves.
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(info.id)?.state).toBe('done'));
    expect(gate).toEqual([]);
    const kept = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    const keptMeta = parseTicketFile(kept, rel).meta;
    expect(keptMeta.run).toBeNull(); // the stamp cleared with the run
    expect(keptMeta.interactive).toBe(true); // the reservation stands until a move
    await fsp.access(path.join(vaultDir, rel)); // the ticket never moved
  });

  it('an interactive dialog spawns quiet — no brief delivered, the worker stands held (req-75)', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(
      request({
        ticketRelPath: rel,
        acceptance: [],
        gate: 'structural',
        nextPhase: null,
        nextPhaseDir: null,
        interactive: 'plan',
      }),
    );
    expect(started.ok).toBe(true);
    const info = (started as { run: { id: string } }).run;
    // Nothing runs until the owner asks: the adapter delivers no first
    // prompt, and the record says the brief still rides ahead.
    expect(adapter.starts[0]!.holdAtSpawn).toBe(true);
    expect(adapter.handles[0]!.setHold).toHaveBeenCalledWith(true);
    expect(sup.get(info.id)?.quietStart).toBe(true);
    expect(sup.get(info.id)?.held).toBe(true);
  });

  it("the owner's first message wraps the quiet brief once; every later send goes bare (req-75)", async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(
      request({
        ticketRelPath: rel,
        acceptance: [],
        gate: 'structural',
        nextPhase: null,
        nextPhaseDir: null,
        interactive: 'refine',
      }),
    );
    const id = (started as { run: { id: string } }).run.id;

    expect((await sup.send(id, 'Where does the parser live?')).ok).toBe(true);
    expect(adapter.handles[0]!.steer).toHaveBeenCalledWith(
      'Do the ticket.\n\n---\n\nThe owner starts the dialog:\nWhere does the parser live?',
    );
    // Once, and persisted: quietStart is cleared with the send.
    expect(sup.get(id)?.quietStart).toBeUndefined();
    await vi.waitFor(async () =>
      expect(JSON.parse(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8')).info.quietStart).toBeUndefined(),
    );

    expect((await sup.send(id, 'Start with the lexer')).ok).toBe(true);
    expect(adapter.handles[0]!.steer).toHaveBeenLastCalledWith('Start with the lexer');
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

  it('moves the ticket into the resolved numbered directory (T-0041)', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(
      request({ ticketRelPath: rel, nextPhase: 'qa', nextPhaseDir: '35-qa' }),
    );
    expect(started.ok).toBe(true);
    const id = (started as { run: { id: string } }).run.id;

    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));

    const movedRel = 'tickets/35-qa/T-0001.md';
    const moved = await fsp.readFile(path.join(vaultDir, movedRel), 'utf8');
    expect(parseTicketFile(moved, movedRel).meta.entered['qa']).toBeDefined();
    expect(moved).toContain('moving to qa');
    await expect(fsp.access(path.join(vaultDir, rel))).rejects.toBeDefined();
  });

  it('pushes the transition commit when the request names a remote, never otherwise (T-0041)', async () => {
    const withPush = supervisor();
    const rel = await writeTicket();
    const started = await withPush.sup.start(request({ ticketRelPath: rel, pushRemote: 'origin' }));
    expect(started.ok).toBe(true);
    const id = (started as { run: { id: string } }).run.id;

    withPush.adapter.handles[0]!.result();
    withPush.adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(withPush.sup.get(id)?.state).toBe('done'));

    const push = withPush.git.calls.find((c) => c.args[0] === 'push');
    expect(push?.args).toEqual(['push', 'origin', 'HEAD']);
    expect(push?.cwd).toBe(`${path.sep}root${path.sep}tk`);

    const noPush = supervisor();
    const rel2 = await writeTicket();
    const started2 = await noPush.sup.start(request({ ticketRelPath: rel2 }));
    const id2 = (started2 as { run: { id: string } }).run.id;
    noPush.adapter.handles[0]!.result();
    noPush.adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(noPush.sup.get(id2)?.state).toBe('done'));
    expect(noPush.git.calls.some((c) => c.args[0] === 'push')).toBe(false);
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

  it('a red gate records its verdict, a bounded multi-line failure and a one-line Log entry', async () => {
    const { sup, adapter } = supervisor({
      execShell: async () => {
        const err = new Error('command failed');
        // What promisify(exec) rejects with: stdout and stderr ride the error.
        Object.assign(err, { stdout: 'running tests…', stderr: `${'detail\n'.repeat(600)}FAIL src/a.spec.ts` });
        throw err;
      },
    });
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('failed'));
    const info = sup.get(id)!;
    expect(info.gateResult).toBe('red');
    expect(info.gateFailure).toContain('\n'); // multi-line: the command line, then the output
    expect(info.gateFailure).toContain('FAIL src/a.spec.ts');
    expect(info.gateFailure!.split('\n').length).toBeLessThanOrEqual(400 + 2); // SANITY_CAP + the two heading lines

    // The ticket Log keeps the single-line discipline: the failure's first line only.
    const text = await fsp.readFile(path.join(vaultDir, rel), 'utf8');
    const gateLines = text.split('\n').filter((line) => line.includes('machine gate failed'));
    expect(gateLines).toHaveLength(1);
    expect(gateLines[0]).toContain('machine gate failed — `npm run verify:unit` failed');
    expect(gateLines[0]).not.toContain('detail');
  });

  it('a green gate records its verdict (gateResult on the record)', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;
    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));
    expect(sup.get(id)?.gateResult).toBe('green');
  });

  it('folds the run telemetry into the record as events arrive', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel, model: 'zai/glm-5.3' }));
    const id = (started as { run: { id: string } }).run.id;
    const onEvent = adapter.starts[0]!.onEvent;
    onEvent({ ts: '2026-10-17T12:00:01Z', kind: 'note', text: 'read src/a.ts', tool: 'read' });
    onEvent({ ts: '2026-10-17T12:00:02Z', kind: 'usage', turnUsage: { input: 900, cacheRead: 20_000, cacheCreation: 4_000, output: 210 } });
    onEvent({ ts: '2026-10-17T12:00:03Z', kind: 'note', text: 'edit src/a.ts', tool: 'edit' });
    onEvent({ ts: '2026-10-17T12:00:04Z', kind: 'usage', turnUsage: { input: 1_100, cacheRead: 30_000, cacheCreation: null, output: 300 } });
    await vi.waitFor(() => expect(sup.get(id)?.turns).toBe(2));

    const info = sup.get(id)!;
    expect(info.handoverMode).toBe('fresh');
    expect(info.model).toBe('zai/glm-5.3');
    expect(info.phase).toBe('plan');
    expect(info.turns).toBe(2);
    expect(info.usage).toEqual({ input: 2_000, cacheRead: 50_000, cacheCreation: 4_000, output: 510 });
    expect(info.lastTurnContext).toBe(31_100);
    expect(info.readCalls).toBe(1);
    expect(info.tokensBeforeFirstWrite).toBe(24_900);
    // The record is durable: run.json carries the fields.
    const stored = JSON.parse(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8')) as {
      info: { turns?: number; usage?: unknown };
    };
    expect(stored.info.turns).toBe(2);
    expect(stored.info.usage).toBeDefined();
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

  it('a prompt to an ended run reopens its session with the prompt as the first message', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;
    adapter.handles[0]!.onEvent('session');
    await sup.stop(id, 'pause');
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('stopped'));
    // The fake worker reported no session; give the record one.
    (sup as unknown as { runs: Map<string, { info: RunInfo }> }).runs.get(id)!.info = {
      ...sup.get(id)!,
      sessionRef: 'ses_1',
    };

    expect((await sup.send(id, '   ')).ok).toBe(false);
    const sent = await sup.send(id, 'Also fix the header');
    expect(sent.ok).toBe(true);
    expect(sent.rung).toBe('resume');
    expect(sent.runId).toBeDefined();
    expect(sent.runId).not.toBe(id);
    expect(adapter.starts[1]!.resumeRef).toBe('ses_1');
    expect(adapter.starts[1]!.instruction).toBe('Also fix the header');
    expect(sup.get(sent.runId!)?.held).toBe(true);
    const stream = await fsp.readFile(path.join(fleetRoot, 'runs', sent.runId!, 'stream.jsonl'), 'utf8');
    expect(stream).toContain('you › Also fix the header');
  });

  it('follows a ticket the owner moved during the run: the stamp is cleared, no second move', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;

    // The owner moves the card on by hand (two columns on) while the worker runs.
    const movedRel = 'tickets/commit/T-0001.md';
    await fsp.mkdir(path.dirname(path.join(vaultDir, movedRel)), { recursive: true });
    await fsp.rename(path.join(vaultDir, rel), path.join(vaultDir, movedRel));

    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));

    const text = await fsp.readFile(path.join(vaultDir, movedRel), 'utf8');
    expect(parseTicketFile(text, movedRel).meta.run).toBeNull();
    await expect(fsp.access(path.join(vaultDir, 'tickets/build/T-0001.md'))).rejects.toBeDefined();
  });

  it('steer reaches the worker and lands in the ticket Log', async () => {
    const { sup, adapter } = supervisor();
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;
    // A dispatched run posts its brief at spawn, as before (req-75).
    expect(adapter.starts[0]!.holdAtSpawn).not.toBe(true);

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
    expect(sup.get(id)?.gateFailure).toContain('exit 1');
    expect(sup.get(id)?.gateResult).toBe('red');
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
    // The path comes from the request (T-0044) — the runner never derives one.
    const wt = request().worktreePath.replace(/\\/g, '/');
    git.worktreeList = [
      `worktree ${wt}`,
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
    const wt = request().worktreePath.replace(/\\/g, '/');
    git.worktreeList = [
      `worktree ${wt}`,
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

  it('names the cached part of the input when the provider reported one (req-53)', () => {
    expect(usageSummary({ tokensIn: 6_565_245, tokensOut: 12_779, cacheReadTokens: 6_200_000, costUsd: 0 })).toBe(
      ' — 6.6M in (6.2M cached) / 13k out',
    );
    expect(usageSummary({ tokensIn: 1_000, tokensOut: 10, cacheReadTokens: 0, costUsd: null })).toBe(' — 1k in / 10 out');
  });
});

describe('probeExec — the process probes keep their arguments apart', () => {
  it('hands an argument with spaces over as one argument (no shell re-parsing)', async () => {
    const out = await probeExec(os.tmpdir())(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'PID eq 42']);
    expect(out).toBe('PID eq 42');
  });

  it('sees a live pid as alive and an impossible one as gone', async () => {
    const exec = probeExec(os.tmpdir());
    expect(await processAlive(process.pid, exec)).toBe(true);
    expect(await processAlive(2_147_483_000, exec)).toBe(false);
  });
});

/**
 * The runner handover (req-51): a runner retired for a newer build leaves
 * its live runs to the successor instead of stopping them. The probe exec
 * answers nothing, so no real process is ever probed or killed here.
 */
describe('RunSupervisor handover', () => {
  const noProbe = async (): Promise<string> => '';

  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
  });

  afterEach(async () => {
    await fsp.rm(vaultDir, { recursive: true, force: true });
    await fsp.rm(fleetRoot, { recursive: true, force: true });
  });

  /** A Claude-Code-like fake: same scripted handles, no attach. */
  function claudeSupervisor(): ReturnType<typeof supervisor> {
    const fake = fakeAdapter();
    const adapter: ProviderAdapter = { ...fake.adapter, id: 'claude-code', attach: undefined };
    const built = supervisor({ adapter, exec: noProbe });
    return { ...built, adapter: fake };
  }

  async function startedClaudeRun(sup: RunSupervisor, adapter: ReturnType<typeof fakeAdapter>): Promise<string> {
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel, provider: 'claude-code' }));
    expect(started.ok).toBe(true);
    adapter.starts[0]!.onSessionRef('ses_claude');
    const id = (started as { run: { id: string } }).run.id;
    // the session ref is persisted fire-and-forget: wait for that write to land
    await vi.waitFor(async () =>
      expect(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8').catch(() => '')).toContain('ses_claude'),
    );
    return id;
  }

  const storedOf = async (id: string): Promise<{ info: { state: string }; handover?: { mode: string } }> =>
    JSON.parse(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8')) as {
      info: { state: string };
      handover?: { mode: string };
    };

  it('stops a worker it cannot leave running, keeps the run live on disk and the ticket stamped', async () => {
    const { sup, adapter } = claudeSupervisor();
    const id = await startedClaudeRun(sup, adapter);

    expect(sup.handoverBlocker()).toBeNull();
    expect(await sup.handOver()).toBe(1);

    expect(adapter.handles[0]!.stop).toHaveBeenCalled();
    // the worker's exit decides nothing in the retiring runner
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sup.get(id)?.state).toBe('running');
    const stored = await storedOf(id);
    expect(stored.info.state).toBe('running');
    expect(stored.handover?.mode).toBe('resume');
    const text = await fsp.readFile(path.join(vaultDir, 'tickets/plan/T-0001.md'), 'utf8');
    expect(parseTicketFile(text, 'tickets/plan/T-0001.md').meta.run).not.toBeNull();

    // nothing new starts, and a stop would be undone by the successor's resume
    expect((await sup.start(request())).ok).toBe(false);
    expect((await sup.stop(id, null)).ok).toBe(false);
  });

  it('leaves a worker with an attach file running for the successor to re-attach', async () => {
    const { sup, adapter } = supervisor({ exec: noProbe });
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;
    await fsp.writeFile(path.join(fleetRoot, 'runs', id, 'attach.json'), '{}', 'utf8');

    await sup.handOver();
    expect(adapter.handles[0]!.stop).not.toHaveBeenCalled();
    expect((await storedOf(id)).handover?.mode).toBe('reattach');
  });

  it('defers while a run is in its machine gate', async () => {
    let releaseGate: () => void = () => undefined;
    const { sup, adapter } = supervisor({
      exec: noProbe,
      execShell: () =>
        new Promise<void>((resolve) => {
          releaseGate = resolve;
        }),
    });
    const rel = await writeTicket();
    const started = await sup.start(request({ ticketRelPath: rel }));
    const id = (started as { run: { id: string } }).run.id;
    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(sup.handoverBlocker()).toContain('machine gate'));
    releaseGate();
    await vi.waitFor(() => expect(sup.get(id)?.state).toBe('done'));
    expect(sup.handoverBlocker()).toBeNull();
  });

  it('the successor resumes a handed-over session in place — same run id, a fresh worker', async () => {
    const first = claudeSupervisor();
    const id = await startedClaudeRun(first.sup, first.adapter);
    await first.sup.handOver();

    const second = claudeSupervisor();
    await second.sup.adopt();

    const run = second.sup.get(id);
    expect(run?.state).toBe('running');
    expect(run?.pid).toBe(4242);
    expect(second.adapter.starts).toHaveLength(1);
    expect(second.adapter.starts[0]!.resumeRef).toBe('ses_claude');
    expect(second.adapter.starts[0]!.instruction).toBe(HANDOVER_CONTINUE);
    // the record is an ordinary live run again
    expect((await storedOf(id)).handover).toBeUndefined();
    const text = await fsp.readFile(path.join(vaultDir, 'tickets/plan/T-0001.md'), 'utf8');
    expect(text).toContain(`run ${id} resumed after a runner handover`);

    // and it ends like any run: agent done, gate green, the ticket moves
    second.adapter.handles[0]!.result();
    second.adapter.handles[0]!.fail(0);
    await vi.waitFor(() => expect(second.sup.get(id)?.state).toBe('done'));
  });

  it("keeps a resumed session's usage base across the handover, so the run's counts go on from its own (req-53)", async () => {
    const first = claudeSupervisor();
    const id = await startedClaudeRun(first.sup, first.adapter);
    const base = { tokensIn: 10_000, tokensOut: 50, cacheReadTokens: 9_000, costUsd: null };
    first.adapter.starts[0]!.onUsageBase!(base);
    await vi.waitFor(async () => expect(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8')).toContain('usageBase'));
    await first.sup.handOver();

    const second = claudeSupervisor();
    await second.sup.adopt();
    expect(second.adapter.starts[0]!.usageBase).toEqual(base);
  });

  it('a run without a recorded base resumes from zero — its own session is counted whole', async () => {
    const first = claudeSupervisor();
    const id = await startedClaudeRun(first.sup, first.adapter);
    await first.sup.handOver();
    const second = claudeSupervisor();
    await second.sup.adopt();
    expect(second.sup.get(id)?.state).toBe('running');
    expect(second.adapter.starts[0]!.usageBase).toEqual({ tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, costUsd: null });
  });

  it('a held run comes back held and fully silent — no resume prompt at all', async () => {
    const first = claudeSupervisor();
    const id = await startedClaudeRun(first.sup, first.adapter);
    expect((await first.sup.takeover(id)).ok).toBe(true);
    await first.sup.handOver();

    const second = claudeSupervisor();
    await second.sup.adopt();
    expect(second.sup.get(id)?.held).toBe(true);
    // The resume prompt itself caused the "I'm back" no-op turns
    // (R-20261030T20203-wpsd): a held resume delivers nothing — the
    // worker stands, held, until the owner sends.
    expect(second.adapter.starts[0]!.instruction).toBe(HANDOVER_CONTINUE);
    expect(second.adapter.starts[0]!.holdAtSpawn).toBe(true);
    expect(second.adapter.handles[0]!.setHold).toHaveBeenCalledWith(true);
  });

  it('a handed-over run without a session detaches as before', async () => {
    const first = claudeSupervisor();
    const rel = await writeTicket();
    const started = await first.sup.start(request({ ticketRelPath: rel, provider: 'claude-code' }));
    const id = (started as { run: { id: string } }).run.id;
    await first.sup.handOver();

    const second = claudeSupervisor();
    await second.sup.adopt();
    expect(second.sup.get(id)?.state).toBe('detached');
    expect(second.adapter.starts).toHaveLength(0);
  });

  it('a supervisor adopts only its own provider\'s runs', async () => {
    const first = claudeSupervisor();
    const id = await startedClaudeRun(first.sup, first.adapter);
    const before = await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8');

    const opencode = supervisor({ exec: noProbe });
    await opencode.sup.adopt();
    expect(opencode.sup.get(id)).toBeNull();
    expect(await fsp.readFile(path.join(fleetRoot, 'runs', id, 'run.json'), 'utf8')).toBe(before);
  });
});
