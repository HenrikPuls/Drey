import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import { contextFill, formatTokens, lanesOfColumn, opensByItself, STALL_MS, workerStatus } from './worker-status';

const NOW = Date.parse('2026-10-18T12:00:00Z');

const run = (patch: Partial<RunInfo> = {}): RunInfo => ({
  id: 'r1',
  ticketId: 'T-0001',
  provider: 'opencode',
  state: 'running',
  pid: 1,
  startedAt: '2026-10-18T11:00:00Z',
  endedAt: null,
  sessionRef: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: null,
  lastActivity: '2026-10-18T11:59:30Z',
  steerCount: 0,
  lastSteerRung: null,
  worktreePath: 'x',
  branch: 't/T-0001',
  gateFailure: null,
  ...patch,
});

describe('workerStatus', () => {
  it('is green while the worker is producing output', () => {
    expect(workerStatus(run(), NOW)).toEqual({ light: 'green', label: 'Working' });
  });

  it('is red once a running worker has been silent for the stall time', () => {
    const silent = new Date(NOW - STALL_MS).toISOString();
    const status = workerStatus(run({ lastActivity: silent }), NOW);
    expect(status.light).toBe('red');
    expect(status.label).toBe('Stalled 5m');
  });

  it('is amber when the context is nearly full', () => {
    const status = workerStatus(run({ contextTokens: 170_000 }), NOW);
    expect(status).toEqual({ light: 'amber', label: 'Context full' });
  });

  it('lets a stall win over a full context', () => {
    const silent = new Date(NOW - 10 * 60_000).toISOString();
    expect(workerStatus(run({ lastActivity: silent, contextTokens: 190_000 }), NOW).light).toBe('red');
  });

  it('is amber while stopping', () => {
    expect(workerStatus(run({ state: 'stopping' }), NOW).light).toBe('amber');
  });
});

describe('contextFill', () => {
  it('is null without a reported context size', () => {
    expect(contextFill(run())).toBeNull();
    expect(contextFill(run({ contextTokens: null }))).toBeNull();
  });

  it('is the share of the window, capped at 1', () => {
    expect(contextFill(run({ contextTokens: 50_000 }), 200_000)).toBe(0.25);
    expect(contextFill(run({ contextTokens: 300_000 }), 200_000)).toBe(1);
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(9_100)).toBe('9.1k');
    expect(formatTokens(182_000)).toBe('182k');
    expect(formatTokens(3_400_000)).toBe('3.4M');
  });
});

describe('lanes', () => {
  it('opens only the lanes that are not green', () => {
    expect(opensByItself({ light: 'green', label: 'Working' })).toBe(false);
    expect(opensByItself({ light: 'red', label: 'Stalled 6m' })).toBe(true);
  });

  it('collects the runs of one column, oldest first', () => {
    const runs = [
      run({ id: 'b', column: 'build', startedAt: '2026-10-18T11:30:00Z' }),
      run({ id: 'a', column: 'build', startedAt: '2026-10-18T11:00:00Z' }),
      run({ id: 'c', column: 'plan' }),
    ];
    expect(lanesOfColumn(runs, 'build').map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('workerStatus — a detached run', () => {
  it('is amber and says so (the runner lost its worker)', () => {
    expect(workerStatus(run({ state: 'detached' }), NOW)).toEqual({ light: 'amber', label: 'Detached' });
  });
});
