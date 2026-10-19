import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFolderNumbering, gapFolderName, listTicketDirs, planFolderNumbering, resolvePhaseDir } from './phase-dirs';
import { TicketsGit } from './tickets-git';

describe('resolvePhaseDir', () => {
  it('uses the derived name when it exists', () => {
    const dirs = ['10-inbox', '20-prioritized', '_meta'];
    expect(resolvePhaseDir(dirs, 1, 'inbox')).toBe('10-inbox');
    expect(resolvePhaseDir(dirs, 2, 'prioritized')).toBe('20-prioritized');
  });

  it('reuses an existing directory whose stripped id matches — gap numbers and unprefixed', () => {
    // The owner's hand-made gap column: never renamed, never renumbered.
    expect(resolvePhaseDir(['10-inbox', '35-qa', '40-plan-review'], 4, 'qa')).toBe('35-qa');
    // A pre-migration unprefixed directory stays the write target.
    expect(resolvePhaseDir(['inbox', '_meta'], 1, 'inbox')).toBe('inbox');
  });

  it('falls back to the derived name when nothing matches (the writer creates it)', () => {
    expect(resolvePhaseDir(['10-inbox'], 3, 'plan')).toBe('30-plan');
    expect(resolvePhaseDir([], 8, 'done')).toBe('80-done');
  });

  it('never matches _meta or the archive folder as a phase', () => {
    expect(resolvePhaseDir(['_meta', 'archive'], 1, 'inbox')).toBe('10-inbox');
  });
});

describe('listTicketDirs', () => {
  let root = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-phasedirs-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('lists directories only, sorted, names as written', async () => {
    await fsp.mkdir(path.join(root, '20-prioritized'));
    await fsp.mkdir(path.join(root, '10-inbox'));
    await fsp.writeFile(path.join(root, 'readme.md'), 'x', 'utf8');
    await fsp.writeFile(path.join(root, 'notes.txt'), 'x', 'utf8');
    expect(await listTicketDirs(root)).toEqual(['10-inbox', '20-prioritized']);
  });

  it('a missing root reads as no directories', async () => {
    expect(await listTicketDirs(path.join(root, 'nowhere'))).toEqual([]);
  });
});

describe('planFolderNumbering (req-50)', () => {
  const ORDER = ['inbox', 'plan', 'build', 'done'];

  it('names every unprefixed or wrongly numbered folder with its derived name', () => {
    expect(planFolderNumbering(['_meta', 'archive', 'inbox', 'plan', '50-build', '40-done'], ORDER)).toEqual([
      { from: 'inbox', to: '10-inbox' },
      { from: 'plan', to: '20-plan' },
      { from: '50-build', to: '30-build' },
    ]);
  });

  it('folds two folders of one phase into the derived one and leaves the rest alone', () => {
    expect(planFolderNumbering(['inbox', '10-inbox', 'stray', '_meta'], ORDER)).toEqual([
      { from: 'inbox', to: '10-inbox' },
    ]);
  });

  it('is empty for a numbered repo', () => {
    expect(planFolderNumbering(['10-inbox', '20-plan', '30-build', '40-done', 'archive', '_meta'], ORDER)).toEqual([]);
  });
});

describe('gapFolderName (T-0043)', () => {
  // A new column slots in before the terminal: full NEW order, neighbours
  // are the phases around the new id's position.
  const ORDER = ['inbox', 'prioritized', 'build', 'qa', 'done'];

  it('picks the free integer nearest the gap midpoint (ties to the smaller)', () => {
    // Neighbours 30-build and 40-done: span (30, 40), midpoint 35.
    expect(gapFolderName(['10-inbox', '20-prioritized', '30-build', '40-done'], ORDER, 'qa')).toBe('35-qa');
    // A tighter span (33, 40) holds 34..39; the midpoint 36 wins.
    expect(gapFolderName(['10-inbox', '20-prioritized', '33-build', '40-done'], ORDER, 'qa')).toBe('36-qa');
    // An even span (31, 40) ties 35 and 36 to the smaller.
    expect(gapFolderName(['10-inbox', '20-prioritized', '31-build', '40-done'], ORDER, 'qa')).toBe('35-qa');
  });

  it('walks outward from a taken midpoint, smaller number first', () => {
    // 35 is taken by a stray folder: the smaller tie 34 wins.
    expect(
      gapFolderName(['10-inbox', '20-prioritized', '30-build', '40-done', '35-stray'], ORDER, 'qa'),
    ).toBe('34-qa');
    // 34 and 35 taken: 36 is the nearest free integer.
    expect(
      gapFolderName(
        ['10-inbox', '20-prioritized', '30-build', '40-done', '34-stray', '35-stray'],
        ORDER,
        'qa',
      ),
    ).toBe('36-qa');
  });

  it('counts an unprefixed neighbour as its derived position', () => {
    // `done` unprefixed at order position 5 counts as 50: span (30, 50).
    expect(gapFolderName(['10-inbox', '20-prioritized', '30-build', 'done'], ORDER, 'qa')).toBe('40-qa');
  });

  it('falls back to the derived name when the neighbours touch or the span is full', () => {
    // 39-build and 40-done leave no integer between them; the new column
    // sits at order position 4 -> derived 40-qa.
    expect(gapFolderName(['10-inbox', '20-prioritized', '39-build', '40-done'], ORDER, 'qa')).toBe('40-qa');
    // Every integer of the span taken: same fallback.
    const dirs = ['10-inbox', '20-prioritized', '30-build', '40-done'];
    for (let n = 31; n <= 39; n++) {
      dirs.push(`${n}-x${n}`);
    }
    expect(gapFolderName(dirs, ORDER, 'qa')).toBe('40-qa');
  });

  it('derives for an end position instead of guessing a gap', () => {
    // Not actually a middle slot (defensive): the derived name of that spot.
    expect(gapFolderName(['10-inbox', '20-build'], ['inbox', 'build', 'qa'], 'qa')).toBe('30-qa');
  });
});

