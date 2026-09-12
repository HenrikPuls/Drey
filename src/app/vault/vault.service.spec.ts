import { TestBed } from '@angular/core/testing';
import { VaultService } from './vault.service';
import { DreyApi, VaultFileEntry } from '../../../shared/ipc-api';

describe('VaultService', () => {
  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('stays empty when window.dreyApi is unavailable', async () => {
    const service = TestBed.inject(VaultService);
    await Promise.resolve(); // let the constructor's refresh() microtask settle

    expect(service.activeVaultPath()).toBeNull();
    expect(service.fileTree()).toEqual([]);
  });

  it('loads the active vault and its file tree when available', async () => {
    const fakeTree: VaultFileEntry[] = [
      { name: 'sailing', relativePath: 'sailing', type: 'directory', children: [] },
    ];
    const fakeApi: Partial<DreyApi> = {
      getActiveVault: () => Promise.resolve('E:/vault'),
      listVaultFiles: () => Promise.resolve(fakeTree),
    };
    window.dreyApi = fakeApi as DreyApi;

    const service = TestBed.inject(VaultService);
    await Promise.resolve();
    await Promise.resolve();

    expect(service.activeVaultPath()).toBe('E:/vault');
    expect(service.fileTree()).toEqual(fakeTree);
  });

  it('surfaces an error and clears the tree when listing fails', async () => {
    const fakeApi: Partial<DreyApi> = {
      getActiveVault: () => Promise.resolve('E:/gone'),
      listVaultFiles: () => Promise.reject(new Error('Vault folder no longer exists: E:/gone')),
    };
    window.dreyApi = fakeApi as DreyApi;

    const service = TestBed.inject(VaultService);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.fileTree()).toEqual([]);
    expect(service.error()).toContain('no longer exists');
  });

  describe('saveAssetFromUrl (ADR-0028)', () => {
    it('returns the path from the bridge and reloads the file tree', async () => {
      let listCalls = 0;
      window.dreyApi = {
        getActiveVault: () => Promise.resolve('E:/vault'),
        listVaultFiles: () => {
          listCalls++;
          return Promise.resolve([]);
        },
        saveVaultAssetFromUrl: (_url: string, note: string) =>
          Promise.resolve(`attachments/for-${note}.png`),
      } as unknown as DreyApi;

      const service = TestBed.inject(VaultService);
      await Promise.resolve();
      const before = listCalls;

      const rel = await service.saveAssetFromUrl('https://x/pic.png', 'notes/n.md');
      expect(rel).toBe('attachments/for-notes/n.md.png');
      expect(listCalls).toBeGreaterThan(before);
    });

    it('throws when the bridge is missing', async () => {
      const service = TestBed.inject(VaultService);
      await expect(service.saveAssetFromUrl('https://x/pic.png', '')).rejects.toThrow(
        /desktop app/,
      );
    });
  });

  describe('rename / copy / duplicate', () => {
    function apiWithCounts() {
      let listCalls = 0;
      const api = {
        getActiveVault: () => Promise.resolve('E:/vault'),
        listVaultFiles: () => {
          listCalls++;
          return Promise.resolve([] as VaultFileEntry[]);
        },
        renameVaultEntry: (_from: string, to: string) => Promise.resolve(to),
        copyVaultEntry: (_src: string, destDir: string) =>
          Promise.resolve(destDir ? `${destDir}/thing copy.md` : 'thing copy.md'),
        duplicateVaultEntry: (src: string) => Promise.resolve(src.replace(/\.md$/, ' copy.md')),
      } as unknown as DreyApi;
      return { api, listCalls: () => listCalls };
    }

    it('renameEntry returns the new path and reloads the tree', async () => {
      const { api, listCalls } = apiWithCounts();
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();
      const before = listCalls();

      const next = await service.renameEntry('notes/a.md', 'notes/b.md');
      expect(next).toBe('notes/b.md');
      expect(listCalls()).toBeGreaterThan(before);
    });

    it('copyEntry passes the destination folder through and reloads', async () => {
      const { api, listCalls } = apiWithCounts();
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();
      const before = listCalls();

      expect(await service.copyEntry('notes/thing.md', 'archive')).toBe('archive/thing copy.md');
      expect(listCalls()).toBeGreaterThan(before);
    });

    it('duplicateEntry reloads and returns the copy path', async () => {
      const { api } = apiWithCounts();
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();

      expect(await service.duplicateEntry('notes/thing.md')).toBe('notes/thing copy.md');
    });

    it('each throws a "needs the desktop app" error without the bridge', async () => {
      const service = TestBed.inject(VaultService);
      await expect(service.renameEntry('a', 'b')).rejects.toThrow(/desktop app/);
      await expect(service.copyEntry('a', '')).rejects.toThrow(/desktop app/);
      await expect(service.duplicateEntry('a')).rejects.toThrow(/desktop app/);
    });
  });

  describe('vault-change push / refresh round (ADR-0045)', () => {
    interface Harness {
      service: VaultService;
      listCalls: () => number;
      refreshCalls: () => number;
      notify: () => void;
    }

    function harnessWith(): Harness {
      TestBed.resetTestingModule();
      let lists = 0;
      let refreshes = 0;
      let pushListener: (() => void) | null = null;
      const api = {
        getActiveVault: () => Promise.resolve('E:/vault'),
        listVaultFiles: () => {
          lists++;
          return Promise.resolve([] as VaultFileEntry[]);
        },
        refreshVault: () => {
          refreshes++;
          // Mirror main: the round pushes before the invoke resolves.
          pushListener?.();
          return Promise.resolve();
        },
        onVaultChanged: (listener: () => void) => {
          pushListener = listener;
          return () => {
            pushListener = null;
          };
        },
      } as unknown as DreyApi;
      window.dreyApi = api;
      const service = TestBed.inject(VaultService);
      return {
        service,
        listCalls: () => lists,
        refreshCalls: () => refreshes,
        notify: () => pushListener?.(),
      };
    }

    it('refresh() routes through the main-process round and reloads via the push', async () => {
      const h = harnessWith();
      await Promise.resolve(); // the constructor's own refresh settles
      const refreshesBefore = h.refreshCalls();
      const listsBefore = h.listCalls();

      await h.service.refresh();

      expect(h.refreshCalls()).toBe(refreshesBefore + 1);
      // The round's push (not the invoke) does the tree reload.
      expect(h.listCalls()).toBe(listsBefore + 1);
    });

    it('reloads the tree when a push arrives', async () => {
      const h = harnessWith();
      await Promise.resolve();
      const before = h.listCalls();

      h.notify();
      await Promise.resolve();
      await Promise.resolve();

      expect(h.listCalls()).toBeGreaterThan(before);
    });

    it('falls back to the plain pull when main predates refreshVault', async () => {
      TestBed.resetTestingModule();
      let lists = 0;
      window.dreyApi = {
        getActiveVault: () => Promise.resolve('E:/vault'),
        listVaultFiles: () => {
          lists++;
          return Promise.resolve([] as VaultFileEntry[]);
        },
      } as unknown as DreyApi;
      const service = TestBed.inject(VaultService);
      await Promise.resolve();

      await service.refresh();

      expect(lists).toBeGreaterThanOrEqual(2); // constructor + refresh, both as pulls
    });
  });
});
