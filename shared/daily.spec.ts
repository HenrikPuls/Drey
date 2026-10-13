import { dailyDateFromPath, dailyPathFor } from './daily';

describe('dailyPathFor', () => {
  it('nests the file under year and month', () => {
    expect(dailyPathFor('2026-09-06')).toBe('daily/2026/09/2026-09-06.md');
    expect(dailyPathFor('2025-12-31')).toBe('daily/2025/12/2025-12-31.md');
  });

  it('uses the configured root folder', () => {
    expect(dailyPathFor('2026-09-06', 'Journal')).toBe('Journal/2026/09/2026-09-06.md');
  });

  it('supports a nested root folder', () => {
    expect(dailyPathFor('2026-09-06', 'meta/journal')).toBe('meta/journal/2026/09/2026-09-06.md');
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

  describe('with a configured root folder', () => {
    it('reads the nested and flat layouts inside that folder', () => {
      expect(dailyDateFromPath('Journal/2026/09/2026-09-06.md', 'Journal')).toBe('2026-09-06');
      expect(dailyDateFromPath('Journal/2026-09-06.md', 'Journal')).toBe('2026-09-06');
    });

    it('accepts back-slash separators inside that folder', () => {
      expect(dailyDateFromPath('Journal\\2026\\09\\2026-09-06.md', 'Journal')).toBe('2026-09-06');
    });

    it('rejects daily-note paths under a different root', () => {
      expect(dailyDateFromPath('daily/2026/09/2026-09-06.md', 'Journal')).toBeNull();
      expect(dailyDateFromPath('daily/2026-09-06.md', 'Journal')).toBeNull();
      expect(dailyDateFromPath('Journal/2026/09/2026-09-06.md')).toBeNull();
    });

    it('does not treat regex metacharacters in the root as wildcards', () => {
      expect(dailyDateFromPath('My.Notes/2026/09/2026-09-06.md', 'My.Notes')).toBe('2026-09-06');
      expect(dailyDateFromPath('MyXNotes/2026/09/2026-09-06.md', 'My.Notes')).toBeNull();
    });

    it('is round-trip consistent with the configured root', () => {
      expect(dailyDateFromPath(dailyPathFor('2026-02-01', 'meta/journal'), 'meta/journal')).toBe(
        '2026-02-01',
      );
    });
  });
});
