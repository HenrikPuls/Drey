import { describe, expect, it } from 'vitest';
import type { VaultFileOperation } from '../../../shared/plugin-api';
import {
  REASON_COPY,
  REASON_CREATE_DIR,
  REASON_CREATE_FILE,
  REASON_DELETE,
  REASON_META,
  REASON_MOVE_WITHIN,
  REASON_RENAME_DIR,
  REASON_RENAME_FILE,
  filesVerdict,
  moveTarget,
} from './files-guard';

/** The live pipeline shape: numbered folders, clean ids. */
const PHASES = ['inbox', 'prioritized', 'plan', 'build', 'review', 'done'];
const V = 'tickets-vault';
const OTHER = 'notes-vault';

const verdict = (
  operation: VaultFileOperation,
  over: { vaultId?: string | null; phaseIds?: readonly string[] } = {},
) =>
  filesVerdict({
    ticketsVaultId: over.vaultId === undefined ? V : over.vaultId,
    phaseIds: over.phaseIds ?? PHASES,
    operation,
  });

describe('filesVerdict (T-0042, the tickets vault guard)', () => {
  it('no board detected: everything is allowed', () => {
    expect(
      verdict({ kind: 'create', vaultId: V, path: 'tickets/new.md', type: 'file' }, { vaultId: null }),
    ).toEqual({ action: 'allow' });
    expect(
      verdict({ kind: 'delete', vaultId: V, paths: ['tickets/40-build/T-0001.md'] }, { vaultId: null }),
    ).toEqual({ action: 'allow' });
  });

  it('other vaults are untouched', () => {
    expect(verdict({ kind: 'create', vaultId: OTHER, path: 'tickets/new.md', type: 'file' })).toEqual({
      action: 'allow',
    });
    expect(
      verdict({ kind: 'move', fromVaultId: OTHER, fromPath: 'notes/a.md', toVaultId: OTHER, toDir: 'x' }),
    ).toEqual({ action: 'allow' });
  });

  it('the tickets vault OUTSIDE tickets/ stays free (the vault is dedicated, not owned)', () => {
    expect(verdict({ kind: 'create', vaultId: V, path: 'notes/new.md', type: 'file' })).toEqual({
      action: 'allow',
    });
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'notes/a.md', toVaultId: V, toDir: '_worktrees/T-0044' }),
    ).toEqual({ action: 'allow' });
  });

  // --- create ---------------------------------------------------------------

  it('create under tickets/ is refused, files and folders separately', () => {
    expect(verdict({ kind: 'create', vaultId: V, path: 'tickets/40-build/new.md', type: 'file' })).toEqual({
      action: 'refuse',
      reason: REASON_CREATE_FILE,
    });
    expect(verdict({ kind: 'create', vaultId: V, path: 'tickets/40-build', type: 'directory' })).toEqual({
      action: 'refuse',
      reason: REASON_CREATE_DIR,
    });
  });

  // --- rename ---------------------------------------------------------------

  it('rename of a ticket file is refused with the identity reason', () => {
    expect(verdict({ kind: 'rename', vaultId: V, fromPath: 'tickets/40-build/T-0001.md', toPath: 'tickets/40-build/T-0002.md' })).toEqual({
      action: 'refuse',
      reason: REASON_RENAME_FILE,
    });
  });

  it('rename of a phase folder is refused with the pipeline reason', () => {
    expect(verdict({ kind: 'rename', vaultId: V, fromPath: 'tickets/40-build', toPath: 'tickets/40-wip' })).toEqual({
      action: 'refuse',
      reason: REASON_RENAME_DIR,
    });
  });

  it('rename under tickets/_meta is refused with the settings reason', () => {
    expect(verdict({ kind: 'rename', vaultId: V, fromPath: 'tickets/_meta/pipeline.md', toPath: 'tickets/_meta/pipe.md' })).toEqual({
      action: 'refuse',
      reason: REASON_META,
    });
  });

  // --- copy (paste / duplicate) ----------------------------------------------

  it('copy of or into the tickets subtree is refused (the identity rationale)', () => {
    expect(
      verdict({ kind: 'copy', fromVaultId: V, fromPath: 'tickets/40-build/T-0001.md', toVaultId: V, toDir: 'notes' }),
    ).toEqual({ action: 'refuse', reason: REASON_COPY });
    expect(
      verdict({ kind: 'copy', fromVaultId: OTHER, fromPath: 'notes/a.md', toVaultId: V, toDir: 'tickets/40-build' }),
    ).toEqual({ action: 'refuse', reason: REASON_COPY });
    expect(
      verdict({ kind: 'copy', fromVaultId: OTHER, fromPath: 'notes/a.md', toVaultId: OTHER, toDir: 'x' }),
    ).toEqual({ action: 'allow' });
  });

  // --- delete ---------------------------------------------------------------

  it('delete under tickets/ is refused with the archive reason', () => {
    expect(verdict({ kind: 'delete', vaultId: V, paths: ['tickets/40-build/T-0001.md'] })).toEqual({
      action: 'refuse',
      reason: REASON_DELETE,
    });
    // A multi-select spanning vaults: one board target refuses the batch.
    expect(
      verdict({ kind: 'delete', vaultId: V, paths: ['notes/a.md', 'tickets/archive/T-0001.md'] }),
    ).toEqual({ action: 'refuse', reason: REASON_DELETE });
  });

  it('delete of only _meta files carries the settings reason', () => {
    expect(verdict({ kind: 'delete', vaultId: V, paths: ['tickets/_meta/order.md'] })).toEqual({
      action: 'refuse',
      reason: REASON_META,
    });
  });

  it('delete outside tickets/ in the same vault is allowed', () => {
    expect(verdict({ kind: 'delete', vaultId: V, paths: ['notes/a.md'] })).toEqual({ action: 'allow' });
  });

  // --- move: the board ticket ------------------------------------------------

  it('a board ticket into a phase folder is handled (a transition)', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/30-plan/T-0001.md', toVaultId: V, toDir: 'tickets/40-build' }),
    ).toEqual({ action: 'handle' });
    // Numbered and unnumbered folders alike.
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/inbox/T-0001.md', toVaultId: V, toDir: 'tickets/build' }),
    ).toEqual({ action: 'handle' });
  });

  it('a board ticket into tickets/archive is handled (an archive)', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/40-build/T-0001.md', toVaultId: V, toDir: 'tickets/archive' }),
    ).toEqual({ action: 'handle' });
  });

  it('a board ticket out of the tree, into a non-phase folder or another vault is refused', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/40-build/T-0001.md', toVaultId: V, toDir: 'notes' }),
    ).toEqual({ action: 'refuse', reason: REASON_MOVE_WITHIN });
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/40-build/T-0001.md', toVaultId: V, toDir: 'tickets/_meta' }),
    ).toEqual({ action: 'refuse', reason: '"tickets/_meta" is not a phase folder — columns come from the pipeline.' });
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/40-build/T-0001.md', toVaultId: OTHER, toDir: '' }),
    ).toEqual({ action: 'refuse', reason: REASON_MOVE_WITHIN });
  });

  // --- move: the archived ticket ----------------------------------------------

  it('an archived ticket into a phase folder is handled (an unarchive)', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/archive/T-0001.md', toVaultId: V, toDir: 'tickets/40-build' }),
    ).toEqual({ action: 'handle' });
  });

  it('an archived ticket anywhere else is refused', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/archive/T-0001.md', toVaultId: V, toDir: 'notes' }),
    ).toEqual({ action: 'refuse', reason: REASON_MOVE_WITHIN });
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/archive/T-0001.md', toVaultId: OTHER, toDir: '' }),
    ).toEqual({ action: 'refuse', reason: REASON_MOVE_WITHIN });
  });

  // --- move: directories and _meta ---------------------------------------------

  it('a directory under tickets/ and everything under _meta refuse their moves', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/40-build', toVaultId: V, toDir: 'notes' }),
    ).toEqual({ action: 'refuse', reason: REASON_RENAME_DIR });
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/_meta/prompts', toVaultId: V, toDir: 'notes' }),
    ).toEqual({ action: 'refuse', reason: REASON_META });
  });

  it('a ticket file in an unknown folder refuses (not on the board)', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: V, fromPath: 'tickets/stray/T-0001.md', toVaultId: V, toDir: 'tickets/40-build' }),
    ).toEqual({ action: 'refuse', reason: 'T-0001 is not on the board — refresh the board and try again.' });
  });

  it('a file from OUTSIDE dragged into the tree is refused with the create reason', () => {
    expect(
      verdict({ kind: 'move', fromVaultId: OTHER, fromPath: 'notes/a.md', toVaultId: V, toDir: 'tickets/40-build' }),
    ).toEqual({ action: 'refuse', reason: REASON_CREATE_FILE });
    // Into the vault root (not under tickets/): free.
    expect(
      verdict({ kind: 'move', fromVaultId: OTHER, fromPath: 'notes/a.md', toVaultId: V, toDir: '' }),
    ).toEqual({ action: 'allow' });
  });
});

