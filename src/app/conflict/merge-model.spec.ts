import { HunkSegment, MergeSegment, buildMerge, mergeResult, segmentText, settleStoreCounter } from './merge-model';

const hunks = (segments: MergeSegment[]): HunkSegment[] =>
  segments.filter((s): s is HunkSegment => s.kind === 'hunk');

describe('the store counter in the merge (D-16)', () => {
  const ticket = (rev: number, body: string, updated = 'a'): string =>
    `---\nid: t-3\nrev: ${rev}\nupdated_at: ${updated}\n---\n${body}\n`;

  it('never shows a rev bump as a block to decide: only the text blocks remain', () => {
    const disk = ticket(4, 'From the terminal.');
    const mine = settleStoreCounter(disk, ticket(3, 'From the app.'));
    const blocks = hunks(buildMerge(ticket(3, 'Original.'), disk, mine));
    expect(blocks.map((h) => [h.disk, h.mine])).toEqual([[['From the terminal.'], ['From the app.']]]);
  });

  it('keeps a neighbouring frontmatter change as a block of its own, without the rev', () => {
    const disk = ticket(4, 'Same.', 'terminal');
    const mine = settleStoreCounter(disk, ticket(3, 'Same.', 'app'));
    expect(hunks(buildMerge(ticket(3, 'Same.', 'old'), disk, mine)).map((h) => [h.disk, h.mine])).toEqual([[['updated_at: terminal'], ['updated_at: app']]]);
  });

  it('touches only an integer rev: line of the leading frontmatter', () => {
    const text = 'no frontmatter\nrev: 3\n';
    expect(settleStoreCounter('---\nrev: 9\n---\n', text)).toBe(text);
    const inBody = '---\ntitle: x\n---\nrev: 3\n';
    expect(settleStoreCounter('---\nrev: 9\ntitle: x\n---\nrev: 7\n', inBody)).toBe(inBody);
    const named = '---\nrev: draft\n---\n';
    expect(settleStoreCounter('---\nrev: 9\n---\n', named)).toBe(named);
    expect(settleStoreCounter('---\ntitle: x\n---\n', '---\nrev: 3\n---\n')).toBe('---\nrev: 3\n---\n');
  });
});

describe('merge model', () => {
  const base = 'title\n\none\ntwo\nthree\n';

  it('splits into shared runs and differing blocks', () => {
    const segments = buildMerge(base, 'title\n\nONE\ntwo\nthree\n', 'title\n\none\ntwo\nTHREE\n');
    expect(segments.map((s) => s.kind)).toEqual(['context', 'hunk', 'context', 'hunk']);
    expect(hunks(segments).map((h) => [h.disk, h.mine])).toEqual([
      [['ONE'], ['one']],
      [['three'], ['THREE']],
    ]);
  });

  it('preselects the side that changed; a block both changed starts on mine, flagged', () => {
    const segments = buildMerge(
      base,
      'title\n\nONE\ntwo\nthree\nadded on disk\n',
      'title\n\nmine\ntwo\nTHREE\n',
    );
    const [first, second] = hunks(segments);
    // Line 3: both changed it.
    expect([first.takeDisk, first.takeMine, first.conflict]).toEqual([false, true, true]);
    // The tail: mine changed "three"; disk kept it and appended a line.
    expect(second.disk).toEqual(['three', 'added on disk']);
    expect(second.conflict).toBe(true);

    const diskOnly = hunks(buildMerge(base, 'title\n\none\ntwo\nthree\nnew\n', base))[0];
    expect([diskOnly.takeDisk, diskOnly.takeMine, diskOnly.conflict]).toEqual([true, false, false]);
    const mineOnly = hunks(buildMerge(base, base, 'title\n\none\ntwo\n'))[0];
    expect([mineOnly.takeDisk, mineOnly.takeMine, mineOnly.conflict]).toEqual([false, true, false]);
  });

  it('gives one side back byte for byte when every block picks it', () => {
    const disk = 'a\nDISK\nc';
    const mine = 'a\nMINE\nc\n';
    const segments = buildMerge('a\nb\nc\n', disk, mine);
    const all = (side: 'disk' | 'mine'): MergeSegment[] =>
      segments.map((s) => (s.kind === 'hunk' ? { ...s, takeDisk: side === 'disk', takeMine: side === 'mine' } : s));
    expect(mergeResult(all('disk'), disk, mine)).toBe(disk);
    expect(mergeResult(all('mine'), disk, mine)).toBe(mine);
  });

  it('both sides of a block: disk lines, then mine; neither: the block is gone', () => {
    const disk = 'a\nDISK\nc\n';
    const mine = 'a\nMINE\nc\n';
    const segments = buildMerge('a\nb\nc\n', disk, mine);
    const set = (takeDisk: boolean, takeMine: boolean): MergeSegment[] =>
      segments.map((s) => (s.kind === 'hunk' ? { ...s, takeDisk, takeMine } : s));
    expect(mergeResult(set(true, true), disk, mine)).toBe('a\nDISK\nMINE\nc\n');
    expect(mergeResult(set(false, false), disk, mine)).toBe('a\nc\n');
    expect(segmentText(hunks(set(true, true))[0])).toBe('DISK\nMINE');
  });

  it('typed text wins over the selection, in blocks and in shared runs; a cleared block is removed', () => {
    const disk = 'a\nDISK\nc\n';
    const mine = 'a\nMINE\nc\n';
    const segments = buildMerge('a\nb\nc\n', disk, mine);
    const typed = segments.map((s, i) =>
      i === 0 ? { ...s, edited: 'A!' } : s.kind === 'hunk' ? { ...s, edited: 'own\ntext' } : s,
    );
    expect(mergeResult(typed, disk, mine)).toBe('A!\nown\ntext\nc\n');
    const cleared = segments.map((s) => (s.kind === 'hunk' ? { ...s, edited: '' } : s));
    expect(mergeResult(cleared, disk, mine)).toBe('a\nc\n');
  });

  it('keeps a blank line that separates two blocks', () => {
    const disk = 'x\n\ny\n';
    const mine = 'X\n\nY\n';
    const segments = buildMerge('x\n\ny\n', disk, mine);
    const both = segments.map((s) => (s.kind === 'hunk' ? { ...s, takeDisk: true, takeMine: true } : s));
    expect(mergeResult(both, disk, mine)).toBe('x\nX\n\ny\nY\n');
  });
});
