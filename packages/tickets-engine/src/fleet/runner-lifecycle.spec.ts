import { describe, expect, it } from 'vitest';
import { IdleWatch, retireVerdict } from './runner-lifecycle';

describe('retireVerdict (req-110)', () => {
  it('lets the runner go with nothing live and no Autopilot', () => {
    expect(retireVerdict({ live: 0, keepsAlive: false })).toEqual({ exiting: true });
  });

  it('keeps a runner with a live run — the run survives Drey (ADR-0075)', () => {
    expect(retireVerdict({ live: 1, keepsAlive: false })).toEqual({ exiting: false, reason: 'live runs' });
    expect(retireVerdict({ live: 2, keepsAlive: true })).toEqual({ exiting: false, reason: 'live runs' });
  });

  it('keeps a runner whose Autopilot is On or Paused — the chain drains the board without Drey', () => {
    expect(retireVerdict({ live: 0, keepsAlive: true })).toEqual({ exiting: false, reason: 'autopilot' });
  });
});

describe('IdleWatch (req-110)', () => {
  const clock = (start: number): { now: () => number; advance(ms: number): void } => {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
  };

  it('expires after the span without a write — reads do not count', () => {
    const c = clock(1_000);
    const watch = new IdleWatch(100, c.now);
    expect(watch.expired({ live: 0, keepsAlive: false })).toBe(false);
    c.advance(101);
    // No noteActivity for the GET polls in between: the span still runs out.
    expect(watch.expired({ live: 0, keepsAlive: false })).toBe(true);
  });

  it('a write restarts the span', () => {
    const c = clock(0);
    const watch = new IdleWatch(100, c.now);
    c.advance(90);
    watch.noteActivity();
    c.advance(90);
    expect(watch.expired({ live: 0, keepsAlive: false })).toBe(false);
    c.advance(11);
    expect(watch.expired({ live: 0, keepsAlive: false })).toBe(true);
  });

  it('a live run holds the clock, and the span starts over when it ends', () => {
    const c = clock(0);
    const watch = new IdleWatch(100, c.now);
    c.advance(500);
    expect(watch.expired({ live: 1, keepsAlive: false })).toBe(false);
    c.advance(50);
    expect(watch.expired({ live: 0, keepsAlive: false })).toBe(false);
    c.advance(51);
    expect(watch.expired({ live: 0, keepsAlive: false })).toBe(true);
  });

  it('an Autopilot that keeps the runner never expires it', () => {
    const c = clock(0);
    const watch = new IdleWatch(100, c.now);
    c.advance(10_000);
    expect(watch.expired({ live: 0, keepsAlive: true })).toBe(false);
  });
});
