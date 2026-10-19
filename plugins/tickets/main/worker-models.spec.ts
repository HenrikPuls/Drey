import { describe, expect, it } from 'vitest';
import { listWorkerModels, parseOpencodeModels } from './worker-models';

describe('parseOpencodeModels', () => {
  it('keeps providerID/modelID lines, drops noise and duplicates, sorts', () => {
    const out = '\u001b[32mzai-coding-plan/glm-5\u001b[0m\nINFO starting\nanthropic/claude-sonnet\nzai-coding-plan/glm-5\n\n';
    expect(parseOpencodeModels(out)).toEqual(['anthropic/claude-sonnet', 'zai-coding-plan/glm-5']);
  });
});

describe('listWorkerModels', () => {
  it('lists claude-code aliases without running anything', async () => {
    const res = await listWorkerModels('claude-code', () => Promise.reject(new Error('no')));
    expect(res.models).toContain('sonnet');
  });

  it('turns a failing CLI into an empty list with a note', async () => {
    const res = await listWorkerModels('opencode', () => Promise.reject(new Error('ENOENT')));
    expect(res.models).toEqual([]);
    expect(res.note).toMatch(/opencode models/);
  });

  it('caches a successful listing', async () => {
    let calls = 0;
    const exec = (): Promise<string> => {
      calls += 1;
      return Promise.resolve('a/b\n');
    };
    // The module cache may already hold a listing from another test run order.
    const t = Date.now() + 10_000_000;
    await listWorkerModels('opencode', exec, () => t);
    await listWorkerModels('opencode', exec, () => t + 1000);
    expect(calls).toBe(1);
  });
});
