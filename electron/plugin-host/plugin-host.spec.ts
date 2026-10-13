import { describe, expect, it } from 'vitest';
import { assistantVaultOptions } from './plugin-host';

/**
 * What a plugin call may do with the vault tools (ADR-0071): the scope it
 * names bounds reading and writing, the vault group's rule decides about
 * changes, and the app's own folders stay out.
 */
describe('assistantVaultOptions', () => {
  it('carries the scope, the write rule and the assistant as origin', () => {
    expect(assistantVaultOptions(['docs'], 'confirm')).toEqual({
      scope: ['docs'],
      write: 'confirm',
      origin: 'assistant',
      protectAppFolders: true,
    });
  });

  it('leaves the scope open when the caller names none', () => {
    expect(assistantVaultOptions(undefined, 'off')).toEqual({
      write: 'off',
      origin: 'assistant',
      protectAppFolders: true,
    });
  });
});
