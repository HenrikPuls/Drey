import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { VaultService } from '../vault';
import { PaneDropService } from './pane-drop.service';
import { PaneService } from './pane.service';

/** A minimal `DataTransfer` stand-in: `types`, `getData`, `files`. */
function transfer(opts: {
  types?: string[];
  data?: Record<string, string>;
  files?: Array<{ path: string }>;
}): DataTransfer {
  const data = opts.data ?? {};
  return {
    types: opts.types ?? Object.keys(data),
    getData: (t: string) => data[t] ?? '',
    files: (opts.files ?? []) as unknown as FileList,
  } as unknown as DataTransfer;
}

describe('PaneDropService', () => {
  let svc: PaneDropService;
  let editor: EditorService;
  let vault: VaultService;
  let panes: PaneService;

  beforeEach(async () => {
    TestBed.configureTestingModule({});
    // Two registered vaults; `v1` active. The service derives its state
    // from this registry bridge.
    window.dreyApi = {
      getActiveVault: () => Promise.resolve('C:/Vault'),
      getActiveVaultId: () => Promise.resolve('v1'),
      listVaults: () =>
        Promise.resolve([
          { id: 'v1', name: 'Vault', path: 'C:/Vault', exists: true, active: true },
          { id: 'v2', name: 'Second', path: 'D:/Second', exists: true, active: false },
        ]),
      listVaultFiles: () => Promise.resolve([]),
    } as unknown as DreyApi;
    svc = TestBed.inject(PaneDropService);
    editor = TestBed.inject(EditorService);
    vault = TestBed.inject(VaultService);
    panes = TestBed.inject(PaneService);
    // Let the registry load settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  describe('canOpen', () => {
    it('is true for a Files-panel vault-path drag', () => {
      expect(svc.canOpen(transfer({ types: ['application/x-drey-vault-path', 'text/plain'] }))).toBe(
        true,
      );
    });

    it('is true for an OS file drag', () => {
      expect(svc.canOpen(transfer({ types: ['Files'] }))).toBe(true);
    });

    it('is false for a URL-only drag and for nothing', () => {
      expect(svc.canOpen(transfer({ types: ['text/uri-list', 'text/html'] }))).toBe(false);
      expect(svc.canOpen(null)).toBe(false);
    });
  });

  describe('openFromDrop', () => {
    it('opens the tagged vault path, focusing the target pane first', async () => {
      const open = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);
      const focus = vi.spyOn(panes, 'focus');

      const handled = await svc.openFromDrop(
        'p1',
        transfer({ data: { 'application/x-drey-vault-path': 'notes/a.md' } }),
      );

      expect(handled).toBe(true);
      expect(focus).toHaveBeenCalledWith('p1');
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith('notes/a.md', 'v1');
    });

    it('resolves a keyed payload (vaultId::path) to that vault', async () => {
      const open = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

      const handled = await svc.openFromDrop(
        'p1',
        transfer({ data: { 'application/x-drey-vault-path': 'v2::notes/b.md' } }),
      );

      expect(handled).toBe(true);
      expect(open).toHaveBeenCalledWith('notes/b.md', 'v2');
    });

    it('resolves an OS file inside the active vault root to a relative path', async () => {
      const open = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

      const handled = await svc.openFromDrop(
        'p1',
        transfer({ types: ['Files'], files: [{ path: 'C:\\Vault\\sub\\x.md' }] }),
      );

      expect(handled).toBe(true);
      expect(open).toHaveBeenCalledWith('sub/x.md', 'v1');
    });

    it('ignores an OS file outside the vault root', async () => {
      const open = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

      const handled = await svc.openFromDrop(
        'p1',
        transfer({ types: ['Files'], files: [{ path: 'C:\\Other\\x.md' }] }),
      );

      expect(handled).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });

    it('returns false when the transfer carries nothing openable', async () => {
      const open = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

      const handled = await svc.openFromDrop('p1', transfer({ types: ['text/uri-list'] }));

      expect(handled).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });
  });
});
