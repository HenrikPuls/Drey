import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '../../../../packages/tickets-engine/src/core/review-feedback';
import { MAX_REVIEW_COMMENTS } from '../../../../packages/tickets-engine/src/core/review-feedback';
import {
  EMPTY_MARKS,
  commentsOfFile,
  filesOf,
  loadMarks,
  pruneMarks,
  clampSplit,
  goalOfText,
  loadSplit,
  rangeOf,
  saveSplit,
  saveMarks,
  statOf,
  withComment,
  withoutComment,
  type MarkStorage,
} from './model';
import { vaultFileOf } from './open-file';

const diff = {
  truncated: false,
  files: [
    { status: 'M', path: 'src/a.ts', patch: '@@ -1,1 +1,2 @@\n-x\n+y\n+z' },
    { status: 'A', path: 'src/b.ts', patch: '@@ -0,0 +1,1 @@\n+b' },
    { status: 'M', path: 'img.png', patch: '' },
  ],
};

const comment = (patch: Partial<ReviewComment> = {}): ReviewComment => ({ file: 'src/a.ts', line: 2, endLine: null, text: 'why?', ...patch });

describe('filesOf', () => {
  it('counts lines per file and flags a patch-less file as binary', () => {
    const files = filesOf(diff);
    expect(files.map((f) => [f.path, f.added, f.removed, f.binary])).toEqual([
      ['src/a.ts', 2, 1, false],
      ['src/b.ts', 1, 0, false],
      ['img.png', 0, 0, true],
    ]);
    expect(statOf(files[0]!)).toBe('+2 −1');
    expect(statOf(files[1]!)).toBe('+1');
  });

  it('writes the summary line with the viewed count', () => {
    const files = filesOf(diff);
  });
});

describe('comments', () => {
  it('collapses whitespace, refuses empty text and the 51st comment', () => {
    expect(withComment([], comment({ text: '  a \n b ' }))?.[0]?.text).toBe('a b');
    expect(withComment([], comment({ text: '   ' }))).toBeNull();
    const full = Array.from({ length: MAX_REVIEW_COMMENTS }, () => comment());
    expect(withComment(full, comment())).toBeNull();
    expect(withComment(full, comment({ text: 'changed' }), 3)?.[3]?.text).toBe('changed');
  });

  it('removes one and sorts a file’s comments by line', () => {
    const list = [comment({ line: 9 }), comment({ file: 'x', line: 1 }), comment({ line: 2 })];
    expect(withoutComment(list, 1)).toHaveLength(2);
    expect(commentsOfFile(list, 'src/a.ts').map((e) => [e.comment.line, e.index])).toEqual([
      [2, 2],
      [9, 0],
    ]);
  });

  it('orders a range whichever way it was picked', () => {
    expect(rangeOf(5, 5)).toEqual({ line: 5, endLine: null });
    expect(rangeOf(8, 5)).toEqual({ line: 5, endLine: 8 });
    expect(rangeOf(5, 8)).toEqual({ line: 5, endLine: 8 });
  });

  it('drops marks of files that left the diff and viewed marks of changed patches', () => {
    const files = filesOf(diff);
    const marks = {
      comments: [comment(), comment({ file: 'gone.ts' })],
      viewed: [files[0]!.key, 'src/a.ts#stale'],
    };
    expect(pruneMarks(marks, files)).toEqual({ comments: [comment()], viewed: [files[0]!.key] });
  });
});

describe('persistence', () => {
  const memory = (): MarkStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it('round-trips the marks per ticket', () => {
    const storage = memory();
    const marks = { comments: [comment({ endLine: 4 })], viewed: ['a#1'] };
    saveMarks(storage, 'T-0121', marks);
    expect(loadMarks(storage, 'T-0121')).toEqual(marks);
    expect(loadMarks(storage, 'T-0122')).toEqual(EMPTY_MARKS);
  });

  it('survives broken or missing storage', () => {
    const storage = memory();
    storage.data.set('drey.tickets.review.T-1', '{nope');
    expect(loadMarks(storage, 'T-1')).toEqual(EMPTY_MARKS);
    expect(loadMarks(null, 'T-1')).toEqual(EMPTY_MARKS);
    expect(() =>
      saveMarks({ getItem: () => null, setItem: () => { throw new Error('full'); } }, 'T-1', EMPTY_MARKS),
    ).not.toThrow();
  });

  it('keeps only well-formed comments', () => {
    const storage = memory();
    storage.data.set(
      'drey.tickets.review.T-1',
      JSON.stringify({ comments: [comment(), { file: 1 }, null, { file: 'a', line: 1.5, endLine: null, text: 't' }], viewed: ['k', 3] }),
    );
    expect(loadMarks(storage, 'T-1')).toEqual({ comments: [comment()], viewed: ['k'] });
  });
});

describe('vaultFileOf', () => {
  const vaults = [
    { id: 'repo', path: 'E:\\projects\\Drey' },
    { id: 'wt', path: 'E:\\projects\\Drey\\.claude\\worktrees\\t-0121' },
  ];

  it('finds the vault that contains the worktree file, the longest root first', () => {
    expect(vaultFileOf(vaults, 'E:\\projects\\Drey\\.claude\\worktrees\\t-0121', 'plugins/a.ts')).toEqual({
      vaultId: 'wt',
      path: 'plugins/a.ts',
    });
    expect(vaultFileOf(vaults, 'e:/projects/drey', 'src/x.ts')).toEqual({ vaultId: 'repo', path: 'src/x.ts' });
  });

  it('is null when no vault holds it', () => {
    expect(vaultFileOf(vaults, 'D:\\other', 'a.ts')).toBeNull();
    expect(vaultFileOf(vaults, '', 'a.ts')).toBeNull();
  });
});

describe('the head and the splitters', () => {
  it('takes the first paragraph of the goal', () => {
    expect(goalOfText('## Goal\n\nDrag headings.\nThe text moves.\n\nMore.\n')).toBe('Drag headings. The text moves.');
    expect(goalOfText('## Plan\n\n### Goal\n\nA.\n')).toBe('A.');
    expect(goalOfText('## Log\n')).toBe('');
  });

  it('keeps the sizes in bounds and across a reload, the band as tall as its content by default', () => {
    expect(clampSplit('list', 10)).toBe(160);
    expect(clampSplit('list', 9000)).toBe(480);
    expect(clampSplit('proof', -5)).toBe(0);
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadSplit(storage)).toEqual({ proof: null, list: 250 });
    saveSplit(storage, { proof: 120, list: 300 });
    expect(loadSplit(storage)).toEqual({ proof: 120, list: 300 });
    store.set('tickets.review.split', 'not json');
    expect(loadSplit(storage)).toEqual({ proof: null, list: 250 });
  });
});
