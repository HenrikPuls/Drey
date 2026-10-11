import { describe, expect, it } from 'vitest';
import { createVaultScanPorts, type VaultScanDeps } from './vault-scan';

/**
 * The filesystem explore ports (ADR-0069 later change): with semantic
 * retrieval disabled the explore tools keep working off fresh file reads —
 * overview carries headings, section uses the shared locator, find ranks
 * by token coverage, and `chats/` stays excluded like in the index.
 */

function makeDeps(): VaultScanDeps & {
  vaults: Record<string, Record<string, string>>;
} {
  const vaults: Record<string, Record<string, string>> = {
    docs: {
      '01_introduction.md': '# Goals\n\nLocal first notes.\n\n## Non-goals\n\nNo cloud sync.\n',
      'chats/2026/10/chat.md': '# A conversation\n\nAbout unrelated things entirely.\n',
    },
    test: {
      'notizen/zeit.md': '# Zeit\n\nBlockuniversum und Presentismus.\n',
    },
  };
  return {
    vaults,
    listVaults: async () => [
      { id: 'docs', name: 'docs', active: false },
      { id: 'test', name: 'TestVault', active: true },
    ],
    listMarkdownFiles: async (vaultId) => Object.keys(vaults[vaultId] ?? {}),
    readVaultText: async (vaultId, path) => vaults[vaultId]?.[path] ?? null,
  };
}

describe('createVaultScanPorts', () => {
  it('resolves targets through the registry', async () => {
    const ports = createVaultScanPorts(makeDeps());
    await expect(ports.resolveTargets('vault', [])).resolves.toEqual(['test']);
    await expect(ports.resolveTargets('custom', ['docs'])).resolves.toEqual(['docs']);
    await expect(ports.resolveTargets('custom', ['gone'])).resolves.toEqual([]);
  });

  it('outlines fresh files with their headings, chats/ excluded', async () => {
    const ports = createVaultScanPorts(makeDeps());
    const entries = await ports.outline('custom', ['docs']);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      vaultId: 'docs',
      vault: 'docs',
      path: '01_introduction.md',
    });
    expect(entries[0].headings).toEqual(['Goals', 'Non-goals']);
  });

  it('reads a section by heading and by line', async () => {
    const ports = createVaultScanPorts(makeDeps());
    await expect(ports.readSection('docs', '01_introduction.md', { heading: 'non-goals' })).resolves.toMatchObject({
      heading: 'Non-goals',
      line: 5,
      text: 'No cloud sync.',
    });
    await expect(ports.readSection('docs', '01_introduction.md', {})).resolves.toMatchObject({
      heading: 'Goals',
      line: 1,
    });
    await expect(ports.readSection('docs', 'missing.md', {})).resolves.toBeNull();
  });

  it('ranks find hits by token coverage and respects the limit', async () => {
    const deps = makeDeps();
    deps.vaults['docs']['02_architecture.md'] =
      '# Architecture\n\nNotes about notes: a local notes app architecture.\n';
    const ports = createVaultScanPorts(deps);
    const hits = await ports.searchScoped('local notes architecture', 'all', [], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ vaultId: 'docs', path: '02_architecture.md' });
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits.some((hit) => hit.path.startsWith('chats/'))).toBe(false);
  });

  it('returns no hits for a query without rankable tokens', async () => {
    const ports = createVaultScanPorts(makeDeps());
    await expect(ports.searchScoped('??', 'all', [], 5)).resolves.toEqual([]);
  });
});
