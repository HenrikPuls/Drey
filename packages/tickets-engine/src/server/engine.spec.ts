import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
