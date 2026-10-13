import { CLASSIC_ENTRY_PATTERN, RULED_ENTRY_PATTERN } from './app-config';
import {
  appendEntry,
  composeEntry,
  EMPTY_ENTRY_DRAFT,
  formatEntryMeta,
  hasEntryContent,
  substituteEntryTemplate,
} from './entry-compose';
import { parseDatedEntries } from './entries';

const at = new Date(2026, 8, 26, 6, 12);

const parts = (over: Partial<Parameters<typeof substituteEntryTemplate>[1]> = {}) => ({
  time: '06:12',
  date: '2026-09-26',
  datetime: '2026-09-26T06:12:00',
  title: '',
  tags: '',
  content: '',
  ...over,
});

describe('substituteEntryTemplate', () => {
  it('drops placeholder-only lines that render empty', () => {
    expect(substituteEntryTemplate(CLASSIC_ENTRY_PATTERN, parts())).toBe('## 06:12');
    expect(substituteEntryTemplate(CLASSIC_ENTRY_PATTERN, parts({ content: 'body' }))).toBe(
      '## 06:12\nbody',
    );
  });

  it('collapses blank runs and trims, keeping a literal single blank line', () => {
    expect(
      substituteEntryTemplate(
        RULED_ENTRY_PATTERN,
        parts({ title: ' — X', tags: '#a', content: 'B' }),
      ),
    ).toBe('## 06:12 — X\n---\n#a\n\nB');
  });

  it('removes a trailing rule line (topic-only Ruled entry)', () => {
    expect(substituteEntryTemplate(RULED_ENTRY_PATTERN, parts({ title: ' — X' }))).toBe(
      '## 06:12 — X',
    );
    expect(substituteEntryTemplate(RULED_ENTRY_PATTERN, parts())).toBe('## 06:12');
  });
});

describe('composeEntry (Classic template)', () => {
  it('writes the documented shape: heading, text, tag meta line', () => {
    const text = composeEntry(
      {
        topic: 'Rollout-Sync',
        text: 'Kurzes Sync mit Team zu Rollout-Plan, Risiken bei DB-Migration besprochen.',
        tags: ['daily', 'arbeit'],
      },
      CLASSIC_ENTRY_PATTERN,
      at,
    );
    expect(text).toBe(
      '## 06:12 — Rollout-Sync\n' +
        'Kurzes Sync mit Team zu Rollout-Plan, Risiken bei DB-Migration besprochen.\n' +
        '#daily #arbeit',
    );
  });

  it('drops the topic when blank and the meta line when nothing is tagged', () => {
    expect(composeEntry({ ...EMPTY_ENTRY_DRAFT, text: 'lklk' }, CLASSIC_ENTRY_PATTERN, at)).toBe(
      '## 06:12\nlklk',
    );
    expect(composeEntry({ ...EMPTY_ENTRY_DRAFT, tags: ['foo'] }, CLASSIC_ENTRY_PATTERN, at)).toBe(
      '## 06:12\n#foo',
    );
  });

  it('is a bare heading for a fully empty draft', () => {
    expect(composeEntry(EMPTY_ENTRY_DRAFT, CLASSIC_ENTRY_PATTERN, at)).toBe('## 06:12');
    expect(composeEntry(EMPTY_ENTRY_DRAFT, RULED_ENTRY_PATTERN, at)).toBe('## 06:12');
  });

  it('normalises a leading `#` the user may have typed into a chip', () => {
    expect(formatEntryMeta({ ...EMPTY_ENTRY_DRAFT, tags: ['#a', 'b'] })).toBe('#a #b');
  });

  it('round-trips back through the entry parser', () => {
    const text = composeEntry(
      { ...EMPTY_ENTRY_DRAFT, topic: 'Rollout-Sync', text: 'x #daily' },
      CLASSIC_ENTRY_PATTERN,
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

describe('composeEntry (Ruled template)', () => {
  it('writes heading / rule / tags / blank / body', () => {
    expect(
      composeEntry(
        { topic: 'Urlaub-Ideen', text: 'Mallorca oder Kroatien.', tags: ['urlaub', 'planung'] },
        RULED_ENTRY_PATTERN,
        at,
      ),
    ).toBe('## 06:12 — Urlaub-Ideen\n---\n#urlaub #planung\n\nMallorca oder Kroatien.');
  });

  it('round-trips to a clean text (parser skips the leading rule and tag line)', () => {
    const text = composeEntry(
      { topic: 'X', text: 'Body line #daily', tags: ['daily'] },
      RULED_ENTRY_PATTERN,
      at,
    );
    expect(parseDatedEntries(text)[0]).toMatchObject({ title: 'X', text: 'Body line #daily' });
  });
});

describe('appendEntry', () => {
  it('separates from existing content by exactly one blank line', () => {
    const result = appendEntry(
      '# 2026-09-26\n\n## 04:48\nlklk\n\n\n',
      { ...EMPTY_ENTRY_DRAFT, text: 'neu' },
      CLASSIC_ENTRY_PATTERN,
      at,
    );
    expect(result.text).toBe('# 2026-09-26\n\n## 04:48\nlklk\n\n## 06:12\nneu\n');
    expect(result.text.slice(result.at)).toBe('## 06:12\nneu\n');
  });

  it('writes into an empty document without a leading blank line', () => {
    expect(appendEntry('', { ...EMPTY_ENTRY_DRAFT, text: 'x' }, CLASSIC_ENTRY_PATTERN, at)).toEqual(
      { text: '## 06:12\nx\n', at: 0 },
    );
  });
});

describe('draft predicates', () => {
  it('hasEntryContent is false only for a fully empty draft', () => {
    expect(hasEntryContent(EMPTY_ENTRY_DRAFT)).toBe(false);
    expect(hasEntryContent({ ...EMPTY_ENTRY_DRAFT, tags: ['  '] })).toBe(false);
    expect(hasEntryContent({ ...EMPTY_ENTRY_DRAFT, tags: ['a'] })).toBe(true);
  });
});
