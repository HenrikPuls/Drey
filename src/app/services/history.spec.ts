import { appendHistoryEntry, historyMarker } from '../../../shared/history';

const APPEND = {
  date: '2026-09-06',
  time: '14:32',
  sourcePath: 'daily/2026-09-06.md',
  entryText: 'Second viewing fell through #sailing',
};

describe('appendHistoryEntry', () => {
  it('appends into an existing History section, before a following ## section', () => {
    const master =
      '---\ntype: master\n---\n\n## Summary\n\ns\n\n## Context\n\nc\n\n## History\n\n### 2026-09-01 09:00 <!-- drey:src daily/2026-09-01.md@2026-09-01 09:00 -->\nolder\n';
    const { text, appended } = appendHistoryEntry(master, APPEND);
    expect(appended).toBe(true);
    expect(text).toContain(
      '### 2026-09-06 14:32 <!-- drey:src daily/2026-09-06.md@2026-09-06 14:32 -->\nSecond viewing fell through #sailing\n',
    );
    // order: older entry stays before the new one, Summary/Context untouched
    expect(text.indexOf('older')).toBeLessThan(text.indexOf('Second viewing'));
    expect(text).toContain('## Summary');
  });

  it('creates the History section when the master has none', () => {
    const master = '---\ntype: master\n---\n\n## Context\n\njust context\n';
    const { text, appended } = appendHistoryEntry(master, APPEND);
    expect(appended).toBe(true);
    expect(text).toContain('## History\n\n### 2026-09-06 14:32 ');
    expect(text.endsWith('#sailing\n')).toBe(true);
  });

  it('is idempotent: the same source entry is not appended twice', () => {
    const master = '## History\n';
    const once = appendHistoryEntry(master, APPEND);
    const twice = appendHistoryEntry(once.text, APPEND);
    expect(twice.appended).toBe(false);
    expect(twice.text).toBe(once.text);
    expect(once.text).toContain(historyMarker(APPEND.sourcePath, APPEND.date, APPEND.time));
  });

  it('does not append an empty entry', () => {
    const master = '## History\n';
    expect(appendHistoryEntry(master, { ...APPEND, entryText: '   \n\n' })).toEqual({
      text: master,
      appended: false,
    });
  });
});
