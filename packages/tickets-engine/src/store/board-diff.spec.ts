import { describe, expect, it } from 'vitest';
import { assembleBoard } from '../core/ticket-board';
import { diffBoards, renderBoardDiff } from './board-diff';

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, claim: true, handover: manual }
  - { id: done, title: Done, handover: none }
---
`;

const file = (id: string, dir: string, extra = ''): { path: string; text: string } => ({
  path: `tickets/${dir}/${id}.md`,
  text: `---\nid: ${id}\ntitle: ${id}\npriority: normal\nentered-inbox: 2026-11-01T00:00:00Z\n${extra}---\n`,
});

const board = (files: Array<{ path: string; text: string }>) =>
  assembleBoard({
    vaultId: 'v',
    vaultName: 'v',
    activeVaultName: 'v',
    isGitRepo: true,
    defaultWorker: 'opencode',
    pipelineText: PIPELINE,
    reposText: null,
    files,
  });

describe('diffBoards', () => {
  it('reports identical boards as equal', () => {
    const a = board([file('T-0001', 'inbox'), file('T-0002', 'build')]);
    const diff = diffBoards(a, board([file('T-0001', 'inbox'), file('T-0002', 'build')]));
    expect(diff).toMatchObject({ equal: true, identical: 2, leftCount: 2, rightCount: 2 });
  });

  it('names tickets that exist on one side only', () => {
    const diff = diffBoards(board([file('T-0001', 'inbox'), file('T-0002', 'inbox')]), board([file('T-0002', 'inbox'), file('T-0003', 'inbox')]));
    expect(diff.onlyLeft).toEqual(['T-0001']);
    expect(diff.onlyRight).toEqual(['T-0003']);
    expect(diff.equal).toBe(false);
  });

  it('lists every differing field of a ticket, left and right value', () => {
    const left = board([file('T-0001', 'inbox', 'rank: 10\n')]);
    const right = board([file('T-0001', 'build', 'rank: 20\npersona: ben\n')]);
    const diff = diffBoards(left, right);
    expect(diff.differing).toHaveLength(1);
    const fields = Object.fromEntries(diff.differing[0]!.fields.map((f) => [f.field, [f.left, f.right]]));
    expect(fields['phase']).toEqual(['inbox', 'build']);
    expect(fields['meta.rank']).toEqual(['10', '20']);
    expect(fields['meta.persona']).toEqual(['', 'ben']);
  });

  it('reports a column whose order differs among the shared tickets', () => {
    const left = board([file('T-0001', 'inbox', 'rank: 1\n'), file('T-0002', 'inbox', 'rank: 2\n')]);
    const right = board([file('T-0001', 'inbox', 'rank: 2\n'), file('T-0002', 'inbox', 'rank: 1\n')]);
    const diff = diffBoards(left, right);
    expect(diff.columnOrder).toEqual([{ phase: 'inbox', left: ['T-0001', 'T-0002'], right: ['T-0002', 'T-0001'] }]);
  });

  it('ignores the path and the runner stamp', () => {
    const left = board([file('T-0001', 'inbox', 'run: { pid: 4, started-at: "2026-11-01T00:00:00Z", stream: s }\n')]);
    expect(diffBoards(left, board([file('T-0001', 'inbox')])).equal).toBe(true);
  });
});

describe('renderBoardDiff', () => {
  it('writes the verdict, the differing fields and the one-sided tickets', () => {
    const diff = diffBoards(board([file('T-0001', 'inbox', 'rank: 1\n'), file('T-0009', 'inbox')]), board([file('T-0001', 'inbox', 'rank: 2\n')]));
    const text = renderBoardDiff(diff, { generatedAt: '2026-11-04T12:00:00Z', leftName: 'files', rightName: 'dricket' });
    expect(text).toContain('**Differs**');
    expect(text).toContain('### T-0001');
    expect(text).toContain('`meta.rank`: `1` -> `2`');
    expect(text).toContain('## Only in files');
    expect(text).toContain('T-0009');
  });

  it('says so when the candidate board could not be built', () => {
    const text = renderBoardDiff(null, { generatedAt: 'now', leftName: 'files', rightName: 'dricket', error: 'dk was not found' });
    expect(text).toContain('could not be built: dk was not found');
  });

  it('says identical for equal boards', () => {
    const a = board([file('T-0001', 'inbox')]);
    expect(renderBoardDiff(diffBoards(a, a), { generatedAt: 'now', leftName: 'files', rightName: 'dricket' })).toContain('**Identical**');
  });
});
