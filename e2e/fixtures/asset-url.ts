import type { Page } from '@playwright/test';

/**
 * The exact `drey-asset://` URL the app builds for a vault-relative asset
 * path. Since ADR-0051 the vault id is the URL host
 * (`drey-asset://<vaultId>/asset/<path>`), and the id is minted at first
 * registration, so the test resolves the active vault's id from the registry
 * instead of hard-coding it. Path segments are encoded exactly like
 * `resolveVaultImageUrl` does.
 */
export async function activeVaultAssetUrl(page: Page, relativePath: string): Promise<string> {
  const vaults = await page.evaluate(() => window.dreyApi.listVaults());
  const active = vaults.find((vault) => vault.active);
  if (!active) {
    throw new Error('no active vault registered');
  }
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `drey-asset://${active.id}/asset/${encoded}`;
}
