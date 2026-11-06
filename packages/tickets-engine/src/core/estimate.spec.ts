import { describe, expect, it } from 'vitest';
import { estimateFrom, MIN_ESTIMATE_RUNS, minutesOf, tokenCountOf } from './estimate';
import type { VerlaufEntry } from './verlauf';

const KEY = { gate: 'build', persona: 'ben', model: 'sonnet' };

const run = (patch: Partial<VerlaufEntry> = {}): VerlaufEntry => ({
  phase: 'build',
  persona: 'ben',
  model: 'sonnet',
  tokens: '48k',
  cost: 0.3,
  dauer: '9m',
  ausgang: 'handed-over',
  ...patch,
});

describe('token and minute words', () => {
  it('reads the compact words the Verlauf writes', () => {
    expect(tokenCountOf('48k')).toBe(48_000);
    expect(tokenCountOf('3.4M')).toBe(3_400_000);
    expect(tokenCountOf('800')).toBe(800);
    expect(tokenCountOf('lots')).toBeNull();
    expect(minutesOf('12m')).toBe(12);
    expect(minutesOf('')).toBeNull();
  });
});

describe('estimateFrom', () => {
  it('gives no number below the minimum — never a guess', () => {
    expect(MIN_ESTIMATE_RUNS).toBe(3);
    expect(estimateFrom([run(), run()], KEY)).toBeNull();
    expect(estimateFrom([], KEY)).toBeNull();
  });

  it('takes the median of at least three matching runs and says how many', () => {
    const history = [run({ cost: 0.2, dauer: '5m', tokens: '30k' }), run({ cost: 0.9, dauer: '40m', tokens: '200k' }), run({ cost: 0.3, dauer: '9m', tokens: '48k' })];
    expect(estimateFrom(history, KEY)).toEqual({ ...KEY, runs: 3, cost: 0.3, costLow: 0.25, costHigh: 0.6, minutes: 9, tokens: 48_000 });
  });

  it('averages the middle pair of an even count', () => {
    const history = [0.2, 0.4, 0.6, 0.8].map((cost) => run({ cost }));
    expect(estimateFrom(history, KEY)?.cost).toBe(0.5);
  });

  it('counts only the same gate, persona and model — and only handed-over runs with a cost', () => {
    const noise = [
      run({ phase: 'review' }),
      run({ persona: 'ralf' }),
      run({ model: 'opus' }),
      run({ ausgang: 'failed' }),
      run({ ausgang: 'stopped' }),
      run({ cost: null }),
    ];
    expect(estimateFrom([...noise, run(), run()], KEY)).toBeNull();
    expect(estimateFrom([...noise, run(), run(), run({ phase: 'Build', persona: 'Ben' })], KEY)?.runs).toBe(3);
  });

  it('leaves duration and tokens null when no matching run recorded them', () => {
    const history = [run({ dauer: '', tokens: '' }), run({ dauer: '', tokens: '' }), run({ dauer: '', tokens: '' })];
    expect(estimateFrom(history, KEY)).toMatchObject({ minutes: null, tokens: null });
  });
});
