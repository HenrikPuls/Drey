/**
 * The `## Report` section's round trip (E8, concept §5.6): the strict
 * writer's shape survives the reader untouched, the forgiving reader
 * degrades partial input to defaults instead of guessing, and upserting
 * owns only its own block — frontmatter, Log and neighbouring chapters
 * survive.
 */
import { describe, expect, it } from 'vitest';
import {
  hasScoutReport,
  parseScoutReportSection,
  renderScoutReportSection,
  upsertScoutReportSection,
} from './scout';
import type { ScoutReport } from '../contracts/scout';

const FULL: ScoutReport = {
  writtenAt: '2026-11-02T14:32:00Z',
  by: 'pia',
  summary: 'The repo carries two index implementations;\nonly SQLite is wired into the build.',
  decisions: [
    {
      key: 'D1',
      question: 'Which storage should back the index?',
      recommendation: 'SQLite — the repo already ships the helper.',
      resolved: false,
    },
    {
      key: 'D2',
      question: 'Migrate existing data?',
      recommendation: 'yes, one migration script',
      resolved: true,
    },
  ],
};

describe('renderScoutReportSection', () => {
  it('writes the canonical shape', () => {
    expect(renderScoutReportSection(FULL)).toBe(
      '## Report\n' +
        '\n' +
        'Written on 2026-11-02T14:32:00Z by pia.\n' +
        '\n' +
        '### Summary\n' +
        '\n' +
        'The repo carries two index implementations;\n' +
        'only SQLite is wired into the build.\n' +
        '\n' +
        '### Decisions\n' +
        '\n' +
        '- [ ] D1: Which storage should back the index? — Recommendation: SQLite — the repo already ships the helper.\n' +
        '- [x] D2: Migrate existing data? — Recommendation: yes, one migration script\n',
    );
  });

  it('omits an empty summary body and a missing recommendation', () => {
    const text = renderScoutReportSection({
      writtenAt: '2026-11-02T14:32:00Z',
      by: 'tessa',
      summary: '',
      decisions: [{ key: 'D1', question: 'Ship it?', recommendation: null, resolved: false }],
    });
    expect(text).toContain('### Summary\n\n### Decisions');
    expect(text).toContain('- [ ] D1: Ship it?\n');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('parseScoutReportSection', () => {
  it('reads back exactly what the writer wrote', () => {
    const rendered = renderScoutReportSection(FULL);
    expect(parseScoutReportSection(rendered)).toEqual(FULL);
  });

  it('reads null when the heading is absent', () => {
    expect(parseScoutReportSection('## Description\n\nnothing here\n')).toBeNull();
  });

  it('forgives a missing stamp, summary and decisions block', () => {
    const parsed = parseScoutReportSection('## Report\n\nSome loose line.\n');
    expect(parsed).not.toBeNull();
    expect(parsed!.writtenAt).toBe('');
    expect(parsed!.by).toBe('');
    expect(parsed!.summary).toBe('');
    expect(parsed!.decisions).toEqual([]);
  });

  it('skips decision lines that do not follow the shape', () => {
    const parsed = parseScoutReportSection(
      '## Report\n\n### Decisions\n\n- a stray line\n- [ ] D9: Real? — Recommendation: yes\n',
    );
    expect(parsed!.decisions.map((d) => d.key)).toEqual(['D9']);
  });
});

describe('upsertScoutReportSection', () => {
  const ticket =
    '---\n' +
    'id: "T-0004"\n' +
    '---\n' +
    '\n' +
    '## Description\n' +
    '\n' +
    'Explore the storage options.\n' +
    '\n' +
    '## Log\n' +
    '\n' +
    '- `2026-11-02T14:00:00Z` owner — created\n';

  it('inserts before ## Log when the section is new', () => {
    const next = upsertScoutReportSection(ticket, renderScoutReportSection(FULL));
    expect(next.indexOf('## Description')).toBeLessThan(next.indexOf('## Report'));
    expect(next.indexOf('## Report')).toBeLessThan(next.indexOf('## Log'));
    expect(next).toContain('- `2026-11-02T14:00:00Z` owner — created\n');
  });

  it('replaces only its own block on a second write', () => {
    const once = upsertScoutReportSection(ticket, renderScoutReportSection(FULL));
    const second: ScoutReport = { ...FULL, writtenAt: '2026-11-02T15:00:00Z' };
    const twice = upsertScoutReportSection(once, renderScoutReportSection(second));
    expect(twice.match(/## Report/g)).toHaveLength(1);
    expect(twice).toContain('Written on 2026-11-02T15:00:00Z by pia.');
    expect(twice).not.toContain('14:32:00Z');
    expect(parseScoutReportSection(twice)).toEqual(second);
  });

  it('appends at the end when no Log exists', () => {
    const bare = '## Description\n\nx\n';
    const next = upsertScoutReportSection(bare, renderScoutReportSection(FULL));
    expect(next.indexOf('## Description')).toBeLessThan(next.indexOf('## Report'));
    expect(next.endsWith('\n')).toBe(true);
  });
});

describe('hasScoutReport', () => {
  it('is true with the heading, false without', () => {
    expect(hasScoutReport(renderScoutReportSection(FULL))).toBe(true);
    expect(hasScoutReport('## Report draft\n\nnot the heading\n')).toBe(false);
  });
});
