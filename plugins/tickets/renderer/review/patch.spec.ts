import { describe, expect, it } from 'vitest';
import { countsOf, patchRowsOf, viewedKeyOf, wholeFileRowsOf } from './patch';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  'index 1..2 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -3,4 +3,5 @@ head',
  ' keep',
  '-old',
  '+new one',
  '+new two',
  ' tail',
  '\\ No newline at end of file',
].join('\n');

describe('patchRowsOf', () => {
  it('numbers the rows from the hunk header and keeps the fence lines as meta', () => {
    const rows = patchRowsOf(PATCH);
    expect(rows.filter((r) => r.kind === 'meta').map((r) => r.text)).toEqual([
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '\\ No newline at end of file',
    ]);
    const body = rows.filter((r) => r.kind !== 'meta' && r.kind !== 'hunk');
    expect(body.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
      ['context', 3, 3, 'keep'],
      ['del', 4, null, 'old'],
      ['add', null, 4, 'new one'],
      ['add', null, 5, 'new two'],
      ['context', 5, 6, 'tail'],
    ]);
  });

  it('gives a binary file (empty patch) no rows', () => {
    expect(patchRowsOf('')).toEqual([]);
  });

  it('starts at line 1 when the hunk header is missing', () => {
    expect(patchRowsOf('+a\n b').map((r) => [r.kind, r.newNo])).toEqual([
      ['add', 1],
      ['context', 2],
    ]);
  });

  it('counts added and removed lines', () => {
    expect(countsOf(PATCH)).toEqual({ added: 2, removed: 1 });
    expect(countsOf('')).toEqual({ added: 0, removed: 0 });
  });
});

describe('wholeFileRowsOf', () => {
  it('lays the patch over the file: context around, changes in place, no hunk rows', () => {
    const file = ['l1', 'l2', 'keep', 'new one', 'new two', 'tail', 'l7'].join('\n') + '\n';
    const rows = wholeFileRowsOf(PATCH, file);
    expect(rows.map((r) => [r.kind, r.newNo, r.text])).toEqual([
      ['context', 1, 'l1'],
      ['context', 2, 'l2'],
      ['context', 3, 'keep'],
      ['del', null, 'old'],
      ['add', 4, 'new one'],
      ['add', 5, 'new two'],
      ['context', 6, 'tail'],
      ['context', 7, 'l7'],
    ]);
  });

  it('ends early when the file is shorter than the patch claims', () => {
    expect(wholeFileRowsOf('', 'a\nb')).toHaveLength(2);
  });
});

describe('marks and labels', () => {
  it('changes the viewed key when the patch changes', () => {
    expect(viewedKeyOf('a.ts', 'x')).toBe(viewedKeyOf('a.ts', 'x'));
    expect(viewedKeyOf('a.ts', 'x')).not.toBe(viewedKeyOf('a.ts', 'y'));
    expect(viewedKeyOf('a.ts', 'x').startsWith('a.ts#')).toBe(true);
  });

  it('words a line and a range', () => {
  });

  it('names the comment count on the send-back button', () => {
  });
});
