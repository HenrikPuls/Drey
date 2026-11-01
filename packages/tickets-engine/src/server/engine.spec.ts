import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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
