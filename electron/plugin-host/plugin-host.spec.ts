import { describe, expect, it } from 'vitest';
import { vaultReadToolAllowed } from './plugin-host';

/**
 * The ADR-0069 read-scope rule: `vault_search`/`vault_read` default to the
 * ACTIVE vault, so a call whose scope excludes it must not carry them.
 * Writes and other tools pass; an absent scope is the pre-1.20 behaviour.
 */
describe('vaultReadToolAllowed (ADR-0069 scope filter)', () => {
  it('never filters tools outside the read pair', () => {
    expect(vaultReadToolAllowed('vault_write', ['other'], 'active')).toBe(true);
    expect(vaultReadToolAllowed('tasks_list', ['other'], 'active')).toBe(true);
  });

  it('an absent scope is unrestricted (pre-1.20 behaviour)', () => {
    expect(vaultReadToolAllowed('vault_search', undefined, 'active')).toBe(true);
    expect(vaultReadToolAllowed('vault_read', undefined, null)).toBe(true);
  });

  it('the active vault inside the scope keeps the read tools', () => {
    expect(vaultReadToolAllowed('vault_search', ['v1', 'active'], 'active')).toBe(true);
    expect(vaultReadToolAllowed('vault_read', ['active'], 'active')).toBe(true);
  });

  it('the active vault outside the scope drops the read tools', () => {
    expect(vaultReadToolAllowed('vault_search', ['docs'], 'active')).toBe(false);
    expect(vaultReadToolAllowed('vault_read', ['docs'], 'active')).toBe(false);
  });

  it('no active vault at all cannot be inside a scope', () => {
    expect(vaultReadToolAllowed('vault_search', ['docs'], null)).toBe(false);
  });
});
