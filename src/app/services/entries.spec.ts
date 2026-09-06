import { formatEntryHeading, parseDatedEntries } from '../../../shared/entries';

describe('parseDatedEntries', () => {
  it('splits `## HH:mm` blocks, date null, outer whitespace trimmed', () => {
    const body = '# 2026-09-06\n\n## 08:00\nFirst thing #a\n\n## 14:32\nSecond #b\n- [ ] x\n\n';
    expect(parseDatedEntries(body)).toEqual([
      { heading: '08:00', date: null, time: '08:00', title: null, text: 'First thing #a' },
      { heading: '14:32', date: null, time: '14:32', title: null, text: 'Second #b\n- [ ] x' },
    ]);
  });

  it('reads a date from a `### YYYY-MM-DD HH:mm` heading', () => {
    const body = '## History\n\n### 2026-09-05 14:32 <!-- m -->\nRouted text\n';
    expect(parseDatedEntries(body)).toEqual([
      {
        heading: '2026-09-05 14:32',
        date: '2026-09-05',
        time: '14:32',
        title: null,
        text: 'Routed text',
      },
    ]);
  });

  it('reads the drawer topic from `## HH:mm — <Thema>`', () => {
    const body = '## 06:12 — Rollout-Sync\nKurzes Sync #daily · [[Markus]]\n';
    expect(parseDatedEntries(body)).toEqual([
      {
        heading: '06:12 — Rollout-Sync',
        date: null,
        time: '06:12',
        title: 'Rollout-Sync',
        text: 'Kurzes Sync #daily · [[Markus]]',
      },
    ]);
  });

  it('keeps a topic and a routing marker apart on a History heading', () => {
    const body =
      '### 2026-09-26 06:12 — Rollout-Sync <!-- drey:src daily/x.md@2026-09-26 06:12 -->\nText\n';
    expect(parseDatedEntries(body)[0]).toMatchObject({
      date: '2026-09-26',
      time: '06:12',
      title: 'Rollout-Sync',
      text: 'Text',
    });
  });

  it('accepts `--` and an en dash as the topic separator', () => {
    expect(parseDatedEntries('## 07:00 -- Standup\nx\n')[0].title).toBe('Standup');
    expect(parseDatedEntries('## 07:00 – Standup\nx\n')[0].title).toBe('Standup');
  });

  it('ignores a single-# title and body prose that is not a heading', () => {
    const body = '# 2026-09-06\n\nnotes about 09:00 standup\n\n## 09:15\nreal entry\n';
    expect(parseDatedEntries(body).map((e) => e.time)).toEqual(['09:15']);
  });

  it('still treats a title with no dash as prose, not a topic', () => {
    expect(parseDatedEntries('## 14:32 Rollout\ntext\n')).toEqual([]);
  });

  it('returns an empty array when there are no dated entries', () => {
    expect(parseDatedEntries('just some text\n')).toEqual([]);
  });
});

describe('formatEntryHeading', () => {
  it('renders every combination the parser accepts', () => {
    expect(formatEntryHeading(null, '06:12', null)).toBe('06:12');
    expect(formatEntryHeading(null, '06:12', 'Rollout-Sync')).toBe('06:12 — Rollout-Sync');
    expect(formatEntryHeading('2026-09-26', '06:12', 'Rollout-Sync')).toBe(
      '2026-09-26 06:12 — Rollout-Sync',
    );
  });
});
