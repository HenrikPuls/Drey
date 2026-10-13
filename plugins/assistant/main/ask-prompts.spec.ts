import { describe, expect, it } from 'vitest';
import {
  ASK_TASKS_NOTE,
  buildToolsNote,
  buildVaultScopeNote,
} from './ask-prompts';

/**
 * The scoped tools note (ADR-0069 later change): the vault list shrinks to
 * the chip's targets, the "omit it for the active vault" hint survives
 * only while the active vault is in scope, and the scope note binds "the
 * vault" in the user's question to the selection.
 */

const VAULTS = [
  { id: 'test', name: 'TestVault', active: true },
  { id: 'docs', name: 'docs', active: false },
] as const;

describe('buildToolsNote', () => {
  it('lists every vault with the active-vault hint when unscoped', () => {
    const note = buildToolsNote('BASE.', VAULTS);
    expect(note).toContain('- test (TestVault)');
    expect(note).toContain('- docs (docs)');
    expect(note).toContain('omit it for the active vault');
  });

  it('shrinks to the scoped vaults and keeps the hint while active is in scope', () => {
    const note = buildToolsNote('BASE.', VAULTS, ['test', 'docs']);
    expect(note).toContain('- test (TestVault)');
    expect(note).toContain('- docs (docs)');
    expect(note).toContain('omit it for the active vault');
  });

  it('demands explicit vault ids when the active vault is out of scope', () => {
    const note = buildToolsNote('BASE.', VAULTS, ['docs']);
    expect(note).toContain('- docs (docs)');
    expect(note).not.toContain('- test (TestVault)');
    expect(note).not.toContain('omit it for the active vault');
    expect(note).toContain('ALWAYS pass one of these ids');
  });

  it('returns the bare note when no vault survives the filter', () => {
    expect(buildToolsNote('BASE.', VAULTS, ['gone'])).toBe('BASE.');
    expect(buildToolsNote('BASE.', [])).toBe('BASE.');
  });
});

describe('buildVaultScopeNote', () => {
  it('binds the question to the selected vaults', () => {
    const note = buildVaultScopeNote([{ id: 'docs', name: 'docs' }], false, true);
    expect(note).toContain('THE VAULT FOR THIS QUESTION');
    expect(note).toContain('docs (`docs`)');
    expect(note).toContain('the vault exploration tools');
    expect(note).toContain('never from other tools');
    expect(note).not.toContain('not attached this turn');
  });

  it('stays honest when no explore tools ride (no tool loop)', () => {
    const note = buildVaultScopeNote([{ id: 'docs', name: 'docs' }], false, false);
    expect(note).toContain('answered ONLY from the vault context above, never');
    expect(note).not.toContain('vault exploration tools');
  });

  it('names the withheld aux tools', () => {
    const note = buildVaultScopeNote(
      [
        { id: 'docs', name: 'docs' },
        { id: 'test', name: 'TestVault' },
      ],
      true,
      true,
    );
    expect(note).toContain('The tasks and template tools are not attached this turn');
  });

  it('is empty without targets', () => {
    expect(buildVaultScopeNote([], true, true)).toBe('');
  });
});

describe('ASK_TASKS_NOTE', () => {
  it('restricts the tool to task questions and bars content answers from it', () => {
    expect(ASK_TASKS_NOTE).toContain('ONLY a question about the user\'s tasks');
    expect(ASK_TASKS_NOTE).toContain('If the question is not about tasks, do NOT call tasks_list');
    expect(ASK_TASKS_NOTE).toContain('never use its results to describe what a vault contains');
  });
});
