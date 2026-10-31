import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import { durationWords, headerControls, liveStateWord, threadSteps } from './thread-steps';

function run(over: Partial<RunInfo> = {}): RunInfo {
  return {
    id: 'R-1',
    ticketId: 'T-0061',
    provider: 'opencode',
    state: 'done',
    pid: null,
    startedAt: '2026-10-31T10:00:00Z',
    endedAt: '2026-10-31T10:06:00Z',
    sessionRef: 'ses-1',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: null,
    lastActivity: '2026-10-31T10:06:00Z',
    steerCount: 0,
    lastSteerRung: null,
    worktreePath: 'W:/wt',
    branch: 't/T-0061',
    gateFailure: null,
    ...over,
  };
}

const NOW = Date.parse('2026-10-31T12:00:00Z');

describe('threadSteps', () => {
  it('takes only this ticket\'s runs, oldest first', () => {
    const steps = threadSteps(
      'T-0061',
      [
        run({ id: 'R-b', startedAt: '2026-10-31T11:00:00Z', endedAt: '2026-10-31T11:05:00Z' }),
        run({ id: 'R-a', startedAt: '2026-10-31T10:00:00Z', endedAt: '2026-10-31T10:06:00Z' }),
        run({ id: 'R-other', ticketId: 'T-0002' }),
      ],
      NOW,
    );
    expect(steps.map((s) => s.runId)).toEqual(['R-a', 'R-b']);
  });

  it('labels a finished run by its phase — plan, build, commit, review', () => {
    const steps = threadSteps(
      'T-0061',
      [
        run({ id: 'R-1', phase: 'plan' }),
        run({ id: 'R-2', phase: 'build' }),
        run({ id: 'R-3', phase: 'commit' }),
        run({ id: 'R-4', phase: 'review' }),
      ],
      NOW,
    );
    expect(steps.map((s) => s.label)).toEqual(['Planned', 'Built', 'Merged', 'Reviewed']);
  });

  it('capitalises an unknown phase, and falls back to the state without one', () => {
    expect(threadSteps('T-0061', [run({ phase: 'qa' })], NOW)[0]!.label).toBe('Qa');
    expect(threadSteps('T-0061', [run({ phase: null })], NOW)[0]!.label).toBe('Done');
  });

  it('labels a live run by phase, a wait, and an idle turn', () => {
    expect(liveStateWord(run({ state: 'running', phase: 'build', turn: 'busy' }))).toBe('Building');
    expect(liveStateWord(run({ state: 'running', phase: 'plan', turn: 'busy' }))).toBe('Planning');
    expect(liveStateWord(run({ state: 'running', phase: 'commit', turn: 'busy' }))).toBe('Merging');
    expect(liveStateWord(run({ state: 'running', phase: null, turn: 'busy' }))).toBe('Working');
    expect(
      liveStateWord(
        run({
          state: 'running',
          phase: 'build',
          waiting: { kind: 'question', text: 'Go on?', since: '2026-10-31T11:00:00Z' },
        }),
      ),
    ).toBe('Waiting for you');
    expect(liveStateWord(run({ state: 'running', phase: 'build', turn: 'idle' }))).toBe('Idle');
    expect(liveStateWord(run({ state: 'done', phase: 'build' }))).toBeNull();
    expect(liveStateWord(null)).toBeNull();
  });

  it('calls a detached run Running — never the word detached', () => {
    expect(liveStateWord(run({ state: 'detached', phase: 'build', turn: 'busy' }))).toBe('Running');
  });

  it('marks done green, failed and red gates crossed, stopped muted, live accent', () => {
    expect(threadSteps('T-0061', [run({ gateResult: 'green' })], NOW)[0]!.mark).toBe('✓');
    expect(threadSteps('T-0061', [run({ gateResult: 'red' })], NOW)[0]!.mark).toBe('✕');
    expect(threadSteps('T-0061', [run({ state: 'failed' })], NOW)[0]!.mark).toBe('✕');
    expect(threadSteps('T-0061', [run({ state: 'stopped' })], NOW)[0]!.mark).toBe('■');
    expect(threadSteps('T-0061', [run({ state: 'running' })], NOW)[0]!.mark).toBe('●');
    expect(threadSteps('T-0061', [run({ state: 'detached' })], NOW)[0]!.mark).toBe('●');
  });

  it('durations come from execMs, else end − start', () => {
    expect(threadSteps('T-0061', [run({ execMs: 6 * 60_000, endedAt: null, state: 'running' })], NOW)[0]!.duration).toBe('6 min');
    expect(threadSteps('T-0061', [run()], NOW)[0]!.duration).toBe('6 min');
    expect(threadSteps('T-0061', [run({ startedAt: '2026-10-31T09:00:00Z', endedAt: '2026-10-31T10:06:00Z' })], NOW)[0]!.duration).toBe('1 h');
  });

  it('details the gate failure\'s first line', () => {
    expect(threadSteps('T-0061', [run({ gateFailure: 'npm run typecheck\n29 errors' })], NOW)[0]!.detail).toBe('npm run typecheck');
    expect(threadSteps('T-0061', [run({ gateFailure: '\n  \nsecond' })], NOW)[0]!.detail).toBe('second');
    expect(threadSteps('T-0061', [run()], NOW)[0]!.detail).toBeNull();
  });
});

describe('durationWords', () => {
  it('steps through seconds, minutes and hours', () => {
    expect(durationWords(0)).toBe('0 s');
    expect(durationWords(42_000)).toBe('42 s');
    expect(durationWords(6 * 60_000)).toBe('6 min');
    expect(durationWords(3 * 3_600_000)).toBe('3 h');
  });
});

describe('headerControls', () => {
  it('gives a connected run Pause, Take over and Stop, plus Hand back when held', () => {
    expect(headerControls(run({ state: 'running', phase: 'build', turn: 'busy' }))).toEqual(['pause', 'takeover', 'stop']);
    expect(headerControls(run({ state: 'running', phase: 'build', waiting: { kind: 'question', text: 'Go on?', since: '2026-10-31T11:00:00Z' } }))).toEqual([
      'pause',
      'takeover',
      'stop',
    ]);
    expect(headerControls(run({ state: 'running', phase: 'build', held: true }))).toEqual(['pause', 'takeover', 'stop', 'handback']);
  });

  it('gives a detached run Stop and Resume session, never Pause', () => {
    const detached = headerControls(run({ state: 'detached', sessionRef: 'ses-1' }));
    expect(detached).toEqual(['stop', 'resume']);
    expect(detached).not.toContain('pause');
    expect(headerControls(run({ state: 'detached', sessionRef: null }))).toEqual(['stop']);
  });

  it('resumes an ended run with a session, stopped ones too; Start otherwise', () => {
    expect(headerControls(run({ state: 'done', sessionRef: 'ses-1' }))).toEqual(['resume']);
    expect(headerControls(run({ state: 'stopped', sessionRef: 'ses-1' }))).toEqual(['resume']);
    expect(headerControls(run({ state: 'failed', sessionRef: null }))).toEqual(['start']);
    expect(headerControls(null)).toEqual(['start']);
  });
});
