import { describe, expect, it, vi } from 'vitest';
import { hostVaultIdMapper } from './host-vault-id';

const vaults = [
  { id: 'v-notes', path: 'E:\\vaults\\notes', exists: true },
  { id: 'v-tickets', path: 'E:\\vaults\\drey-tickets', exists: true },
  { id: 'v-gone', path: 'E:\\old\\drey-tickets', exists: false },
];

describe('hostVaultIdMapper', () => {
  it('swaps the engine id for the Drey vault that holds the board', async () => {
    const hasBoard = vi.fn(async (id: string) => id === 'v-tickets');
    const map = hostVaultIdMapper({ listVaults: async () => vaults, hasBoard });
    const mapped = await map({ vaultId: 'standalone', vaultName: 'drey-tickets', other: 1 });
    expect(mapped).toEqual({ vaultId: 'v-tickets', vaultName: 'drey-tickets', other: 1 });
    // remembered: the probe does not run again
    await map({ vaultId: 'standalone', vaultName: 'drey-tickets' });
    expect(hasBoard).toHaveBeenCalledTimes(1);
  });

  it('leaves a snapshot alone that already carries a Drey id, or no vault', async () => {
    const map = hostVaultIdMapper({ listVaults: async () => vaults, hasBoard: async () => true });
    const own = { vaultId: 'v-tickets', vaultName: 'drey-tickets' };
    expect(await map(own)).toBe(own);
    const none = { vaultId: null, vaultName: null };
    expect(await map(none)).toBe(none);
  });

  it('keeps the engine id when no vault matches (nothing is guessed)', async () => {
    const map = hostVaultIdMapper({ listVaults: async () => vaults, hasBoard: async () => false });
    const snapshot = { vaultId: 'standalone', vaultName: 'drey-tickets' };
    expect(await map(snapshot)).toBe(snapshot);
  });
});
