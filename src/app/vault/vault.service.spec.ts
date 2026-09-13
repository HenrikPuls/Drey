import { TestBed } from '@angular/core/testing';
import { VaultService } from './vault.service';
import { DreyApi, VaultFileEntry, VaultStatus } from '../../../shared/ipc-api';

const VAULT: VaultStatus = {
  id: 'v1',
  name: 'vault',
  path: 'E:/vault',
  exists: true,
  active: true,
};

/** A minimal registry-shaped bridge stub. */
function registryApi(overrides: Partial<DreyApi> = {}): Partial<DreyApi> {
  return {
    getActiveVault: () => Promise.resolve(VAULT.path),
    getActiveVaultId: () => Promise.resolve(VAULT.id),
    listVaults: () => Promise.resolve([VAULT]),
    listVaultFiles: () => Promise.resolve([] as VaultFileEntry[]),
    ...overrides,
  };
}

describe('VaultService', () => {
  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('stays empty when window.dreyApi is unavailable', async () => {
    const service = TestBed.inject(VaultService);
    await Promise.resolve(); // let the constructor's refresh() microtask settle

    expect(service.activeVaultPath()).toBeNull();
    expect(service.activeVaultId()).toBeNull();
    expect(service.vaults()).toEqual([]);
    expect(service.fileTree()).toEqual([]);
  });

  it('loads the registry and the active vault tree when available', async () => {
    const fakeTree: VaultFileEntry[] = [
      { name: 'sailing', relativePath: 'sailing', type: 'directory', children: [] },
    ];
    window.dreyApi = registryApi({
      listVaultFiles: (vaultId) =>
        Promise.resolve(vaultId === VAULT.id ? fakeTree : []),
    }) as DreyApi;

    const service = TestBed.inject(VaultService);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(service.activeVaultPath()).toBe('E:/vault');
    expect(service.activeVaultId()).toBe('v1');
    expect(service.vaults()).toEqual([VAULT]);
    expect(service.fileTree()).toEqual(fakeTree);
    expect(service.trees()['v1']).toEqual(fakeTree);
  });

  it('keeps the registration with an empty tree when listing fails', async () => {
    // A missing/unreadable vault folder greys out -- it never blanks the
    // whole panel or unregisters the vault (ADR-0051).
    window.dreyApi = registryApi({
      listVaultFiles: () => Promise.reject(new Error('Vault folder no longer exists: E:/vault')),
    }) as DreyApi;

    const service = TestBed.inject(VaultService);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(service.fileTree()).toEqual([]);
    expect(service.vaults()).toEqual([VAULT]);
    expect(service.activeVaultPath()).toBe('E:/vault');
  });

  describe('saveAssetFromUrl (ADR-0028)', () => {
    it('returns the path from the bridge and reloads the file tree', async () => {
      let listCalls = 0;
      window.dreyApi = registryApi({
        listVaultFiles: () => {
          listCalls++;
          return Promise.resolve([]);
        },
        saveVaultAssetFromUrl: (_url: string, note: string) =>
          Promise.resolve(`attachments/for-${note}.png`),
      }) as unknown as DreyApi;

      const service = TestBed.inject(VaultService);
      await Promise.resolve();
      const before = listCalls;

      const rel = await service.saveAssetFromUrl('https://x/pic.png', 'notes/n.md', 'v1');
      expect(rel).toBe('attachments/for-notes/n.md.png');
      expect(listCalls).toBeGreaterThan(before);
    });

    it('throws when the bridge is missing', async () => {
      const service = TestBed.inject(VaultService);
      await expect(service.saveAssetFromUrl('https://x/pic.png', '', 'v1')).rejects.toThrow(
        /desktop app/,
      );
    });
  });

  describe('rename / copy / duplicate', () => {
    function apiWithCounts() {
      let listCalls = 0;
      const api = registryApi({
        listVaultFiles: () => {
          listCalls++;
          return Promise.resolve([] as VaultFileEntry[]);
        },
        renameVaultEntry: (_from: string, to: string) => Promise.resolve(to),
        copyVaultEntry: (_src: string, destDir: string) =>
          Promise.resolve(destDir ? `${destDir}/thing copy.md` : 'thing copy.md'),
        duplicateVaultEntry: (src: string) => Promise.resolve(src.replace(/\.md$/, ' copy.md')),
      }) as unknown as DreyApi;
      return { api, listCalls: () => listCalls };
    }

    it('renameEntry returns the new path and reloads the tree', async () => {
      const { api, listCalls } = apiWithCounts();
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();
      const before = listCalls();

      const next = await service.renameEntry('notes/a.md', 'notes/b.md', 'v1');
      expect(next).toBe('notes/b.md');
      expect(listCalls()).toBeGreaterThan(before);
    });

    it('copyEntry passes the destination folder through and reloads', async () => {
      const { api, listCalls } = apiWithCounts();
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();
      const before = listCalls();

      expect(await service.copyEntry('notes/thing.md', 'archive', 'v1')).toBe(
        'archive/thing copy.md',
      );
      expect(listCalls()).toBeGreaterThan(before);
    });

    it('duplicateEntry reloads and returns the copy path', async () => {
      const { api } = apiWithCounts();
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();

      expect(await service.duplicateEntry('notes/thing.md', 'v1')).toBe('notes/thing copy.md');
    });

    it('each throws a "needs the desktop app" error without the bridge', async () => {
      const service = TestBed.inject(VaultService);
      await expect(service.renameEntry('a', 'b', 'v1')).rejects.toThrow(/desktop app/);
      await expect(service.copyEntry('a', '', 'v1')).rejects.toThrow(/desktop app/);
      await expect(service.duplicateEntry('a', 'v1')).rejects.toThrow(/desktop app/);
    });
  });

  describe('vault-change push / refresh round (ADR-0045)', () => {
    interface Harness {
      service: VaultService;
      listCalls: () => number;
      refreshCalls: () => number;
      notify: (vaultId?: string) => void;
    }

    function harnessWith(): Harness {
      TestBed.resetTestingModule();
      let lists = 0;
      let refreshes = 0;
      let pushListener: ((push: { vaultId?: string }) => void) | null = null;
      const api = registryApi({
        listVaultFiles: () => {
          lists++;
          return Promise.resolve([] as VaultFileEntry[]);
        },
        refreshVault: () => {
          refreshes++;
          // Mirror main: the round pushes before the invoke resolves.
          pushListener?.({});
          return Promise.resolve();
        },
        onVaultChanged: (listener: (push: { vaultId?: string }) => void) => {
          pushListener = listener;
          return () => {
            pushListener = null;
          };
        },
      }) as unknown as DreyApi;
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      return {
        service,
        listCalls: () => lists,
        refreshCalls: () => refreshes,
        notify: (vaultId?: string) => pushListener?.(vaultId ? { vaultId } : {}),
      };
    }

    it('refresh() routes through the main-process round and reloads via the push', async () => {
      const h = harnessWith();
      // Let the constructor's own refresh round settle completely.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const refreshesBefore = h.refreshCalls();
      const listsBefore = h.listCalls();

      await h.service.refresh();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(h.refreshCalls()).toBe(refreshesBefore + 1);
      // The round's push (not the invoke) does the tree reload.
      expect(h.listCalls()).toBe(listsBefore + 1);
    });

    it('reloads every tree when a registry-level push arrives', async () => {
      const h = harnessWith();
      await Promise.resolve();
      const before = h.listCalls();

      h.notify();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(h.listCalls()).toBeGreaterThan(before);
    });

    it('reloads only the named vault when the push is scoped', async () => {
      const h = harnessWith();
      await Promise.resolve();
      await Promise.resolve();
      const before = h.listCalls();

      h.notify('v1');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // One tree pull for the scoped push (a registry-level push also
      // re-pulls listVaults, but never lists trees twice here).
      expect(h.listCalls()).toBe(before + 1);
    });

    it('falls back to the plain pull when main predates refreshVault', async () => {
      TestBed.resetTestingModule();
      let lists = 0;
      window.dreyApi = registryApi({
        listVaultFiles: () => {
          lists++;
          return Promise.resolve([] as VaultFileEntry[]);
        },
      }) as unknown as DreyApi;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();

      await service.refresh();

      expect(lists).toBeGreaterThanOrEqual(2); // constructor + refresh, both as pulls
    });
  });
});
