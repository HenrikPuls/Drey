import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_OFF,
  autopilotAtBoot,
  autopilotOf,
  autopilotOfMaster,
  masterOf,
  parseAutopilotSet,
  restoreAutopilot,
  resumeDue,
} from './autopilot';

/** The Autopilot's pure rules (req-95): the mapping, the command, the boot rule. */

const NOW = new Date('2026-11-06T12:00:00Z');

describe('the mapping onto the master', () => {
  it('On runs; Paused and Off halt', () => {
    expect(masterOf({ state: 'on' })).toBe('run');
    expect(masterOf({ state: 'paused' })).toBe('halted');
    expect(masterOf({ state: 'paused', resumeAt: '2026-11-06T18:00:00.000Z' })).toBe('halted');
    expect(masterOf({ state: 'off' })).toBe('halted');
  });

  it('a master call reads as On or Off, never Paused', () => {
    expect(autopilotOfMaster('run')).toEqual({ state: 'on' });
    expect(autopilotOfMaster('halted')).toEqual({ state: 'off' });
  });

  it('a client reads the record, an older runner through its master, no runner as Off', () => {
    expect(autopilotOf({ master: 'halted', autopilot: { state: 'paused' } })).toEqual({ state: 'paused' });
    expect(autopilotOf({ master: 'run' })).toEqual({ state: 'on' });
    expect(autopilotOf({ master: 'halted' })).toEqual({ state: 'off' });
    expect(autopilotOf(null)).toEqual({ state: 'off' });
  });
});

describe('parseAutopilotSet', () => {
  it('takes the three states', () => {
    for (const state of ['on', 'paused', 'off'] as const) {
      expect(parseAutopilotSet({ state }, NOW)).toEqual({ ok: true, value: { state } });
    }
  });

  it('normalizes a future zoned resume time to UTC', () => {
    expect(parseAutopilotSet({ state: 'paused', resumeAt: '2026-11-06T18:00+01:00' }, NOW)).toEqual({
      ok: true,
      value: { state: 'paused', resumeAt: '2026-11-06T17:00:00.000Z' },
    });
  });

  it('refuses an unknown state with its code', () => {
    for (const body of [{ state: 'run' }, {}, null, 'on']) {
      expect(parseAutopilotSet(body, NOW)).toEqual({ ok: false, error: 'bad_state', code: 'bad_state' });
    }
  });

  it('refuses a resume time that is off a Paused, past, zoneless or no instant', () => {
    const later = '2026-11-06T18:00:00Z';
    for (const body of [
      { state: 'on', resumeAt: later },
      { state: 'off', resumeAt: later },
      { state: 'paused', resumeAt: '2026-11-06T11:59:00Z' },
      { state: 'paused', resumeAt: NOW.toISOString() },
      { state: 'paused', resumeAt: '2026-11-06T18:00:00' },
      { state: 'paused', resumeAt: 'tonight' },
      { state: 'paused', resumeAt: 1_800_000_000_000 },
    ]) {
      expect(parseAutopilotSet(body, NOW)).toEqual({ ok: false, error: 'bad_resume_at', code: 'bad_resume_at' });
    }
  });
});

describe('restoreAutopilot', () => {
  it('reads the three states and drops a torn resume time', () => {
    expect(restoreAutopilot({ state: 'on' })).toEqual({ state: 'on' });
    expect(restoreAutopilot({ state: 'off', resumeAt: '2026-11-06T18:00:00Z' })).toEqual({ state: 'off' });
    expect(restoreAutopilot({ state: 'paused', resumeAt: '2026-11-06T18:00:00Z' })).toEqual({
      state: 'paused',
      resumeAt: '2026-11-06T18:00:00Z',
    });
    expect(restoreAutopilot({ state: 'paused', resumeAt: 'soon' })).toEqual({ state: 'paused' });
  });

  it('answers null when the file has no usable record', () => {
    expect(restoreAutopilot(undefined)).toBeNull();
    expect(restoreAutopilot({ state: 'run' })).toBeNull();
  });
});

describe('the boot rule', () => {
  const paused = { state: 'paused', resumeAt: '2026-11-06T18:00:00.000Z' } as const;

  it('every start ends as Off', () => {
    expect(autopilotAtBoot({ state: 'on' }, false)).toEqual(AUTOPILOT_OFF);
    expect(autopilotAtBoot(paused, false)).toEqual(AUTOPILOT_OFF);
    expect(autopilotAtBoot({ state: 'off' }, false)).toEqual(AUTOPILOT_OFF);
  });

  it('a handover is no start', () => {
    expect(autopilotAtBoot({ state: 'on' }, true)).toEqual({ state: 'on' });
    expect(autopilotAtBoot(paused, true)).toEqual(paused);
  });
});

describe('resumeDue', () => {
  it('is due from the resume time on, only for a timed Paused', () => {
    const paused = { state: 'paused', resumeAt: NOW.toISOString() } as const;
    expect(resumeDue(paused, new Date(NOW.getTime() - 1))).toBe(false);
    expect(resumeDue(paused, NOW)).toBe(true);
    expect(resumeDue(paused, new Date(NOW.getTime() + 1))).toBe(true);
    expect(resumeDue({ state: 'paused' }, NOW)).toBe(false);
    expect(resumeDue({ state: 'on' }, NOW)).toBe(false);
  });
});
