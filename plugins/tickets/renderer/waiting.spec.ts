import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import { newWaits } from './waiting';

const run = (overrides: Partial<RunInfo>): RunInfo =>
  ({
    id: 'R-1',
    ticketId: 'T-0042',
    provider: 'opencode',
    state: 'running',
    pid: 1,
    startedAt: '2026-10-20T10:00:00Z',
    endedAt: null,
    sessionRef: 'ses',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: null,
    lastActivity: '2026-10-20T10:00:00Z',
    steerCount: 0,
    lastSteerRung: null,
    worktreePath: 'W',
    branch: 't/T-0042',
    gateFailure: null,
    ...overrides,
  }) as RunInfo;

describe('newWaits — what a snapshot announces (req-64)', () => {
  it('announces a new question once, and again only when the worker asks anew', () => {
    const seen = new Set<string>();
    const asking = run({ waiting: { kind: 'question', text: 'Which API?', since: '2026-10-20T10:05:00Z' } });
    expect(newWaits([asking], seen)).toEqual([{ run: asking, title: 'T-0042 asks you', body: 'Which API?' }]);
    expect(newWaits([asking], seen)).toEqual([]);
    const again = run({ waiting: { kind: 'question', text: 'And the name?', since: '2026-10-20T10:09:00Z' } });
    expect(newWaits([again], seen).map((n) => n.body)).toEqual(['And the name?']);
  });

  it('names an approval, skips ended runs and runs that wait for nothing', () => {
    const seen = new Set<string>();
    const approval = run({ id: 'R-2', waiting: { kind: 'permission', text: 'bash rm -rf dist', since: 'x', requestId: 'p1' } });
    const ended = run({ id: 'R-3', state: 'done', waiting: { kind: 'question', text: 'late', since: 'y' } });
    expect(newWaits([approval, ended, run({ id: 'R-4' })], seen).map((n) => n.title)).toEqual(['T-0042 needs your approval']);
  });

  it('forgets an answered wait, so the same run can ask the same thing later', () => {
    const seen = new Set<string>();
    const asking = run({ waiting: { kind: 'question', text: 'Q', since: 's1' } });
    newWaits([asking], seen);
    newWaits([run({ waiting: null })], seen);
    expect(seen.size).toBe(0);
  });
});
