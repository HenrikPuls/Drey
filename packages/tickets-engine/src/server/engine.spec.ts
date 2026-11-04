import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatBridge, ChatDecisionResult, ChatSessionMeta, ChatStreamEvent, ChatTurnResult } from '../contracts/chat';
import { CHAT_DIR, parseSessionFile } from '../core/chat-session';
import type { VerifyHarness, VerifyRunInput, VerifyRunResult, VerifyStatus } from '../contracts/verify';
import { createEngine, type Engine } from './engine';

/**
 * E2b acceptance: the standalone engine hosts the whole service surface
 * over the loopback invoke channel — snapshot, mutations with the one
 * git-commit discipline, config sync, live events — against a real
 * tickets vault on disk, with no Drey in the picture.
 */

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }
  - { id: done, title: Done, handover: none }
---
The pipeline.
`;

let root: string;
let vault: string;
let home: string;
let engine: Engine;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'tickets-engine-'));
  vault = path.join(root, 'vault');
  home = path.join(root, 'home');
  await fsp.mkdir(path.join(vault, 'tickets/_meta'), { recursive: true });
  await fsp.mkdir(path.join(root, 'client'), { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(vault, 'tickets/_meta/pipeline.md'), PIPELINE, 'utf8');
  await gitInitVault();
  // The pair-status specs read `pairing.deviceName` — the remote must be
  // on (or the status hides the pairing view behind `config.enabled`).
  await fsp.writeFile(path.join(home, 'config.json'), JSON.stringify({ 'remote.enabled': true }), 'utf8');
  engine = await createEngine({ vaultPath: vault, home, clientDir: path.join(root, 'client'), log: () => undefined });
});

afterEach(async () => {
  await engine.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('createEngine', () => {
  it('health-checks and exposes the invoke channel with a bearer token', async () => {
    const response = await fetch(`${engine.invokeUrl}/api/health`, {
      headers: { authorization: `Bearer ${engine.token}` },
    });
    expect(response.status).toBe(200);
    const unauthenticated = await fetch(`${engine.invokeUrl}/api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'snapshot' }),
    });
    expect(unauthenticated.status).toBe(401);
  });

  it('assembles a snapshot from the vault files', async () => {
    const snapshot = (await engine.invoke('snapshot')) as { vaultName: string | null; pipeline: readonly { id: string }[] };
    expect(snapshot.vaultName).toBe('vault');
    expect(snapshot.pipeline.map((p) => p.id)).toEqual(['inbox', 'build', 'done']);
  });

  it('creates and transitions a ticket with the one-commit discipline', async () => {
    const created = (await engine.invoke('createTicket', {
      title: 'Smoke ticket',
      priority: 'normal',
      repo: null,
      description: 'the body',
    })) as { ok: boolean; id?: string; path?: string };
    expect(created.ok).toBe(true);
    expect(await fsp.readFile(path.join(vault, created.path!), 'utf8')).toContain('Smoke ticket');

    const moved = (await engine.invoke('transition', {
      id: created.id,
      from: 'inbox',
      to: 'build',
    })) as { ok: boolean; path?: string };
    expect(moved.ok).toBe(true);
    const text = await fsp.readFile(path.join(vault, moved.path!), 'utf8');
    expect(text).toContain('entered-build');
    expect(text).toContain('inbox -> build');
    await expect(fsp.stat(path.join(vault, created.path!))).rejects.toThrow();
  });

  it('round-trips config through the sync channel', async () => {
    await engine.invoke('configSet', { key: 'defaultWorker', value: 'claude-code' });
    expect(await engine.invoke('configGet', { key: 'defaultWorker' })).toBe('claude-code');
  });

  it('refuses unknown methods and survives their error', async () => {
    const response = await fetch(`${engine.invokeUrl}/api/invoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'locate' }),
    });
    expect(response.status).toBe(404);
    // The channel is still alive afterwards.
    expect(await engine.invoke('configGet', { key: 'missing' })).toBeUndefined();
  });

  it('streams live events over the SSE channel', async () => {
    const events: string[] = [];
    const unsubscribe = engine.onEvent((what) => events.push(what));
    await engine.invoke('createTicket', { title: 'Live', priority: 'high', repo: null, description: '' });
    const deadline = Date.now() + 3_000;
    while (!events.includes('board') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    unsubscribe();
    expect(events).toContain('board');
  });
});

const PIA_PERSONA = `---
title: Pia
role: builder
worker: claude-code
models:
  default: opus
  pool: [opus, sonnet]
  router: off
color: '#a78bfa'
skills: []
---
Who Pia is.
`;

const LEGACY_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default, worker: opencode, model: opus, prompt: build-v2 }
  - { id: done, title: Done, handover: none }
---
The pipeline.
`;

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args], {
    cwd: vault,
  });
  return stdout;
}

