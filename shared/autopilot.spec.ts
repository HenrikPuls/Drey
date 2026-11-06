import { describe, expect, it } from 'vitest';
import { isMessageKey } from './i18n';
import {
  autopilotRefusalCodeOf,
  autopilotRefusalKeyOf,
  autopilotToneOf,
  autopilotViewOf,
  resumeAtOfTime,
  timeFieldOfResume,
} from './autopilot';

describe('autopilotToneOf', () => {
  it('is green On, orange Paused, grey Off (board 10t)', () => {
    expect(autopilotToneOf('on')).toBe('positive');
    expect(autopilotToneOf('paused')).toBe('attention');
    expect(autopilotToneOf('off')).toBe('neutral');
  });
});

describe('autopilotViewOf', () => {
  it('reads the engine record, with the resume time only on Paused', () => {
    expect(autopilotViewOf({ master: 'halted', autopilot: { state: 'paused', resumeAt: '2026-11-06T18:00:00.000Z' } })).toEqual({
      state: 'paused',
      resumeAt: '2026-11-06T18:00:00.000Z',
    });
    expect(autopilotViewOf({ master: 'run', autopilot: { state: 'on', resumeAt: 'x' } })).toEqual({ state: 'on' });
  });
  it('reads through the master for a runner too old to report the record', () => {
    expect(autopilotViewOf({ master: 'run' })).toEqual({ state: 'on' });
    expect(autopilotViewOf({ master: 'halted' })).toEqual({ state: 'off' });
  });
  it('is null without a chain', () => {
    expect(autopilotViewOf(null)).toBeNull();
  });
});

describe('the refusal mapping', () => {
  it('maps every engine code to a catalog key that exists', () => {
    for (const code of ['read_only', 'bad_resume_at', 'bad_state', 'runner_down'] as const) {
      const key = autopilotRefusalKeyOf(code);
      expect(key).toBe(`autopilot.refused.${code}`);
      expect(isMessageKey(key)).toBe(true);
    }
    expect(autopilotRefusalKeyOf('something_else')).toBe('autopilot.refused.unknown');
    expect(isMessageKey('autopilot.refused.unknown')).toBe(true);
  });
  it('finds the code on the reply, or in the words a 403 kept', () => {
    expect(autopilotRefusalCodeOf({ ok: false, code: 'bad_resume_at' })).toBe('bad_resume_at');
    expect(autopilotRefusalCodeOf({ ok: false, error: 'this device is paired read-only' })).toBe('read_only');
    expect(autopilotRefusalCodeOf({ ok: false, error: 'the fleet runner is not running' })).toBe('runner_down');
    expect(autopilotRefusalCodeOf({ ok: false, error: 'boom' })).toBeNull();
    expect(autopilotRefusalCodeOf(null)).toBeNull();
  });
});

describe('the resume time', () => {
  const now = new Date(2026, 10, 6, 10, 0, 0);
  it('is the next such time on the device clock, as an ISO instant', () => {
    expect(new Date(resumeAtOfTime('18:30', now)!).getTime()).toBe(new Date(2026, 10, 6, 18, 30).getTime());
  });
  it('rolls to tomorrow when the time has passed', () => {
    expect(new Date(resumeAtOfTime('09:00', now)!).getTime()).toBe(new Date(2026, 10, 7, 9, 0).getTime());
  });
  it('refuses what is no time', () => {
    expect(resumeAtOfTime('', now)).toBeNull();
    expect(resumeAtOfTime('25:00', now)).toBeNull();
  });
  it('round-trips into a time field', () => {
    expect(timeFieldOfResume(resumeAtOfTime('18:30', now)!)).toBe('18:30');
    expect(timeFieldOfResume(undefined)).toBe('');
  });
});
