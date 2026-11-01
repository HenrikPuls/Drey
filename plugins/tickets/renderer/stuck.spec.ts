import { describe, expect, it } from 'vitest';
import { recentActions, stuckOf, STUCK_NO_EDIT_MIN, STUCK_REPEATS } from './stuck';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import type { NormalizedEvent } from '../../../packages/tickets-engine/src/fleet/providers';

const NOW = Date.parse('2026-10-31T12:00:00Z');

/** An ISO stamp this many minutes before NOW. */
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

const run = (over: Partial<RunInfo> = {}): RunInfo => ({
  id: 'R-1',
  ticketId: 'T-0001',
  provider: 'opencode',
  state: 'running',
  pid: 1,
  startedAt: iso(30),
  endedAt: null,
  sessionRef: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: null,
  lastActivity: iso(0),
  steerCount: 0,
  lastSteerRung: null,
  worktreePath: 'wt',
  branch: 't/T-0001',
  gateFailure: null,
  ...over,
});

/** A tool call with its input, as either adapter writes it. */
const call = (tool: string, target: string, minutesAgo: number, kind: 'note' | 'tool' = 'note'): NormalizedEvent => ({
  ts: iso(minutesAgo),
  kind,
  text: `${tool} ${target}`,
  ...(kind === 'tool' ? { tool } : {}),
});

/** A call's outcome, as both adapters write it. */
const outcome = (text: string, minutesAgo: number): NormalizedEvent => ({
  ts: iso(minutesAgo),
  kind: 'note',
  text: `result › ${text}`,
});

const NOT_STUCK = { stuck: false, minutesWithoutEdit: null, repeatedReads: 0 };

describe('stuckOf (req-75 W4b)', () => {
  it('exposes the thresholds the hint words read', () => {
    expect(STUCK_NO_EDIT_MIN).toBe(8);
    expect(STUCK_REPEATS).toBe(4);
  });

  it('a waiting run is never stuck, however long it stands', () => {
    const events = [call('read', 'src/a.ts', 40)];
    const verdict = stuckOf(run({ waiting: { kind: 'question', text: 'Go on?', since: iso(40) } }), events, NOW);
    expect(verdict).toEqual(NOT_STUCK);
  });

  it('an idle run is never stuck', () => {
    expect(stuckOf(run({ turn: 'idle' }), [call('read', 'src/a.ts', 40)], NOW)).toEqual(NOT_STUCK);
  });

  it('a detached or ended run is never stuck', () => {
    expect(stuckOf(run({ state: 'detached' }), [], NOW)).toEqual(NOT_STUCK);
    expect(stuckOf(run({ state: 'done', endedAt: iso(1) }), [call('read', 'src/a.ts', 40)], NOW)).toEqual(NOT_STUCK);
  });

  it('counts the minutes since the last edit, and stays fine while it edits', () => {
    const events = [call('edit', 'src/a.ts', 12), call('edit', 'src/b.ts', 2)];
    expect(stuckOf(run(), events, NOW)).toEqual({ stuck: false, minutesWithoutEdit: 2, repeatedReads: 0 });
  });

  it('is stuck when no edit happened for the threshold minutes', () => {
    const events = [call('read', 'src/a.ts', 30), call('edit', 'src/b.ts', STUCK_NO_EDIT_MIN)];
    const verdict = stuckOf(run(), events, NOW);
    expect(verdict.stuck).toBe(true);
    expect(verdict.minutesWithoutEdit).toBe(STUCK_NO_EDIT_MIN);
  });

  it('without any edit the clock starts at the run start', () => {
    const events = [call('read', 'src/a.ts', 3)];
    const verdict = stuckOf(run({ startedAt: iso(STUCK_NO_EDIT_MIN + 1) }), events, NOW);
    expect(verdict.stuck).toBe(true);
    expect(verdict.minutesWithoutEdit).toBe(STUCK_NO_EDIT_MIN + 1);
  });

  it('reads the same path again and again: stuck, with the count', () => {
    const events = [
      call('edit', 'src/a.ts', 20),
      call('read', 'src/settings.ts', 4),
      call('read', 'src/other.ts', 3),
      call('read', 'src/settings.ts', 2),
      call('read', 'src/settings.ts', 1),
      call('read', 'src/settings.ts', 0),
    ];
    const verdict = stuckOf(run(), events, NOW);
    expect(verdict.stuck).toBe(true);
    expect(verdict.repeatedReads).toBe(STUCK_REPEATS);
    expect(verdict.minutesWithoutEdit).toBe(20);
  });

  it('reads before the last edit do not count', () => {
    const events = [
      call('read', 'src/settings.ts', 10),
      call('read', 'src/settings.ts', 9),
      call('read', 'src/settings.ts', 8),
      call('read', 'src/settings.ts', 7),
      call('edit', 'src/a.ts', 1),
    ];
    expect(stuckOf(run(), events, NOW)).toEqual({ stuck: false, minutesWithoutEdit: 1, repeatedReads: 0 });
  });

  it('looks for repeated reads only among the last 20 tool calls', () => {
    const stale = Array.from({ length: STUCK_REPEATS }, (_v, i) => call('read', 'src/loop.ts', 30 - i));
    const fresh = Array.from({ length: 20 }, (_v, i) => call('read', `src/fresh-${i}.ts`, 1));
    const verdict = stuckOf(run({ startedAt: iso(2) }), [...stale, ...fresh], NOW);
    expect(verdict.stuck).toBe(false);
    expect(verdict.repeatedReads).toBe(1);
  });

  it('counts opencode tool events like claude-code notes', () => {
    const events: NormalizedEvent[] = [
      { ts: iso(30), kind: 'tool', tool: 'edit', detail: 'running' },
      { ts: iso(12), kind: 'tool', tool: 'edit', text: 'edit src/a.ts' },
      { ts: iso(11), kind: 'tool', tool: 'edit', detail: 'done', text: 'result › +4 −1' },
      { ts: iso(STUCK_NO_EDIT_MIN), kind: 'tool', tool: 'read', text: 'read src/b.ts' },
    ];
    expect(stuckOf(run(), events, NOW).stuck).toBe(true);
  });
});

