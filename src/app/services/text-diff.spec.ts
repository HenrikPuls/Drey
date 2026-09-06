import { diffStats, lineDiff, pickPreviewStyle } from '../../../shared/text-diff';

describe('lineDiff', () => {
  it('marks added and removed lines and keeps common context aligned', () => {
    const rows = lineDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(rows.map((r) => `${r.type}:${r.text}`)).toEqual([
      'context:a',
      'del:b',
      'add:B',
      'context:c',
    ]);
  });

  it('handles a pure append', () => {
    const rows = lineDiff('a\n', 'a\nb\n');
    expect(rows).toEqual([
      { type: 'context', text: 'a', beforeLine: 1, afterLine: 1 },
      { type: 'add', text: 'b', beforeLine: null, afterLine: 2 },
    ]);
  });

  it('treats a trailing newline as no extra line', () => {
    expect(lineDiff('a', 'a\n')).toEqual([
      { type: 'context', text: 'a', beforeLine: 1, afterLine: 1 },
    ]);
  });
});

describe('diffStats', () => {
  it('counts added and removed lines', () => {
    expect(diffStats('a\nb\nc\n', 'a\nx\ny\nc\n')).toEqual({ added: 2, removed: 1 });
  });
});

describe('pickPreviewStyle', () => {
  it('is localized for a one-line change in a long document', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 5', 'line five');
    expect(pickPreviewStyle(before, after)).toBe('localized');
  });

  it('is document for a wholesale rewrite', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 18 }, (_, i) => `neu ${i}`).join('\n');
    expect(pickPreviewStyle(before, after)).toBe('document');
  });

  it('is document when there is no prior content', () => {
    expect(pickPreviewStyle('', 'anything')).toBe('document');
  });
});
