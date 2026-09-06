import {
  applySummarySection,
  mergeFrontmatterTags,
  selectSummaryInput,
  untaggedEntryText,
} from '../../../shared/llm';

describe('untaggedEntryText', () => {
  it('collects only the dated entries that carry no inline tag', () => {
    const body = [
      '---',
      'type: notiz',
      'tags: []',
      '---',
      '',
      '## 08:00',
      'Kiel-Dichtung prüfen',
      '',
      '## 09:30',
      'Zweite Besichtigung #sailing',
      '',
      '## 11:00',
      'Angebot abgelehnt',
    ].join('\n');
    expect(untaggedEntryText(body)).toBe('Kiel-Dichtung prüfen\n\nAngebot abgelehnt');
  });

  it('falls back to the whole body when there are no dated entries', () => {
    const body = '---\ntype: notiz\ntags: []\n---\n\nFreitext ohne Zeitstempel\n';
    expect(untaggedEntryText(body)).toBe('Freitext ohne Zeitstempel');
  });
});

describe('mergeFrontmatterTags', () => {
  it('adds only genuinely new, lower-cased tags', () => {
    const body = '---\ntype: notiz\ntags: ["sailing"]\n---\n\ntext\n';
    const result = mergeFrontmatterTags(body, ['Sailing', 'kiel', 'kiel']);
    expect(result?.added).toEqual(['kiel']);
    expect(result?.text).toContain('tags: ["sailing", "kiel"]');
  });

  it('returns null when nothing is new', () => {
    const body = '---\ntype: notiz\ntags: ["sailing"]\n---\n\ntext\n';
    expect(mergeFrontmatterTags(body, ['sailing'])).toBeNull();
  });

  it('returns null when the note has no frontmatter fence', () => {
    expect(mergeFrontmatterTags('just text\n', ['x'])).toBeNull();
  });
});

describe('selectSummaryInput', () => {
  const master = [
    '---',
    'type: master',
    'tags: ["sailing"]',
    '---',
    '',
    '## History',
    '### 2026-01-01 09:00',
    'Baseline: kein Kauf über 45k #important',
    '',
    '### 2026-08-20 10:00',
    'Alt und irrelevant',
    '',
    '### 2026-09-05 14:00',
    'Zweite Besichtigung geplatzt',
  ].join('\n');

  it('keeps recent entries plus older #important, drops stale ones', () => {
    const input = selectSummaryInput(master, 7);
    expect(input).toContain('Baseline: kein Kauf');
    expect(input).toContain('Zweite Besichtigung geplatzt');
    expect(input).not.toContain('Alt und irrelevant');
  });

  it('is empty for a master with no history', () => {
    expect(selectSummaryInput('---\ntype: master\n---\n\n## History\n')).toBe('');
  });
});

describe('applySummarySection', () => {
  const now = new Date('2026-09-06T14:32:10');

  it('replaces an existing Summary section, leaving other sections intact', () => {
    const master = [
      '---',
      'type: master',
      '---',
      '',
      '## Summary',
      '*(auto-generated, as of 2026-09-01 09:00)*',
      '',
      'Alte Zusammenfassung.',
      '',
      '## Context',
      'Hintergrund.',
      '',
      '## History',
      '### 2026-09-05 14:00',
      'Eintrag',
    ].join('\n');
    const out = applySummarySection(master, 'Neue Zusammenfassung.', now);
    expect(out).toContain('*(auto-generated, as of 2026-09-06 14:32)*');
    expect(out).toContain('Neue Zusammenfassung.');
    expect(out).not.toContain('Alte Zusammenfassung.');
    expect(out).toContain('## Context\nHintergrund.');
    expect(out).toContain('## History');
  });

  it('inserts a Summary section after the frontmatter when none exists', () => {
    const master = '---\ntype: master\n---\n\n## History\n### 2026-09-05 14:00\nEintrag\n';
    const out = applySummarySection(master, 'Erste Zusammenfassung.', now);
    expect(out).toMatch(/^---\ntype: master\n---\n\n## Summary\n/);
    expect(out).toContain('Erste Zusammenfassung.');
    expect(out).toContain('## History');
  });
});
