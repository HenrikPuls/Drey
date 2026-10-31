import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import {
  contextFill,
  execClockMs,
  fleetSummary,
  formatTokens,
  spanClock,
  STALL_MS,
  telemetryParts,
  workerStatus,
} from './worker-status';

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
    expect(contextFill(run({ contextTokens: 50_000 }))).toBe(0.25);
    expect(contextFill(run({ contextTokens: 300_000 }))).toBe(1);
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

describe('telemetryParts — the run\'s telemetry as short chips', () => {
  it('is empty while the run reports nothing (and for pre-T-0048 records)', () => {
    expect(telemetryParts(run())).toEqual([]);
    expect(telemetryParts(run({ lastTurnContext: null }))).toEqual([]);
  });

  it('shows the last turn\'s context, the turns and the read calls', () => {
    expect(telemetryParts(run({ lastTurnContext: 131_000, turns: 14, readCalls: 21 }))).toEqual([
      'ctx 131k',
      'turns 14',
      'reads 21',
    ]);
    expect(telemetryParts(run({ lastTurnContext: 9_500, turns: 2 }))).toEqual(['ctx 9.5k', 'turns 2']);
  });

  it('never invents a zero out of an absent counter', () => {
    expect(telemetryParts(run({ turns: 0, readCalls: 0 }))).toEqual([]);
  });

  it('appends the resumed chip for a resumed run — fresh and absent stay silent (T-0049)', () => {
    expect(telemetryParts(run({ handoverMode: 'resume', lastTurnContext: 131_000 }))).toEqual(['ctx 131k', 'resumed']);
    expect(telemetryParts(run({ handoverMode: 'resume-compact' }))).toEqual(['resumed']);
    expect(telemetryParts(run({ handoverMode: 'fresh' }))).toEqual([]);
    expect(telemetryParts(run({ handoverMode: undefined }))).toEqual([]);
  });
});

describe('spanClock', () => {
  it('is mm:ss and rolls hours into h:mm:ss', () => {
    expect(spanClock(0)).toBe('00:00');
    expect(spanClock(221_000)).toBe('03:41');
    expect(spanClock(3_723_000)).toBe('1:02:03');
    expect(spanClock(-5_000)).toBe('00:00');
  });
});

describe('execClockMs — the elapsed clock counts only working time (req-67)', () => {
  it('falls back to the wall clock for records without exec fields', () => {
    expect(execClockMs(run(), NOW)).toBe(3_600_000);
  });

  it('freezes that fallback at the run\'s end instead of ticking on', () => {
    const ended = run({ state: 'done', endedAt: '2026-10-18T11:30:00Z' });
    expect(execClockMs(ended, NOW)).toBe(1_800_000);
    expect(execClockMs(ended, NOW + 5 * 60_000)).toBe(1_800_000);
  });

  it('adds the open span to the closed working time', () => {
    const working = run({ execMs: 1_800_000, execSince: '2026-10-18T11:50:00Z' });
    expect(execClockMs(working, NOW)).toBe(2_400_000);
    expect(execClockMs(working, NOW + 60_000)).toBe(2_460_000);
  });

  it('stands still while nothing is open — a wait, standing, ended', () => {
    const standing = run({ execMs: 1_800_000, execSince: null });
    expect(execClockMs(standing, NOW)).toBe(1_800_000);
    expect(execClockMs(standing, NOW + 10 * 60_000)).toBe(1_800_000);
  });
});

describe('workerStatus — a detached run', () => {
  it('is amber and says so (the runner lost its worker)', () => {
    expect(workerStatus(run({ state: 'detached' }), NOW)).toEqual({ light: 'amber', label: 'Detached' });
  });
});

describe('workerStatus — a worker that waits on the owner (req-64)', () => {
  it('is amber with what it waits for, never stalled however long the wait', () => {
    const silent = new Date(NOW - 60 * 60_000).toISOString();
    expect(
      workerStatus(run({ turn: 'idle', lastActivity: silent, waiting: { kind: 'question', text: 'Q', since: silent } }), NOW),
    ).toEqual({ light: 'amber', label: 'Waits for your answer' });
    expect(
      workerStatus(run({ turn: 'busy', waiting: { kind: 'permission', text: 'bash x', since: silent, requestId: 'p' } }), NOW),
    ).toEqual({ light: 'amber', label: 'Waits for your approval' });
  });
});

describe('workerStatus — running or standing', () => {
  it('says Running for a worker in the middle of a turn', () => {
    expect(workerStatus(run({ turn: 'busy' }), NOW)).toEqual({ light: 'green', label: 'Running' });
  });

  it('says Standing for a worker with no turn in progress, never stalled', () => {
    const silent = new Date(NOW - 20 * 60_000).toISOString();
    expect(workerStatus(run({ turn: 'idle', lastActivity: silent }), NOW)).toEqual({ light: 'idle', label: 'Standing' });
  });

  it('says whose turn it is when the owner holds a standing worker', () => {
    expect(workerStatus(run({ turn: 'idle', held: true }), NOW).label).toBe('Standing — you drive');
  });
});

describe('fleetSummary', () => {
  it('is null without live runs', () => {
    expect(fleetSummary([], NOW)).toBeNull();
  });

  it('counts the states in words, takes the worst light, sums tokens and ages from the oldest start', () => {
    const silent = new Date(NOW - STALL_MS).toISOString();
    const summary = fleetSummary(
      [
        run({ tokensIn: 1_000, tokensOut: 200 }),
        run({ id: 'r2', turn: 'idle', startedAt: '2026-10-18T10:30:00Z', tokensIn: 500 }),
        run({ id: 'r3', lastActivity: silent }),
      ],
      NOW,
    );
    expect(summary).toEqual({ light: 'red', label: '1 running · 1 standing · 1 stalled', tokens: 1_700, ageMs: 90 * 60_000 });
  });

  it('is green for working runs alone', () => {
    expect(fleetSummary([run(), run({ id: 'r2' })], NOW)).toMatchObject({ light: 'green', label: '2 running' });
  });
});
