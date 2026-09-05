import { Injectable, signal } from '@angular/core';
import { VaultFileEntry } from '../../../shared/ipc-api';

/**
 * Thin wrapper around `window.cyberNotesApi`'s vault methods, exposed as
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
    if (typeof window === 'undefined' || !window.cyberNotesApi) {
      // Plain `ng serve` in a browser tab, outside Electron -- see App's
      // own ipcAvailable check. Nothing to load.
      return;
    }

    const activePath = await window.cyberNotesApi.getActiveVault();
    this.activeVaultPath.set(activePath);

    if (activePath) {
      await this.loadFileTree();
    } else {
      this.fileTree.set([]);
    }
  }

  /** Opens the native folder picker and refreshes state from the result. */
  async selectVault(): Promise<void> {
    const selected = await window.cyberNotesApi.selectVault();
    this.activeVaultPath.set(selected);

    if (selected) {
      await this.loadFileTree();
    }
  }

  private async loadFileTree(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);

    try {
      const entries = await window.cyberNotesApi.listVaultFiles();
      this.fileTree.set(entries);
    } catch (err) {
      this.fileTree.set([]);
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }
}
