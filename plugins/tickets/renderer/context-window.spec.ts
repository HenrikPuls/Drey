import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import { contextFill, contextLabel, DEFAULT_CONTEXT_WINDOW, workerStatus } from './worker-status';

/**
 * T-0052: the context bar measures against the window the worker
 * reported (`RunInfo.contextWindow`); the old hardcoded 200k stays only
 * as the fallback when nothing was reported.
 */

const NOW = Date.parse('2026-10-18T12:00:00Z');

const run = (patch: Partial<RunInfo> = {}): RunInfo => ({
  id: 'r1',
  ticketId: 'T-0052',
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
  branch: 't/T-0052',
  gateFailure: null,
  ...patch,
});

describe('contextFill — the reported window is the denominator', () => {
  it('150k of a 1M window is 15%, not the 200k fill', () => {
    expect(contextFill(run({ contextTokens: 150_000, contextWindow: 1_000_000 }))).toBe(0.15);
  });

  it('still caps at 1 when the used context exceeds the window', () => {
    expect(contextFill(run({ contextTokens: 1_200_000, contextWindow: 1_000_000 }))).toBe(1);
  });

  it('falls back to the default window when none was reported', () => {
    expect(contextFill(run({ contextTokens: 100_000 }))).toBe(100_000 / DEFAULT_CONTEXT_WINDOW);
    expect(contextFill(run({ contextTokens: 100_000, contextWindow: null }))).toBe(100_000 / DEFAULT_CONTEXT_WINDOW);
  });

  it('is null without a used context, whatever the window', () => {
    expect(contextFill(run({ contextWindow: 1_000_000 }))).toBeNull();
    expect(contextFill(run({ contextTokens: null, contextWindow: 1_000_000 }))).toBeNull();
  });
});

describe('workerStatus — a 1M model must not warn from the first call', () => {
  it('150k of 1M stays green Working', () => {
    expect(workerStatus(run({ contextTokens: 150_000, contextWindow: 1_000_000 }), NOW)).toEqual({
      light: 'green',
      label: 'Working',
    });
  });

  it('170k with no reported window still warns against the 200k fallback', () => {
    expect(workerStatus(run({ contextTokens: 170_000 }), NOW)).toEqual({ light: 'amber', label: 'Context full' });
  });

  it('850k of 1M warns at the threshold, not before it', () => {
    expect(workerStatus(run({ contextTokens: 790_000, contextWindow: 1_000_000 }), NOW).light).toBe('green');
    expect(workerStatus(run({ contextTokens: 810_000, contextWindow: 1_000_000 }), NOW)).toEqual({
      light: 'amber',
      label: 'Context full',
    });
  });
});

describe('contextLabel — the lane row text', () => {
  it('spells used / window · fill% against the reported window', () => {
    expect(contextLabel(run({ contextTokens: 150_000, contextWindow: 1_000_000 }))).toBe('Context 150k / 1.0M · 15%');
  });

  it('falls back to the default window in the text', () => {
    expect(contextLabel(run({ contextTokens: 170_000 }))).toBe('Context 170k / 200k · 85%');
  });

  it('says not-reported while the worker has reported no context size', () => {
    expect(contextLabel(run({ contextWindow: 1_000_000 }))).toBe('Context — not reported yet');
    expect(contextLabel(run())).toBe('Context — not reported yet');
  });
});
