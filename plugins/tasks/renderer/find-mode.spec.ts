/**
 * The Tasks mode's pure halves (`find-mode.ts`): the due-date groups of
 * board 9c (Overdue · Today · Later · No date) and the per-scope status.
 */
import { describe, expect, it } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { TaskRecord } from '../shared/tasks.js';
import { groupByDue, statusFor } from './find-mode.js';

function task(text: string, due: string | null): TaskRecord {
  return {
    text,
    due,
    path: 'a.md',
    vaultId: 'v',
    line: 1,
    done: false,
    kind: 'checkbox',
    heading: null,
    tags: [],
    priority: null,
  } as unknown as TaskRecord;
}

describe('groupByDue', () => {
  it('splits by the due date against today and leaves empty groups out', () => {
    const groups = groupByDue(
      [
        task('late', '2026-11-03'),
        task('now', '2026-11-08'),
        task('soon', '2026-12-01'),
        task('never', null),
        task('later still', '2027-01-01'),
      ],
      '2026-11-08',
    );
    expect(groups.map((g) => [g.id, g.tasks.map((t) => t.text)])).toEqual([
      ['overdue', ['late']],
      ['today', ['now']],
      ['later', ['soon', 'later still']],
      ['none', ['never']],
    ]);
    expect(groupByDue([task('x', null)], '2026-11-08').map((g) => g.id)).toEqual(['none']);
  });
});

describe('statusFor', () => {
  const api = {
    i18n: { t: (key: string, params?: { count: number }) => `${key}:${params?.count}` },
  } as unknown as DreyPluginApi;

  it('names the scope when it is not the vault and hides a zero count', () => {
    expect(statusFor(api, 6, 'vault')).toBe('find.status.open:6');
    expect(statusFor(api, 2, 'file')).toBe('find.status.open_note:2');
    expect(statusFor(api, 14, 'all')).toBe('find.status.open_all:14');
    expect(statusFor(api, 0, 'vault')).toBeNull();
  });
});
