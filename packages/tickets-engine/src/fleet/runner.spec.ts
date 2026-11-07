import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRunner, type RunnerHandle } from './runner';

/**
 * The runner's exit rules (req-110) against the real daemon, in-process:
 * `startRunner` boots the supervisors, the orchestrator and the loopback
 * server on a temp fleet root, with `process.exit` replaced by a recorder.
 * A live worker is not spawned here — the live-run side of the verdict is
 * `runner-lifecycle.spec.ts`'s and `fleet-client.spec.ts`'s.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, claim: true }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'Prose.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.test/drey.git', '    branch: main', '    path: W:/drey', '---', '', ''].join('\n');

describe('fleet runner exit (req-110)', () => {
  let root = '';
  let vault = '';
  let runner: RunnerHandle | null = null;
  const exits: number[] = [];
  const lines: string[] = [];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-runner-'));
    vault = path.join(root, 'vault');
    await fsp.mkdir(path.join(vault, 'tickets', '_meta', 'prompts'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
    await fsp.writeFile(path.join(vault, 'tickets', '_meta', 'repos.md'), REPOS, 'utf8');
    await fsp.writeFile(path.join(vault, 'tickets', '_meta', 'prompts', 'build-default.md'), 'Build it.', 'utf8');
    exits.length = 0;
    lines.length = 0;
    runner = await startRunner(
      { root: path.join(root, 'fleet'), idleMs: 60 * 60_000 },
      { exit: (code) => exits.push(code), stdout: (line) => lines.push(line) },
    );
    expect(runner).not.toBeNull();
  });

  afterEach(async () => {
    if (exits.length === 0) {
      await runner?.stop();
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const call = async (method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${runner!.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runner!.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const exited = async (): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (exits.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(exits).toEqual([0]);
  };

  const descriptorGone = (): Promise<boolean> => fsp.access(runner!.descriptorPath).then(() => false, () => true);

  it('writes its descriptor and reports no live run', async () => {
    expect(await descriptorGone()).toBe(false);
    const health = await call('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body['live']).toBe(0);
  });

  it('"Run the chain" on a runner without a chain config keeps it — an On / run request is never a deactivation', async () => {
    // No /chain/config yet: keepsRunnerAlive is false, exactly the fresh-vault case of the e2e.
    expect((await call('POST', '/chain/master', { mode: 'run' })).status).toBe(200);
    expect((await call('POST', '/chain/autopilot', { state: 'on' })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toEqual([]);
    expect(await descriptorGone()).toBe(false);
    expect((await call('GET', '/health')).status).toBe(200);
    // Halting it is the deactivation: now it goes.
    expect((await call('POST', '/chain/master', { mode: 'halted' })).status).toBe(200);
    await exited();
    expect(await descriptorGone()).toBe(true);
  });

  it('deactivated — the Autopilot switched Off with nothing live — it exits and removes runner.json', async () => {
    await call('POST', '/chain/config', { ticketsVaultPath: vault });
    const reply = await call('POST', '/chain/autopilot', { state: 'off' });
    expect(reply.status).toBe(200);
    await exited();
    expect(await descriptorGone()).toBe(true);
    expect(lines.some((line) => line.includes('the Autopilot is off and nothing is live'))).toBe(true);
    await expect(fetch(`http://127.0.0.1:${runner!.port}/health`)).rejects.toThrow();
  });

  it('retire-if-idle with live 0 and the Autopilot Off: gone, runner.json removed', async () => {
    const reply = await call('POST', '/retire-if-idle');
    expect(reply.body).toEqual({ ok: true, exiting: true });
    await exited();
    expect(await descriptorGone()).toBe(true);
  });

  it('retire-if-idle while the Autopilot is On: the runner stays and says why', async () => {
    await call('POST', '/chain/config', { ticketsVaultPath: vault });
    const on = await call('POST', '/chain/autopilot', { state: 'on' });
    expect(on.status).toBe(200);
    const reply = await call('POST', '/retire-if-idle');
    expect(reply.body).toEqual({ ok: true, exiting: false, reason: 'autopilot' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toEqual([]);
    expect(await descriptorGone()).toBe(false);
    expect((await call('GET', '/health')).status).toBe(200);
  });

  it('a Paused Autopilot keeps the runner as well — it is what resumes the chain', async () => {
    await call('POST', '/chain/config', { ticketsVaultPath: vault });
    const resumeAt = new Date(Date.now() + 60 * 60_000).toISOString();
    expect((await call('POST', '/chain/autopilot', { state: 'paused', resumeAt })).status).toBe(200);
    expect((await call('POST', '/retire-if-idle')).body).toEqual({ ok: true, exiting: false, reason: 'autopilot' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toEqual([]);
  });

  it('an unknown route answers 404 — what a runner from before this build says to retire-if-idle', async () => {
    const reply = await call('POST', '/no-such-route');
    expect(reply.status).toBe(404);
  });
});
