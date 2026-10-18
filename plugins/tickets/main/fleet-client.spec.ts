import { describe, expect, it } from 'vitest';
import { isOlderBuild, isStaleDaemon } from './fleet-client';

describe('isOlderBuild', () => {
  const older = '2026-10-18T10:00:00.000Z';
  const newer = '2026-10-18T12:00:00.000Z';

  it('retires a daemon whose build is older than this one', () => {
    expect(isOlderBuild(older, newer)).toBe(true);
  });

  it('keeps a newer daemon — two checkouts must not retire each other', () => {
    expect(isOlderBuild(newer, older)).toBe(false);
  });

  it('keeps an equal stamp (same build, no churn)', () => {
    expect(isOlderBuild(newer, newer)).toBe(false);
  });

  it('keeps the daemon when either stamp is unparsable', () => {
    expect(isOlderBuild('not-a-date', newer)).toBe(false);
    expect(isOlderBuild(older, 'not-a-date')).toBe(false);
  });
});

describe('isStaleDaemon', () => {
  it('retires a daemon that reports no build stamp (it predates the stamp)', () => {
    expect(isStaleDaemon(undefined, '2026-10-18T12:00:00.000Z')).toBe(true);
  });

  it('keeps a stamp-less daemon when this build has no stamp to compare', () => {
    expect(isStaleDaemon(undefined, null)).toBe(false);
  });
});