describe('recentActions (req-75 W4b)', () => {
  it('draws file calls as their own line and commands with their result', () => {
    const events: NormalizedEvent[] = [
      call('read', 'shared/keybindings.ts', 9),
      { ts: iso(8), kind: 'note', text: 'thinking › where is the grammar' },
      { ts: iso(8), kind: 'note', text: 'you › use the existing one' },
      call('edit', 'electron/main.ts', 7),
      { ts: iso(7), kind: 'note', text: 'result › run R-1 started' },
      call('bash', 'npm run test:plugin -- git', 5),
      outcome('41 passed, 1 failed', 4),
    ];
    expect(recentActions(events, 2)).toEqual(['edit electron/main.ts', 'npm run test:plugin -- git   41 passed, 1 failed']);
    expect(recentActions(events, 4)).toEqual([
      'read shared/keybindings.ts',
      'edit electron/main.ts',
      'npm run test:plugin -- git   41 passed, 1 failed',
    ]);
  });

  it('a command without its outcome yet shows the command alone', () => {
    const events = [call('bash', 'npm run typecheck', 1)];
    expect(recentActions(events, 2)).toEqual(['npm run typecheck']);
  });

  it('keeps only the last n actions and nothing for n = 0', () => {
    const events = [call('read', 'src/a.ts', 5), call('read', 'src/b.ts', 4), call('read', 'src/c.ts', 3)];
    expect(recentActions(events, 2)).toEqual(['read src/b.ts', 'read src/c.ts']);
    expect(recentActions(events, 0)).toEqual([]);
  });

  it('settles an outcome on the newest unsettled call, in stream order', () => {
    const events = [
      call('bash', 'git status', 6),
      outcome('clean', 6),
      call('bash', 'npm run lint', 1),
    ];
    expect(recentActions(events, 2)).toEqual(['git status   clean', 'npm run lint']);
  });
});