describe('applyFolderNumbering (req-50)', () => {
  let tickets: string;
  beforeEach(async () => {
    tickets = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-number-'));
  });
  afterEach(async () => {
    await fsp.rm(tickets, { recursive: true, force: true });
  });

  async function put(rel: string): Promise<void> {
    await fsp.mkdir(path.dirname(path.join(tickets, rel)), { recursive: true });
    await fsp.writeFile(path.join(tickets, rel), rel, 'utf8');
  }

  it('swaps two numbered folders without a collision and merges into an existing target', async () => {
    await put('50-build/T-0001.md');
    await put('60-review/T-0002.md');
    await put('inbox/T-0003.md');
    await put('10-inbox/T-0004.md');
    const moves = planFolderNumbering(await listTicketDirs(tickets), ['inbox', 'x', 'y', 'z', 'review', 'build']);
    const touched = await applyFolderNumbering(tickets, moves);
    expect((await listTicketDirs(tickets)).sort()).toEqual(['10-inbox', '50-review', '60-build']);
    expect(await fsp.readFile(path.join(tickets, '60-build', 'T-0001.md'), 'utf8')).toBe('50-build/T-0001.md');
    expect(await fsp.readFile(path.join(tickets, '50-review', 'T-0002.md'), 'utf8')).toBe('60-review/T-0002.md');
    expect((await fsp.readdir(path.join(tickets, '10-inbox'))).sort()).toEqual(['T-0003.md', 'T-0004.md']);
    expect(touched.sort()).toEqual(['10-inbox', '50-build', '50-review', '60-build', '60-review', 'inbox']);
  });

  it('refuses before touching anything when two files of one name would meet', async () => {
    await put('inbox/T-0001.md');
    await put('10-inbox/T-0001.md');
    const moves = planFolderNumbering(await listTicketDirs(tickets), ['inbox']);
    await expect(applyFolderNumbering(tickets, moves)).rejects.toThrow('would overwrite');
    expect((await listTicketDirs(tickets)).sort()).toEqual(['10-inbox', 'inbox']);
  });

  it('commits the renames as one commit, removals included (TicketsGit.commitTree)', async () => {
    const git = new TicketsGit(() => 'git');
    const run = (args: string[]): Promise<string> =>
      git.run(tickets, ['-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args]);
    await run(['init', '-q']);
    await put('inbox/T-0001.md');
    await put('plan/T-0002.md');
    await run(['add', '-A']);
    await run(['commit', '-q', '-m', 'seed']);
    await put('plan/T-0009.md'); // untracked: rides along with its folder
    const touched = await applyFolderNumbering(tickets, planFolderNumbering(await listTicketDirs(tickets), ['inbox', 'plan']));
    await run(['config', 'user.name', 'spec']);
    await run(['config', 'user.email', 'spec@example.com']);
    await git.commitTree(tickets, touched, 'tickets: number phase folders');
    expect((await run(['status', '--porcelain'])).trim()).toBe('');
    const files = (await run(['ls-files'])).trim().split('\n').sort();
    expect(files).toEqual(['10-inbox/T-0001.md', '20-plan/T-0002.md', '20-plan/T-0009.md']);
    expect((await run(['log', '--oneline'])).trim().split('\n')).toHaveLength(2);
  });
});
