import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import { createServiceQuitGuard, liveRunsOf, quitWordsOf, type QuitChoice } from './service-quit-guard';

/**
 * Closing Drey with the background service off (the owner's Q3 ruling,
 * req-164): live runs would end with Drey, so the owner is asked — stop
 * them, keep them (the service switches on), or stay.
 */
const run = (id: string, state: string): RunInfo => ({ id, state }) as unknown as RunInfo;

function harness(opts: { enabled?: boolean; runs?: RunInfo[]; choice?: QuitChoice }) {
  const config = new Map<string, unknown>(opts.enabled === undefined ? [] : [['service.enabled', opts.enabled]]);
  const calls: string[] = [];
  const asked: number[] = [];
  const guard = createServiceQuitGuard({
    config: {
      get: async <T,>(key: string) => config.get(key) as T | undefined,
      set: async (key, value) => {
        config.set(key, value);
        calls.push(`set ${key}=${String(value)}`);
      },
    },
    runs: async () => opts.runs ?? [],
    abortAll: async () => calls.push('abortAll'),
    configSet: async (key, value) => calls.push(`engine ${key}=${String(value)}`),
    ask: async (count) => {
      asked.push(count);
      return opts.choice ?? 'cancel';
    },
    log: () => undefined,
  });
  return { guard, calls, asked, config };
}

describe('the quit guard of the optional service', () => {
  it('nothing live: Drey closes without a question', async () => {
    const h = harness({ runs: [run('R-1', 'done')] });
    expect(await h.guard()).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it('the service is on: the runs outlive Drey, no question', async () => {
    const h = harness({ enabled: true, runs: [run('R-1', 'running')] });
    expect(await h.guard()).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it('live runs with the service off: asked with the count (a run listed twice counts once)', async () => {
    const h = harness({ runs: [run('R-1', 'running'), run('R-1', 'running'), run('R-2', 'starting'), run('R-3', 'stopped')] });
    await h.guard();
    expect(h.asked).toEqual([2]);
  });

  it('Cancel keeps Drey open and changes nothing', async () => {
    const h = harness({ runs: [run('R-1', 'running')], choice: 'cancel' });
    expect(await h.guard()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('Stop the runs and quit: the Notaus, then Drey closes', async () => {
    const h = harness({ runs: [run('R-1', 'running')], choice: 'stop' });
    expect(await h.guard()).toBe(true);
    expect(h.calls).toEqual(['abortAll']);
  });

  it('Keep running: the service is switched on (plugin config and engine), nothing is stopped', async () => {
    const h = harness({ runs: [run('R-1', 'running')], choice: 'keep' });
    expect(await h.guard()).toBe(true);
    expect(h.calls).toEqual(['set service.enabled=true', 'engine service.enabled=true']);
  });

  it('the live states are starting, running and stopping', () => {
    expect(liveRunsOf(['starting', 'running', 'stopping', 'done', 'failed', 'detached'].map((s, i) => run(`R-${i}`, s))).map((r) => r.state)).toEqual([
      'starting',
      'running',
      'stopping',
    ]);
  });

  it('the words come from the catalog, the count passed for its ICU plural', () => {
    const t = (key: string, params?: Record<string, unknown>): string => `${key}${params === undefined ? '' : JSON.stringify(params)}`;
    expect(quitWordsOf(t, 3)).toEqual({
      message: 'service.quit.message{"count":3}',
      detail: 'service.quit.detail',
      stop: 'service.quit.stop',
      keep: 'service.quit.keep',
      cancel: 'service.quit.cancel',
    });
    const catalog = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'shared', 'i18n', 'catalog', 'en.json'), 'utf8')) as Record<string, string>;
    expect(catalog['service.quit.message']).toContain('{count, plural');
    for (const key of ['service.quit.detail', 'service.quit.stop', 'service.quit.keep', 'service.quit.cancel']) {
      expect(typeof catalog[key]).toBe('string');
    }
  });
});
