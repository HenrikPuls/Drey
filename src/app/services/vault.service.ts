import { Injectable, signal } from '@angular/core';
import { VaultFileEntry } from '../../../shared/ipc-api';

/**
 * Thin wrapper around `window.dreyApi`'s vault methods, exposed as
 * signals for components to read. Holds no logic beyond "call the IPC
 * bridge and remember the result" -- the actual vault logic (persistence,
 * directory reading) lives in the main process (electron/vault-manager.ts),
 * per CLAUDE.md's "no business logic inside components" (this extends to
 * "no filesystem access outside the main process" -- see ADR-0001).
 */
@Injectable({ providedIn: 'root' })
export class VaultService {
  readonly activeVaultPath = signal<string | null>(null);
  readonly fileTree = signal<VaultFileEntry[]>([]);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.refresh();
  }

  /** Re-reads the active vault path and, if one is set, its file tree. */
  async refresh(): Promise<void> {
    // No bridge at all (plain `ng serve` / a test that doesn't stub it), or
    // a main process too old to expose `getActiveVault` -- nothing to load.
    if (
      typeof window === 'undefined' ||
      !window.dreyApi ||
      typeof window.dreyApi.getActiveVault !== 'function'
    ) {
      return;
    }

    try {
      const activePath = await window.dreyApi.getActiveVault();
      this.activeVaultPath.set(activePath);

      if (activePath) {
        await this.loadFileTree();
      } else {
        this.fileTree.set([]);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Opens the native folder picker and refreshes state from the result. */
  async selectVault(): Promise<void> {
    const selected = await window.dreyApi.selectVault();
    this.activeVaultPath.set(selected);

    if (selected) {
      await this.loadFileTree();
    }
  }

  /**
   * Creates a file or folder at `relativePath` and reloads the tree so the
   * new entry shows. Errors propagate to the caller (the sidebar surfaces
   * them as a one-off alert) rather than landing in `error()` -- a bad name
   * or a name clash shouldn't blank the whole file list the way a failed
   * initial load does.
   */
  async createEntry(kind: 'file' | 'directory', relativePath: string): Promise<void> {
    if (typeof window === 'undefined' || !window.dreyApi) {
      return;
    }
    if (kind === 'file') {
      await window.dreyApi.createVaultFile(relativePath);
    } else {
      await window.dreyApi.createVaultDirectory(relativePath);
    }
    await this.loadFileTree();
  }

  private async loadFileTree(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);

    try {
      const entries = await window.dreyApi.listVaultFiles();
      this.fileTree.set(entries);
    } catch (err) {
      this.fileTree.set([]);
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }
}
