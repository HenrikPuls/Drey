import { describe, expect, it } from 'vitest';
import { issueMetaFile, issueSummary, sortedIssues } from './board-issues';

describe('board issues (req-73)', () => {
  it('summarises the count and the worst level', () => {
    expect(issueSummary([])).toBeNull();
    expect(issueSummary([{ level: 'noise', message: 'a' }])).toEqual({ text: '1 board issue', worst: 'noise' });
    expect(
      issueSummary([
        { level: 'noise', message: 'a' },
        { level: 'warning', message: 'b' },
      ]),
    ).toEqual({ text: '2 board issues', worst: 'warning' });
  });

  it('lists the worst first and keeps the order inside a level', () => {
    const sorted = sortedIssues([
      { level: 'noise', message: 'n1' },
      { level: 'error', message: 'e1' },
      { level: 'noise', message: 'n2' },
      { level: 'warning', message: 'w1' },
    ]);
    expect(sorted.map((i) => i.message)).toEqual(['e1', 'w1', 'n1', 'n2']);
  });

  it('finds the meta file a message is about', () => {
    expect(issueMetaFile('order.md pins unknown phase "qa"')).toBe('tickets/_meta/order.md');
    expect(issueMetaFile('pipeline.md: push must be a remote name string — ignored')).toBe('tickets/_meta/pipeline.md');
    expect(issueMetaFile('repo "x" is not in repos.md')).toBe('tickets/_meta/repos.md');
    expect(issueMetaFile('a ticket sits in two phases')).toBeNull();
  });
});