describe('moveTarget (the move -> board-treatment mapping)', () => {
  const target = (fromPath: string, toDir: string) => moveTarget({ fromPath, toDir, phaseIds: PHASES });

  it('phase -> phase maps to a transition with clean ids', () => {
    expect(target('tickets/30-plan/T-0001.md', 'tickets/40-build')).toEqual({
      kind: 'transition',
      id: 'T-0001',
      from: 'plan',
      to: 'build',
    });
  });

  it('a numbered folder strips to the clean phase id', () => {
    expect(target('tickets/10-inbox/T-0042.md', 'tickets/80-done')).toEqual({
      kind: 'transition',
      id: 'T-0042',
      from: 'inbox',
      to: 'done',
    });
  });

  it('into tickets/archive maps to an archive', () => {
    expect(target('tickets/40-build/T-0001.md', 'tickets/archive')).toEqual({
      kind: 'archive',
      id: 'T-0001',
    });
  });

  it('archive -> phase folder maps to an unarchive', () => {
    expect(target('tickets/archive/T-0001.md', 'tickets/40-build')).toEqual({
      kind: 'unarchive',
      id: 'T-0001',
      to: 'build',
    });
  });

  it('archive -> anywhere else refuses', () => {
    expect(target('tickets/archive/T-0001.md', 'tickets/archive')).toEqual({
      kind: 'refused',
      reason: '"tickets/archive" is not a phase folder — columns come from the pipeline.',
    });
    expect(target('tickets/archive/T-0001.md', '')).toEqual({
      kind: 'refused',
      reason: REASON_MOVE_WITHIN,
    });
  });

  it('a subfolder of a phase is not a phase folder', () => {
    expect(target('tickets/40-build/T-0001.md', 'tickets/40-build/sub')).toEqual({
      kind: 'refused',
      reason: '"tickets/40-build/sub" is not a phase folder — columns come from the pipeline.',
    });
  });

  it('a non-ticket path never maps', () => {
    expect(target('tickets/40-build', 'tickets/50-review')).toEqual({
      kind: 'refused',
      reason: REASON_RENAME_DIR,
    });
  });
});
