import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Args, RunnerDeps, RunnerHandle } from '../fleet/runner';
import { RunnerComponent } from './runner-component';

/**
 * The Crew runner as a component of Drey Service (req-164): woken in the
 * service's own process, asleep — not gone — when req-110 lets it go,
 * woken again on the next demand. The real daemon runs in the last block.
 */
describe('RunnerComponent lifecycle (fake runner)', () => {
  let starts: { args: Args; deps: RunnerDeps }[] = [];
  let changes = 0;

  const fakeStart = async (args: Args, deps: RunnerDeps): Promise<RunnerHandle> => {
    starts.push({ args, deps });
    const n = starts.length;
    return {
      port: 5000 + n,
      token: `t${n}`,
      descriptorPath: '',
      descriptor: { port: 5000 + n, token: `t${n}`, pid: process.pid, startedAt: '', version: 1, build: 'b' },
      stop: async () => deps.exit?.(0),
    };
  };

  const component = (storeBacked = false, start = fakeStart): RunnerComponent =>
    new RunnerComponent({ root: 'F:/fleet', storeBacked: async () => storeBacked, log: () => undefined, onChange: () => changes++, start });

  beforeEach(() => {
    starts = [];
    changes = 0;
  });

  it('sleeps until asked; a wake starts it in-process with no descriptor file and no signal handlers', async () => {
    const runner = component();
    expect(await runner.current()).toBeNull();
    expect(runner.record()).toEqual({ state: 'sleeping', detail: 'wakes on demand' });
    const woke = await runner.wake();
    expect(woke).toMatchObject({ ok: true, descriptor: { port: 5001 } });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.deps).toMatchObject({ descriptor: 'none', signals: false });
    expect(runner.record()).toMatchObject({ state: 'running', port: 5001, token: 't1' });
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('two wakes at once start one runner', async () => {
    const runner = component();
    const [a, b] = await Promise.all([runner.wake(), runner.wake()]);
    expect(a).toEqual(b);
    expect(starts).toHaveLength(1);
  });

  it("the runner's exit puts it to sleep; the next demand wakes a fresh one", async () => {
    const runner = component();
    await runner.wake();
    starts[0]!.deps.exit?.(0);
    expect(runner.awake).toBe(false);
    expect(await runner.current()).toBeNull();
    expect(runner.record().state).toBe('sleeping');
    expect(await runner.wake()).toMatchObject({ ok: true, descriptor: { port: 5002 } });
  });

  it('D-42: a store-backed board is told at the wake', async () => {
    await component(true).wake();
    expect(starts[0]!.args.storeBacked).toBe(true);
  });

  it('a start that fails is a failed row and a refusal that names why', async () => {
    const runner = component(false, async () => {
      throw new Error('EEXIST: file already exists, mkdir F:/fleet');
    });
    expect(await runner.wake()).toEqual({ ok: false, error: 'EEXIST: file already exists, mkdir F:/fleet' });
    expect(runner.record()).toEqual({ state: 'failed', detail: 'EEXIST: file already exists, mkdir F:/fleet' });
  });

  it('a blocked wake (an older runner still in its gate) is refused until unblocked', async () => {
    const runner = component();
    runner.block('an older fleet runner (pid 9) hands its runs over once it is free');
    expect(await runner.wake()).toMatchObject({ ok: false, error: expect.stringContaining('pid 9') as unknown as string });
    expect(starts).toHaveLength(0);
    runner.block(null);
    expect((await runner.wake()).ok).toBe(true);
  });
});

describe('RunnerComponent over the real daemon', () => {
  let root = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-runner-component-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('wakes, writes no runner.json, sleeps on retire-if-idle, and wakes again on a new port', async () => {
    const fleet = path.join(root, 'fleet');
    const runner = new RunnerComponent({ root: fleet, idleMs: 60 * 60_000, storeBacked: async () => false, log: () => undefined, onChange: () => undefined });
    const first = await runner.wake();
    expect(first.ok).toBe(true);
    const descriptor = first.ok ? first.descriptor : null;
    const health = await fetch(`http://127.0.0.1:${descriptor!.port}/health`, { headers: { Authorization: `Bearer ${descriptor!.token}` } });
    expect(health.status).toBe(200);
    await expect(fsp.access(path.join(fleet, 'runner.json'))).rejects.toThrow();

    const reply = await fetch(`http://127.0.0.1:${descriptor!.port}/retire-if-idle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${descriptor!.token}` },
    });
    expect(await reply.json()).toEqual({ ok: true, exiting: true });
    const deadline = Date.now() + 5_000;
    while (runner.awake && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runner.awake).toBe(false);
    expect(runner.record().state).toBe('sleeping');

    const second = await runner.wake();
    expect(second.ok).toBe(true);
    await runner.stop();
    expect(runner.awake).toBe(false);
  });
});
