import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTicketDirs, resolvePhaseDir } from './phase-dirs';

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
