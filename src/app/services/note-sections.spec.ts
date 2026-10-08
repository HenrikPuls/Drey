import { describe, expect, it } from 'vitest';
import {
  appendTagsToSection,
  frontmatterEndLine,
  sectionAtLine,
} from '../../../shared/note-sections';

describe('frontmatterEndLine', () => {
  it('returns 0 without frontmatter', () => {
    expect(frontmatterEndLine('# Head\n')).toBe(0);
    expect(frontmatterEndLine('')).toBe(0);
  });

  it('returns the closing fence line (1-based)', () => {
    const content = '---\ntype: notiz\n---\n\n# Head\n';
    expect(frontmatterEndLine(content)).toBe(3);
  });

  it('returns 0 for an unterminated frontmatter', () => {
    expect(frontmatterEndLine('---\ntype: notiz\n')).toBe(0);
  });

  it('ignores a `---` line further down', () => {
    const content = '# Head\n\n---\n\nmore\n';
    expect(frontmatterEndLine(content)).toBe(0);
  });
});

describe('sectionAtLine', () => {
  const DOC = [
    'pre-heading intro',
    '',
    '# One',
    'one body',
    '',
    '## Sub',
    'sub body',
    'continued',
    '',
    '# Two',
    '',
    '```',
    '# not a heading',
    '```',
    'after fence',
  ].join('\n');

  it('reports the implicit pre-heading section', () => {
    const section = sectionAtLine(DOC, 1);
    expect(section.startLine).toBe(1);
    expect(section.endLine).toBe(2);
    expect(section.text).toBe('pre-heading intro');
  });

  it('bounds a section by the next heading of any level', () => {
    const one = sectionAtLine(DOC, 3);
    expect(one.startLine).toBe(3);
    expect(one.endLine).toBe(5);
    expect(one.text).toBe('# One\none body');

    const sub = sectionAtLine(DOC, 8);
    expect(sub.startLine).toBe(6);
    expect(sub.endLine).toBe(9);
    expect(sub.text).toBe('## Sub\nsub body\ncontinued');
  });

  it('runs the last section to end of file, fences hiding `#`', () => {
    const two = sectionAtLine(DOC, 15);
    expect(two.startLine).toBe(10);
    expect(two.endLine).toBe(15);
    expect(two.text).toContain('# not a heading');
    expect(two.text).toContain('after fence');
  });

  it('counts a heading line itself as part of its section', () => {
    expect(sectionAtLine(DOC, 6).startLine).toBe(6);
  });

  it('clamps out-of-range lines', () => {
    expect(sectionAtLine(DOC, -5).startLine).toBe(1);
    expect(sectionAtLine(DOC, 999).endLine).toBe(15);
  });

  it('treats a heading-only document as one section', () => {
    const section = sectionAtLine('# Only\n', 1);
    expect(section).toEqual({ startLine: 1, endLine: 2, text: '# Only' });
  });

  it('ignores a fenced `#` before the first real heading', () => {
    const content = '```\n# fenced\n```\nreal\n\n# Head\n';
    const section = sectionAtLine(content, 4);
    expect(section.startLine).toBe(1);
    expect(section.endLine).toBe(5);
    expect(section.text).toBe('```\n# fenced\n```\nreal');
  });
});

describe('appendTagsToSection', () => {
  it('appends to the last prose line, space-separated', () => {
    const content = '# One\n\nbody text\n\n# Two\nother\n';
    const out = appendTagsToSection(content, 1, 4, ['sailing', 'kauf']);
    expect(out).toBe('# One\n\nbody text #sailing #kauf\n\n# Two\nother\n');
  });

  it('drops tags the section already has (case-insensitive)', () => {
    const content = '# One\nbody #Sailing\n';
    expect(appendTagsToSection(content, 1, 2, ['sailing', 'kauf'])).toBe(
      '# One\nbody #Sailing #kauf\n',
    );
    expect(appendTagsToSection(content, 1, 2, ['sailing'])).toBe(content);
  });

  it('never counts tags inside code spans or fences as present', () => {
    const content = '# One\n`#sailing` stays literal\n```\n#kauf\n```\n';
    const out = appendTagsToSection(content, 1, 5, ['sailing', 'kauf']);
    expect(out).toBe('# One\n`#sailing` stays literal #sailing #kauf\n```\n#kauf\n```\n');
  });

  it('skips fences, tables, quotes and HTML blocks when picking the anchor', () => {
    const content = ['| a | b |', '| - | - |', '> quoted', '<div>html</div>', '```', 'code', '```'].join('\n');
    expect(appendTagsToSection(content, 1, 7, ['t1'])).toBe(
      ['| a | b |', '| - | - |', '> quoted', '<div>html</div>', '#t1', '```', 'code', '```'].join('\n'),
    );
  });

  it('falls back to a new line for a heading-only section', () => {
    const content = '# One\n\n# Two\nbody\n';
    expect(appendTagsToSection(content, 1, 1, ['t1'])).toBe('# One\n#t1\n\n# Two\nbody\n');
  });

  it('falls back to a new line for a fenced-only section', () => {
    const content = '# One\n```ts\nconst a = 1;\n```\n';
    expect(appendTagsToSection(content, 1, 4, ['t1'])).toBe(
      '# One\n#t1\n```ts\nconst a = 1;\n```\n',
    );
  });

  it('writes into the given range only, leaving later sections untouched', () => {
    const content = '# One\nbody\n\n# Two\nbody\n';
    const out = appendTagsToSection(content, 5, 6, ['t2']);
    expect(out).toBe('# One\nbody\n\n# Two\nbody #t2\n');
    expect(out).not.toContain('#t2 #');
  });

  it('tolerates out-of-range bounds', () => {
    expect(appendTagsToSection('# H\nbody\n', 1, 99, ['t1'])).toBe('# H\nbody #t1\n');
  });
});