async function gitInitVault(): Promise<void> {
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'spec']);
  await git(['config', 'user.email', 'spec@example.com']);
}

describe('personas (ADR-0088, E3)', () => {
  it('listPersonas parses the personas directory and starts empty', async () => {
    expect(await engine.invoke('listPersonas')).toEqual([]);
    await fsp.mkdir(path.join(vault, 'tickets/_meta/personas/pia'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'tickets/_meta/personas/pia/persona.md'), PIA_PERSONA, 'utf8');
    await fsp.mkdir(path.join(vault, 'tickets/_meta/personas/ben'), { recursive: true });
    await fsp.writeFile(
      path.join(vault, 'tickets/_meta/personas/ben/persona.md'),
      PIA_PERSONA.replace('title: Pia', 'title: Ben').replace('worker: claude-code', 'worker: opencode'),
      'utf8',
    );
    const personas = (await engine.invoke('listPersonas')) as {
      id: string;
      title: string;
      worker: string;
      models: { default: string; pool: readonly string[] };
    }[];
    expect(personas.map((p) => p.id)).toEqual(['ben', 'pia']); // sorted
    expect(personas[1]).toMatchObject({ title: 'Pia', worker: 'claude-code', models: { default: 'opus', pool: ['opus', 'sonnet'] } });
  });

  it('serves the team reads of the remote port on the invoke channel (E13-8)', async () => {
    expect(await engine.invoke('personas')).toEqual([]);
    await fsp.mkdir(path.join(vault, 'tickets/_meta/personas/pia'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'tickets/_meta/personas/pia/persona.md'), PIA_PERSONA, 'utf8');
    const personas = (await engine.invoke('personas')) as { id: string; title: string; pool: readonly string[] }[];
    expect(personas.map((p) => p.id)).toEqual(['pia']);
    expect(personas[0]).toMatchObject({ title: 'Pia', pool: ['opus', 'sonnet'] });
    const thread = (await engine.invoke('personaThread', 'pia')) as { ok: boolean; messages?: unknown[] };
    expect(thread.ok).toBe(true);
    const memory = (await engine.invoke('personaMemory', 'pia')) as { ok: boolean };
    expect(memory.ok).toBe(true);
  });

  it('personaLearn appends one confirmed entry (header on creation) and refuses unknown personas', async () => {
    const ghost = (await engine.invoke('personaLearn', { id: 'ghost', entry: 'a lesson' })) as { ok: boolean; error?: string };
    expect(ghost.ok).toBe(false);
    expect(ghost.error).toContain('does not exist');

    await fsp.mkdir(path.join(vault, 'tickets/_meta/personas/pia'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'tickets/_meta/personas/pia/persona.md'), PIA_PERSONA, 'utf8');

    const learned = (await engine.invoke('personaLearn', { id: 'pia', entry: '- 2026-11-01 · T-0102 · handed-over' })) as { ok: boolean };
    expect(learned.ok).toBe(true);
    expect(await fsp.readFile(path.join(vault, 'tickets/_meta/personas/pia/memory.md'), 'utf8')).toBe(
      '# Memory\n\n- 2026-11-01 · T-0102 · handed-over\n',
    );

    // One line, always: a multiline dialog entry flattens.
    await engine.invoke('personaLearn', { id: 'pia', entry: '- second lesson\n  spread over two lines' });
    expect(await fsp.readFile(path.join(vault, 'tickets/_meta/personas/pia/memory.md'), 'utf8')).toBe(
      '# Memory\n\n- 2026-11-01 · T-0102 · handed-over\n- second lesson spread over two lines\n',
    );

    const blank = (await engine.invoke('personaLearn', { id: 'pia', entry: '   ' })) as { ok: boolean; error?: string };
    expect(blank.ok).toBe(false);
  });

  it('migrates legacy column keys onto personas with one commit, idempotently', async () => {
    await gitInitVault();
    await fsp.writeFile(path.join(vault, 'tickets/_meta/pipeline.md'), LEGACY_PIPELINE, 'utf8');
    await fsp.mkdir(path.join(vault, 'tickets/_meta/prompts'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'tickets/_meta/prompts/build-v2.md'), 'Build prompt text.', 'utf8');
    await git(['add', '-A']);
    await git(['commit', '-m', 'seed']);

    await engine.invoke('refresh');

    // The persona directory carries the column's old configuration.
    const personaText = await fsp.readFile(path.join(vault, 'tickets/_meta/personas/build-v2/persona.md'), 'utf8');
    expect(personaText).toContain('title: build v2');
    expect(personaText).toContain('worker: opencode');
    expect(personaText).toContain('default: opus');
    expect(personaText).toContain('pool: [opus]');
    expect(await fsp.readFile(path.join(vault, 'tickets/_meta/personas/build-v2/prompt.md'), 'utf8')).toBe('Build prompt text.');

    // The phase rewrote to persona: — legacy keys gone, the handover stays (the column keeps draining).
    const pipelineText = await fsp.readFile(path.join(vault, 'tickets/_meta/pipeline.md'), 'utf8');
    expect(pipelineText).toContain('persona: build-v2');
    expect(pipelineText).toContain('handover: agent build-default');
    expect(pipelineText).not.toContain('worker: opencode');
    expect(pipelineText).not.toContain('model: opus');
    expect(pipelineText).not.toContain('prompt: build-v2');
    const snapshot = (await engine.invoke('snapshot')) as { pipeline: readonly { id: string; persona: string | null }[] };
    expect(snapshot.pipeline.find((p) => p.id === 'build')?.persona).toBe('build-v2');

    expect((await git(['log', '-1', '--format=%s'])).trim()).toBe('tickets: personas migrated');

    // Idempotent: the next refresh changes nothing and commits nothing.
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    await engine.invoke('refresh');
    expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await fsp.readFile(path.join(vault, 'tickets/_meta/pipeline.md'), 'utf8')).toBe(pipelineText);
  });

  it('migrates a worker-only column to a <phase>-default persona with an empty prompt.md', async () => {
    await gitInitVault();
    await fsp.writeFile(
      path.join(vault, 'tickets/_meta/pipeline.md'),
      LEGACY_PIPELINE.replace(', model: opus, prompt: build-v2', ''),
      'utf8',
    );
    await git(['add', '-A']);
    await git(['commit', '-m', 'seed']);

    await engine.invoke('refresh');

    const personaText = await fsp.readFile(path.join(vault, 'tickets/_meta/personas/build-default/persona.md'), 'utf8');
    expect(personaText).toContain('title: build default');
    expect(personaText).toContain('worker: opencode');
    // The prompts file was never there: the persona still lands, prompt empty.
    expect(await fsp.readFile(path.join(vault, 'tickets/_meta/personas/build-default/prompt.md'), 'utf8')).toBe('');
    const pipelineText = await fsp.readFile(path.join(vault, 'tickets/_meta/pipeline.md'), 'utf8');
    expect(pipelineText).toContain('persona: build-default');
    expect(pipelineText).not.toContain('worker: opencode');
  });

  it('leaves the pipeline alone when every derived persona already exists', async () => {
    await gitInitVault();
    await fsp.writeFile(path.join(vault, 'tickets/_meta/pipeline.md'), LEGACY_PIPELINE, 'utf8');
    // The owner hand-wrote the persona the column would derive.
    await fsp.mkdir(path.join(vault, 'tickets/_meta/personas/build-v2'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'tickets/_meta/personas/build-v2/persona.md'), PIA_PERSONA, 'utf8');
    await git(['add', '-A']);
    await git(['commit', '-m', 'seed']);
    const head = (await git(['rev-parse', 'HEAD'])).trim();

    await engine.invoke('refresh');

    // No rewrite, no commit: the owner's files stay exactly as written.
    expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(head);
    const pipelineText = await fsp.readFile(path.join(vault, 'tickets/_meta/pipeline.md'), 'utf8');
    expect(pipelineText).toContain('worker: opencode');
    expect(pipelineText).not.toContain('persona:');
    expect(await fsp.readFile(path.join(vault, 'tickets/_meta/personas/build-v2/persona.md'), 'utf8')).toBe(PIA_PERSONA);
  });
});


