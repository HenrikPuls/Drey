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
});
