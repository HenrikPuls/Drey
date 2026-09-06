import { dailyDateFromPath, dailyPathFor } from '../../../shared/daily';

describe('dailyPathFor', () => {
  it('nests the file under year and month', () => {
    expect(dailyPathFor('2026-09-06')).toBe('daily/2026/09/2026-09-06.md');
    expect(dailyPathFor('2025-12-31')).toBe('daily/2025/12/2025-12-31.md');
  });
});

describe('dailyDateFromPath', () => {
  it('reads back the nested layout', () => {
    expect(dailyDateFromPath('daily/2026/09/2026-09-06.md')).toBe('2026-09-06');
  });

  it('still recognises a legacy flat file', () => {
    expect(dailyDateFromPath('daily/2026-09-06.md')).toBe('2026-09-06');
  });

  it('accepts back-slash separators', () => {
    expect(dailyDateFromPath('daily\\2026\\09\\2026-09-06.md')).toBe('2026-09-06');
  });

  it('is round-trip consistent with dailyPathFor', () => {
    expect(dailyDateFromPath(dailyPathFor('2026-02-01'))).toBe('2026-02-01');
  });

  it('rejects anything that is not a daily note path', () => {
    expect(dailyDateFromPath('daily/2026/09/notes.md')).toBeNull();
    expect(dailyDateFromPath('topics/2026-09-06.md')).toBeNull();
    expect(dailyDateFromPath('daily/2026/2026-09-06.md')).toBeNull();
    expect(dailyDateFromPath('daily/2026-9-6.md')).toBeNull();
  });
});