const VERIFY_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: verify, title: Verify, handover: none }
  - { id: needs-owner, title: Needs owner, handover: manual }
---
The pipeline.
`;

const VERIFY_REPOS = `---
repos:
  demo:
    url: https://example.com/demo.git
    branch: main
    launch: npm run demo:app
---
Work repos.
`;

/** A 1x1 transparent PNG — the fake harness's "screenshot". */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('verify (E4)', () => {
  let harnessInput: VerifyRunInput | null = null;

  beforeEach(async () => {
    await engine.close();
    harnessInput = null;
    await fsp.writeFile(path.join(vault, 'tickets/_meta/pipeline.md'), VERIFY_PIPELINE, 'utf8');
    await fsp.writeFile(path.join(vault, 'tickets/_meta/repos.md'), VERIFY_REPOS, 'utf8');
    await gitInitVault();
    await git(['add', '-A']);
    await git(['commit', '-m', 'seed']);
    const fakeHarness: VerifyHarness = {
      async run(input: VerifyRunInput): Promise<VerifyRunResult> {
        harnessInput = input;
        const file = 'verify-test-01.png';
        await fsp.mkdir(input.attachDir, { recursive: true });
        await fsp.writeFile(path.join(input.attachDir, file), Buffer.from(PNG_1PX, 'base64'));
        return {
          environment: 'Electron test on win32',
          shots: [{ file, criterion: input.criteria[0] ?? null }],
          findings: [],
          video: null,
          error: null,
        };
      },
    };
    engine = await createEngine({
      vaultPath: vault,
      home,
      clientDir: path.join(root, 'client'),
      log: () => undefined,
      verifyHarness: fakeHarness,
    });
  });

  it('persists the proofs as one commit and moves the ticket to the owner', async () => {
    const created = (await engine.invoke('createTicket', {
      title: 'Verify me',
      priority: 'normal',
      repo: 'demo',
      description: ['The body.', '', '### Acceptance criteria', '', '- [x] `npm run build`', '- [ ] `npm test`'].join('\n'),
    })) as { ok: boolean; id?: string };
    expect(created.ok).toBe(true);
    const id = created.id!;

    const moved = (await engine.invoke('transition', { id, from: 'inbox', to: 'verify' })) as { ok: boolean };
    expect(moved.ok).toBe(true);
    await fsp.mkdir(path.join(vault, '_worktrees', id), { recursive: true });

    const outcome = (await engine.invoke('verifyTicket', { id })) as { ok: boolean; error?: string };
    expect(outcome).toEqual({ ok: true });

    // The harness got the resolved worktree, the repo's launch command and the criteria.
    expect(harnessInput).not.toBeNull();
    expect(harnessInput!.worktree).toBe(path.join(vault, '_worktrees', id));
    expect(harnessInput!.command).toBe('npm run demo:app');
    expect(harnessInput!.criteria).toEqual(['npm run build', 'npm test']);
    expect(harnessInput!.judge).toBeNull();

    // The proof card: the section, the tested line, both criteria, the screenshot link.
    const snapshot = (await engine.invoke('snapshot')) as {
      columns: { phase: { id: string }; tickets: { id: string; path: string }[] }[];
    };
    const ownerColumn = snapshot.columns.find((c) => c.phase.id === 'needs-owner')!;
    expect(ownerColumn.tickets.map((t) => t.id)).toContain(id);
    expect(snapshot.columns.find((c) => c.phase.id === 'verify')!.tickets).toEqual([]);
    const cardPath = ownerColumn.tickets.find((t) => t.id === id)!.path;
    const text = await fsp.readFile(path.join(vault, cardPath), 'utf8');
    expect(text).toContain('## Verification');
    expect(text).toMatch(new RegExp(`Tested on \\S+ by verify@${hostname().toLowerCase()} — Electron test on win32\\.`));
    expect(text).toContain('- [x] `npm run build` → ![](../attachments/verify-test-01.png)');
    expect(text).toContain('- [ ] `npm test` — no screenshot');
    expect(text).toContain('verified — 1/2 criteria green');

    // The screenshot landed in the vault's attachments folder.
    await expect(fsp.stat(path.join(vault, 'tickets/attachments/verify-test-01.png'))).resolves.toBeDefined();

    // The story: the verify commit covers the ticket file and the screenshot,
    // then the move commit follows — no other commits.
    const subjects = (await git(['log', '--format=%s'])).trim().split('\n');
    expect(subjects).toEqual([
      `tickets: ${id} verify -> needs-owner`,
      `tickets: ${id} verified`,
      `tickets: ${id} inbox -> verify`,
      `tickets: ${id} + inbox`,
      'seed',
    ]);
    const names = await git(['show', '--name-only', '--format=', 'HEAD~1']);
    expect(names).toContain(`tickets/20-verify/${id}.md`);
    expect(names).toContain('tickets/attachments/verify-test-01.png');

    // The live state the proof card polls.
    const status = (await engine.invoke('verifyStatus', { id })) as VerifyStatus;
    expect(status).toEqual({
      ticket: id,
      state: 'done',
      error: null,
      report: {
        testedAt: expect.any(String),
        tester: `verify@${hostname().toLowerCase()}`,
        environment: 'Electron test on win32',
        criteria: [
          { command: 'npm run build', passed: true, screenshot: 'verify-test-01.png', note: null },
          { command: 'npm test', passed: false, screenshot: null, note: 'no screenshot' },
        ],
        findings: [],
      },
    });
  });
});

/**
 * E5a acceptance: the Mission Control chat engine behind the invoke
 * channel — a session file per conversation under `tickets/_meta/chat/`,
 * the mission turn streamed through onEvent as 'chat' changes, every
 * mutation a proposal card, and the owner's confirm the only executor
 * (through the same board methods the invoke channel exposes). The fake
 * bridge stands in for the LLM: no network, fixed envelope.
 */
describe('chat (E5a)', () => {
  let seeded: { id: string };
  let bridgeCalls: { text: string; history: readonly unknown[]; board: string }[];
  let turnCount: number;

  beforeEach(async () => {
    await engine.close();
    seeded = { id: '' };
    bridgeCalls = [];
    turnCount = 0;
    await git(['add', '-A']);
    await git(['commit', '-m', 'seed']);
    const fakeBridge: ChatBridge = {
      async runTurn(input) {
        bridgeCalls.push({ text: input.text, history: input.history, board: input.board });
        turnCount += 1;
        input.emit({ kind: 'thought', text: 'Reading the board.' });
        input.emit({ kind: 'text', text: turnCount === 1 ? 'Moving it to build.' : 'Noted.' });
        return {
          say: turnCount === 1 ? 'Moved it to build.' : 'Noted.',
          thought: 'The owner wants the seed ticket handled.',
          // Turn 1 proposes the move; a later turn proposes a priority
          // change that a dismiss must leave untouched.
          commands:
            turnCount === 1
              ? [{ kind: 'transition', id: seeded.id, from: 'inbox', to: 'build' }]
              : [{ kind: 'setPriority', id: seeded.id, priority: 'high' }],
        };
      },
    };
    engine = await createEngine({
      vaultPath: vault,
      home,
      clientDir: path.join(root, 'client'),
      log: () => undefined,
      chatBridge: fakeBridge,
    });
  });

  it('starts a session, streams the turn, lists it, and executes a confirmed proposal through the board', async () => {
    const created = (await engine.invoke('createTicket', {
      title: 'Chat seed',
      priority: 'normal',
      repo: null,
      description: '',
    })) as { ok: boolean; id?: string };
    expect(created.ok).toBe(true);
    seeded.id = created.id!;

    // Subscribe before the turn so every stream event is caught.
    const events: { what: string; payload?: { file: string; event: ChatStreamEvent } }[] = [];
    const unsubscribe = engine.onEvent((what, payload) => events.push({ what, payload }));

    const turn = (await engine.invoke('chatStart', { title: 'Move the seed', text: 'Move the seed ticket to build' })) as ChatTurnResult;
    unsubscribe();
    expect(turn.ok).toBe(true);
    expect(turn.error).toBeUndefined();

    // The session file landed under tickets/_meta/chat/.
    expect(turn.file!.startsWith(`${CHAT_DIR}/`)).toBe(true);
    const onDisk = await fsp.readFile(path.join(vault, turn.file!), 'utf8');
    expect(onDisk).toContain('Move the seed ticket to build');

    // The bridge got the message, the session history and a board digest.
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]!.text).toBe('Move the seed ticket to build');
    expect(Array.isArray(bridgeCalls[0]!.history)).toBe(true);
    expect(bridgeCalls[0]!.board.length).toBeGreaterThan(0);

    // The turn streamed through onEvent as 'chat' changes on this session.
    const chatEvents = events.filter((e) => e.what === 'chat');
    expect(chatEvents.length).toBeGreaterThan(0);
    for (const event of chatEvents) {
      expect(event.payload).toMatchObject({ file: turn.file });
    }
    expect(chatEvents.some((e) => e.payload!.event.kind === 'text' && e.payload!.event.text === 'Moving it to build.')).toBe(true);

    // The parsed session: owner + mission (with the thought) and the pending proposal.
    const session = parseSessionFile(onDisk, turn.file!)!;
    expect(session.file).toBe(turn.file);
    expect(session.title).toBe('Move the seed');
    expect(session.messages.map((m) => m.role)).toEqual(['owner', 'mission']);
    expect(session.messages[0]!.text).toBe('Move the seed ticket to build');
    expect(session.messages[1]!.text).toBe('Moved it to build.');
    expect(session.messages[1]!.thought).toBe('The owner wants the seed ticket handled.');
    expect(session.proposals).toHaveLength(1);
    expect(session.proposals[0]).toMatchObject({
      id: 'p-1',
      state: 'pending',
      decidedAt: null,
      outcome: null,
      command: { kind: 'transition', id: seeded.id, from: 'inbox', to: 'build' },
    });
    expect(session.proposals[0]!.summary.length).toBeGreaterThan(0);

    // The listing: one session, one pending card.
    const listed = (await engine.invoke('chatSessions')) as readonly ChatSessionMeta[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ file: turn.file, title: 'Move the seed', pending: 1 });
    expect(typeof listed[0]!.createdAt).toBe('string');
    expect(typeof listed[0]!.updatedAt).toBe('string');

    // chatOpen answers the same session (the invoke alias takes the raw file string).
    const opened = (await engine.invoke('chatOpen', turn.file)) as ReturnType<typeof parseSessionFile>;
    expect(opened).toMatchObject({ file: turn.file, title: 'Move the seed' });
    expect(opened!.proposals).toHaveLength(1);

    // The owner's confirm executes the proposal — through the board methods.
    const decision = (await engine.invoke('chatConfirm', { file: turn.file, id: 'p-1' })) as ChatDecisionResult;
    expect(decision.ok).toBe(true);
    expect(decision.proposal).toMatchObject({ id: 'p-1', state: 'confirmed' });

    // The decision line carries the outcome the execution reported.
    const confirmedText = await fsp.readFile(path.join(vault, turn.file!), 'utf8');
    expect(confirmedText).toMatch(/proposal p-1 confirmed — .+ → .+/);
    const confirmed = parseSessionFile(confirmedText, turn.file!)!;
    expect(confirmed.proposals[0]).toMatchObject({
      state: 'confirmed',
      decidedAt: expect.any(String),
      outcome: expect.any(String),
    });
    expect(confirmed.proposals[0]!.outcome!.length).toBeGreaterThan(0);

    // The move really happened: the ticket sits in build, the inbox is empty.
    const snapshot = (await engine.invoke('snapshot')) as { columns: { phase: { id: string }; tickets: { id: string }[] }[] };
    expect(snapshot.columns.find((c) => c.phase.id === 'build')!.tickets.map((t) => t.id)).toContain(seeded.id);
    expect(snapshot.columns.find((c) => c.phase.id === 'inbox')!.tickets).toEqual([]);
  });

  it('dismisses a proposal without executing it', async () => {
    const created = (await engine.invoke('createTicket', {
      title: 'Chat seed',
      priority: 'normal',
      repo: null,
      description: '',
    })) as { ok: boolean; id?: string };
    expect(created.ok).toBe(true);
    seeded.id = created.id!;

    const turn = (await engine.invoke('chatStart', { title: 'Handle it', text: 'Handle the seed ticket' })) as ChatTurnResult;
    expect(turn.ok).toBe(true);
    // The first turn's move proposal stays pending — nothing executed yet.
    const before = (await engine.invoke('snapshot')) as { columns: { phase: { id: string }; tickets: { id: string }[] }[] };
    expect(before.columns.find((c) => c.phase.id === 'inbox')!.tickets.map((t) => t.id)).toContain(seeded.id);

    // A second turn proposes a priority change; the owner dismisses it.
    const second = (await engine.invoke('chatSend', { file: turn.file, text: 'And raise it' })) as ChatTurnResult;
    expect(second.ok).toBe(true);
    expect(second.proposals).toHaveLength(1);
    const proposalId = second.proposals![0]!.id;

    const dismissed = (await engine.invoke('chatDismiss', { file: turn.file, id: proposalId })) as ChatDecisionResult;
    expect(dismissed.ok).toBe(true);
    expect(dismissed.proposal).toMatchObject({ id: proposalId, state: 'dismissed', outcome: null });

    // The dismissed line carries no outcome and the board is untouched:
    // the ticket stays in the inbox at normal priority.
    const text = await fsp.readFile(path.join(vault, turn.file!), 'utf8');
    expect(text).toContain(`proposal ${proposalId} dismissed`);
    expect(text).not.toMatch(new RegExp(`proposal ${proposalId} dismissed — .* → `));
    const session = parseSessionFile(text, turn.file!)!;
    expect(session.messages.map((m) => m.role)).toEqual(['owner', 'mission', 'owner', 'mission']);
    expect(session.proposals.map((p) => p.state)).toEqual(['pending', 'dismissed']);

    const snapshot = (await engine.invoke('snapshot')) as {
      columns: { phase: { id: string }; tickets: { id: string; meta: { priority: string } }[] }[];
    };
    const card = snapshot.columns.flatMap((c) => c.tickets).find((t) => t.id === seeded.id)!;
    expect(card.meta.priority).toBe('normal');
    expect(snapshot.columns.find((c) => c.phase.id === 'inbox')!.tickets.map((t) => t.id)).toContain(seeded.id);
  });
});

describe('invoke pair (M111/UX follow-up)', () => {
  it('a bare-string payload names the device — the proxy passes the first argument only', async () => {
    await engine.invoke('configSet', { key: 'remote.enabled', value: true });
    const status = (await engine.invoke('pair', 'ClaudeCode')) as {
      pairing: { deviceName: string | null } | null;
    };
    expect(status.pairing?.deviceName).toBe('ClaudeCode');
    await engine.invoke('cancelPairing');
  });

  it('an object payload carries deviceName and readOnly', async () => {
    await engine.invoke('configSet', { key: 'remote.enabled', value: true });
    const status = (await engine.invoke('pair', { deviceName: 'Pad', readOnly: true })) as {
      pairing: { deviceName: string | null; readOnly: boolean | null } | null;
    };
    expect(status.pairing?.deviceName).toBe('Pad');
    expect(status.pairing?.readOnly).toBe(true);
    await engine.invoke('cancelPairing');
  });
});
