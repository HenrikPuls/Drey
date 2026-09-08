import {
  appendEntry,
  composeEntry,
  EMPTY_ENTRY_DRAFT,
  formatEntryMeta,
  hasEntryContent,
} from '../../../shared/entry-compose';
import { parseDatedEntries } from '../../../shared/entries';

const at = new Date(2026, 8, 26, 6, 12);

describe('composeEntry', () => {
  it('writes the documented shape: heading, text, tag meta line', () => {
    const text = composeEntry(
      {
        topic: 'Rollout-Sync',
        text: 'Kurzes Sync mit Team zu Rollout-Plan, Risiken bei DB-Migration besprochen.',
        tags: ['daily', 'arbeit'],
      },
      at,
    );
    expect(text).toBe(
      '## 06:12 — Rollout-Sync\n' +
        'Kurzes Sync mit Team zu Rollout-Plan, Risiken bei DB-Migration besprochen.\n' +
        '#daily #arbeit',
    );
  });

  it('drops the topic when blank and the meta line when nothing is tagged', () => {
    expect(composeEntry({ ...EMPTY_ENTRY_DRAFT, text: 'lklk' }, at)).toBe('## 06:12\nlklk');
  });

  it('normalises a leading `#` the user may have typed into a chip', () => {
    expect(formatEntryMeta({ ...EMPTY_ENTRY_DRAFT, tags: ['#a', 'b'] })).toBe('#a #b');
  });

  it('round-trips back through the entry parser', () => {
    const text = composeEntry(
      { ...EMPTY_ENTRY_DRAFT, topic: 'Rollout-Sync', text: 'x #daily' },
      at,
    );
    expect(parseDatedEntries(text)).toEqual([
      {
        heading: '06:12 — Rollout-Sync',
        date: null,
        time: '06:12',
        title: 'Rollout-Sync',
        text: 'x #daily',
      },
    ]);
  });
});

describe('appendEntry', () => {
  it('separates from existing content by exactly one blank line', () => {
    const result = appendEntry(
      '# 2026-09-26\n\n## 04:48\nlklk\n\n\n',
      { ...EMPTY_ENTRY_DRAFT, text: 'neu' },
      at,
    );
    expect(result.text).toBe('# 2026-09-26\n\n## 04:48\nlklk\n\n## 06:12\nneu\n');
    expect(result.text.slice(result.at)).toBe('## 06:12\nneu\n');
  });

  it('writes into an empty document without a leading blank line', () => {
    expect(appendEntry('', { ...EMPTY_ENTRY_DRAFT, text: 'x' }, at)).toEqual({
      text: '## 06:12\nx\n',
      at: 0,
    });
  });
});

describe('draft predicates', () => {
  it('hasEntryContent is false only for a fully empty draft', () => {
    expect(hasEntryContent(EMPTY_ENTRY_DRAFT)).toBe(false);
    expect(hasEntryContent({ ...EMPTY_ENTRY_DRAFT, tags: ['  '] })).toBe(false);
    expect(hasEntryContent({ ...EMPTY_ENTRY_DRAFT, tags: ['a'] })).toBe(true);
  });
});
