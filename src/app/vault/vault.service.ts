import { Injectable, computed, signal } from '@angular/core';
import { VaultFileEntry, VaultRegistration, VaultStatus } from '../../../shared/ipc-api';

/**
 * Thin wrapper around `window.dreyApi`'s vault methods, exposed as signals
 * for components to read. Holds no logic beyond "call the IPC bridge and
 * remember the result" -- the actual vault logic (persistence, directory
 * reading) lives in the main process (electron/vault-manager.ts), per
 * CLAUDE.md's "no business logic inside components" (this extends to "no
 * filesystem access outside the main process" -- see ADR-0001).
 *
 * Since ADR-0051 the service mirrors the whole vault REGISTRY: every
 * registered vault with its live status, which one is active, and each
 * vault's file tree. `fileTree` stays as the ACTIVE vault's tree so the
 * existing single-tree consumers (calendar, wikilinks' default index
 * source) keep working; the Files panel reads `vaults()` + `trees()` for
 * the multi-root view. The `vault:changed` push carries a `vaultId` for a
 * scoped change (one tree reloads); a push without one is registry-level
 * and reloads everything.
 */
@Injectable({ providedIn: 'root' })
export class VaultService {
  /** Every registered vault, in registration order, with live status. */
  readonly vaults = signal<VaultStatus[]>([]);
  /** The active vault's id (the default target for new content), or null. */
  readonly activeVaultId = signal<string | null>(null);
  /** Each vault's file tree, keyed by vault id. Missing folders get `[]`. */
  readonly trees = signal<Record<string, VaultFileEntry[]>>({});

  /** Absolute path of the active vault root, or null when none is active. */
  readonly activeVaultPath = computed<string | null>(
    () => this.vaults().find((v) => v.active)?.path ?? null,
  );

  /** The ACTIVE vault's tree -- the historical single-tree signal. */
  readonly fileTree = computed<VaultFileEntry[]>(() => {
    const id = this.activeVaultId();
    return id !== null ? (this.trees()[id] ?? []) : [];
  });

  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * The entry marked with "Copy" in the Files panel, awaiting a "Paste".
   * Lives on the service (not the panel) so it survives the panel being
   * unmounted and re-mounted as it is dragged between docks. Scoped to its
   * vault (ADR-0051) -- a cross-vault paste copies, it never merges trees.
   */
  readonly clipboard = signal<{ vaultId: string; path: string; name: string } | null>(null);

  constructor() {
    void this.refresh();
    // The vault-change push (ADR-0045): main announces external changes
    // (watcher batch), a manual refresh, or an MCP write after its plugin
    // index events -- the tree reload here is the renderer half of that
    // round. Lives on the service so every panel follows along, wherever
    // it is docked.
    if (typeof window !== 'undefined' && typeof window.dreyApi?.onVaultChanged === 'function') {
      window.dreyApi.onVaultChanged((push) => void this.reloadFromPush(push));
    }
  }

  /**
   * Re-reads the registry and, if a vault is active, asks main to run one
   * full refresh round first (index rebuild + the `vault:changed` push this
   * service subscribes to); the trees reload then happen via that push.
   */
  async refresh(): Promise<void> {
    if (
      typeof window === 'undefined' ||
      !window.dreyApi ||
      typeof window.dreyApi.getActiveVault !== 'function'
    ) {
      return;
    }

    try {
      if (typeof window.dreyApi.refreshVault === 'function') {
        // The push arrives (and the tree reload lands) before this resolves.
        await window.dreyApi.refreshVault();
        return;
      }
      await this.reloadFromPush();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** The pull half: re-read the registry (or one tree) from disk. */
  private async reloadFromPush(push?: { vaultId?: string }): Promise<void> {
    try {
      if (push?.vaultId !== undefined) {
        // Scoped: only that vault's tree changed.
        await this.loadTree(push.vaultId);
        return;
      }
      await this.loadRegistry();
      const ids = this.vaults().map((v) => v.id);
      if (ids.length > 0) {
        const trees = await Promise.all(ids.map((id) => this.pullTree(id)));
        this.trees.update((current) => {
          const next = { ...current };
          ids.forEach((id, i) => (next[id] = trees[i]));
          return next;
        });
      } else {
        this.trees.set({});
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  private async loadRegistry(): Promise<void> {
    this.activeVaultId.set(await window.dreyApi.getActiveVaultId());
    this.vaults.set(await window.dreyApi.listVaults());
  }

  /** Reloads one vault's tree (a scoped `vault:changed` push landed). */
  private async loadTree(vaultId: string): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const entries = await window.dreyApi.listVaultFiles(vaultId);
      this.trees.update((current) => ({ ...current, [vaultId]: entries }));
    } catch (err) {
      this.trees.update((current) => ({ ...current, [vaultId]: [] }));
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  /** `pullTree` = loadTree without touching the shared loading/error state. */
  private async pullTree(vaultId: string): Promise<VaultFileEntry[]> {
    try {
      return await window.dreyApi.listVaultFiles(vaultId);
    } catch {
      return []; // missing folder -- the registry row greys out
    }
  }

  // --- Vault registry (ADR-0051) -----------------------------------------

  /** Opens the native picker and registers a new vault. The full-refresh push reloads everything. */
  async addVault(): Promise<VaultRegistration | null> {
    const added = await window.dreyApi.addVault();
    // The main side fires an all-vaults refresh after a successful add;
    // mirror it locally in case the push is consumed out of order.
    await this.loadRegistry();
    return added;
  }

  /** Registry-only removal -- the folder on disk is untouched. */
  async removeVault(vaultId: string): Promise<void> {
    await window.dreyApi.removeVault(vaultId);
    await this.loadRegistry();
    this.trees.update((current) => {
      const next = { ...current };
      delete next[vaultId];
      return next;
    });
  }

  /** Renames a vault's display name (id and folder untouched). */
  async renameVault(vaultId: string, name: string): Promise<VaultRegistration> {
    const updated = await window.dreyApi.renameVault(vaultId, name);
    this.vaults.update((list) =>
      list.map((v) => (v.id === vaultId ? { ...v, name: updated.name } : v)),
    );
    return updated;
  }

  /** Makes `vaultId` the active vault. The all-vaults push reloads everything. */
  async setActiveVault(vaultId: string): Promise<void> {
    await window.dreyApi.setActiveVault(vaultId);
    await this.loadRegistry();
  }

  /** Shows the vault's folder in the OS file manager. */
  async revealVaultFolder(vaultId: string): Promise<void> {
    await window.dreyApi.revealVaultFolder(vaultId);
  }

  /** Reveals a vault-relative file/folder in the OS file manager. */
  async revealPath(relativePath: string, vaultId: string): Promise<void> {
    await window.dreyApi.revealVaultPath(relativePath, vaultId);
  }

  /** Opens the OS terminal in a vault-relative folder. */
  async openInTerminal(dirRelativePath: string, vaultId: string): Promise<void> {
    await window.dreyApi.openVaultFolderInTerminal(dirRelativePath, vaultId);
  }

  // --- Filesystem ops (all take the vault they act in) --------------------

  /**
   * Creates a file or folder at `relativePath` in `vaultId` and reloads that
   * vault's tree so the new entry shows. Errors propagate to the caller
   * (the sidebar surfaces them as a one-off alert) rather than landing in
   * `error()` -- a bad name or a name clash shouldn't blank the whole file
   * list the way a failed initial load does.
   */
  async createEntry(
    kind: 'file' | 'directory',
    relativePath: string,
    vaultId: string,
  ): Promise<void> {
    if (typeof window === 'undefined' || !window.dreyApi) {
      return;
    }
    if (kind === 'file') {
      await window.dreyApi.createVaultFile(relativePath, vaultId);
    } else {
      await window.dreyApi.createVaultDirectory(relativePath, vaultId);
    }
    await this.loadTree(vaultId);
  }

  /**
   * Renames / moves an entry and reloads its vault's tree. When
   * `toVaultId` differs the entry moves ACROSS vaults (the main side
   * copies + deletes). Resolves to the new vault-relative path. Errors
   * propagate to the caller (a one-off alert).
   */
  async renameEntry(
    fromRelativePath: string,
    toRelativePath: string,
    fromVaultId: string,
    toVaultId: string = fromVaultId,
  ): Promise<string> {
    if (typeof window === 'undefined' || !window.dreyApi?.renameVaultEntry) {
      throw new Error('Renaming needs the desktop app.');
    }
    const next = await window.dreyApi.renameVaultEntry(
      fromRelativePath,
      toRelativePath,
      fromVaultId,
      toVaultId,
    );
    if (fromVaultId === toVaultId) {
      await this.loadTree(fromVaultId);
    } else {
      await Promise.all([this.loadTree(fromVaultId), this.loadTree(toVaultId)]);
    }
    return next;
  }

  /** Copies an entry into `destDirRelativePath` (`''` = vault root) and reloads. */
  async copyEntry(
    sourceRelativePath: string,
    destDirRelativePath: string,
    sourceVaultId: string,
    destVaultId: string = sourceVaultId,
  ): Promise<string> {
    if (typeof window === 'undefined' || !window.dreyApi?.copyVaultEntry) {
      throw new Error('Copying needs the desktop app.');
    }
    const next = await window.dreyApi.copyVaultEntry(
      sourceRelativePath,
      destDirRelativePath,
      sourceVaultId,
      destVaultId,
    );
    if (sourceVaultId === destVaultId) {
      await this.loadTree(sourceVaultId);
    } else {
      await Promise.all([this.loadTree(sourceVaultId), this.loadTree(destVaultId)]);
    }
    return next;
  }

  /** Duplicates an entry next to itself (`" copy"` suffix) and reloads. */
  async duplicateEntry(sourceRelativePath: string, vaultId: string): Promise<string> {
    if (typeof window === 'undefined' || !window.dreyApi?.duplicateVaultEntry) {
      throw new Error('Duplicating needs the desktop app.');
    }
    const next = await window.dreyApi.duplicateVaultEntry(sourceRelativePath, vaultId);
    await this.loadTree(vaultId);
    return next;
  }

  /**
   * "Export as PDF…" on a tree row (Files panel context menu): main reads
   * the note from disk and owns the whole flow (render, print dialog,
   * write). The save target is deliberately allowed OUTSIDE the vault, so
   * unlike the other ops this resolves to the saved absolute path (`null`
   * on cancel) and touches no tree state -- nothing to reload afterwards.
   */
  async exportPdf(relativePath: string, vaultId: string): Promise<string | null> {
    if (typeof window === 'undefined' || !window.dreyApi?.exportNotePdf) {
      throw new Error('Exporting needs the desktop app.');
    }
    return window.dreyApi.exportNotePdf({ path: relativePath, vaultId });
  }

  /**
   * Deletes a file or folder and reloads the tree. Like `createEntry`,
   * errors propagate to the caller (the sidebar shows a one-off `alert`)
   * rather than blanking the whole list.
   */
  async deleteEntry(relativePath: string, vaultId: string): Promise<void> {
    await this.deleteEntries([relativePath], vaultId);
  }

  /**
   * Deletes several files / folders in one round trip and reloads the tree
   * once (the Files panel's multi-select delete, bug-8). The main process
   * fires a single vault-change re-index for the whole batch; per-path
   * errors propagate to the caller like `deleteEntry`.
   */
  async deleteEntries(relativePaths: string[], vaultId: string): Promise<void> {
    if (typeof window === 'undefined' || !window.dreyApi?.deleteVaultEntries) {
      return;
    }
    await window.dreyApi.deleteVaultEntries(relativePaths, vaultId);
    await this.loadTree(vaultId);
  }

  /**
   * Persists a pasted / dropped image into the note's vault (ADR-0024) and
   * returns the note-relative `attachments/<name>` path to put inside
   * `![](...)`. `noteRelPath` is the open document's vault-relative path
   * (`''` when nothing is open -> the vault root's `attachments/`). The
   * vault's tree is reloaded so the new `attachments/` folder shows. Throws
   * when there is no vault / no desktop bridge, so the caller can show a
   * "not saved" notice instead of a silent no-op.
   */
  async saveAsset(
    bytes: Uint8Array,
    ext: string,
    noteRelPath: string,
    vaultId: string | null,
  ): Promise<string> {
    if (typeof window === 'undefined' || typeof window.dreyApi?.saveVaultAsset !== 'function') {
      throw new Error('Saving images needs the desktop app.');
    }
    const rel = await window.dreyApi.saveVaultAsset(bytes, ext, noteRelPath, vaultId ?? undefined);
    if (vaultId !== null) {
      await this.loadTree(vaultId);
    }
    return rel;
  }

  /**
   * Same as {@link saveAsset}, but the stored file keeps (a sanitized form
   * of) `fileName` instead of a timestamp+hash name (ADR-0052) -- PDFs
   * stay recognisable documents in `attachments/`. Collisions get a
   * `-2`-style suffix main-side, so the returned path is always the one to
   * reference.
   */
  async saveNamedAsset(
    bytes: Uint8Array,
    fileName: string,
    noteRelPath: string,
    vaultId: string | null,
  ): Promise<string> {
    if (typeof window === 'undefined' || typeof window.dreyApi?.saveVaultAsset !== 'function') {
      throw new Error('Saving attachments needs the desktop app.');
    }
    const ext = fileName.toLowerCase().endsWith('.pdf')
      ? 'pdf'
      : (fileName.split('.').pop() ?? 'pdf').toLowerCase();
    const rel = await window.dreyApi.saveVaultAsset(
      bytes,
      ext,
      noteRelPath,
      vaultId ?? undefined,
      fileName,
    );
    if (vaultId !== null) {
      await this.loadTree(vaultId);
    }
    return rel;
  }

  /**
   * Reads a vault file's text -- the Files-panel drag of a text file
   * inlines its contents at the drop point (ADR-0028). Throws when the
   * bridge is missing so the caller can show a notice.
   */
  async readTextFile(relativePath: string, vaultId?: string): Promise<string> {
    if (typeof window === 'undefined' || typeof window.dreyApi?.readVaultFile !== 'function') {
      throw new Error('Reading files needs the desktop app.');
    }
    return (await window.dreyApi.readVaultFile(relativePath, vaultId)).content;
  }

  /**
   * Downloads a web image dragged from a browser into the vault (ADR-0028)
   * and returns the note-relative `attachments/<name>` path. The tree is
   * reloaded. Rejects with a user-facing message (bad URL, not an image,
   * too large, unreachable).
   */
  async saveAssetFromUrl(url: string, noteRelPath: string, vaultId: string | null): Promise<string> {
    if (
      typeof window === 'undefined' ||
      typeof window.dreyApi?.saveVaultAssetFromUrl !== 'function'
    ) {
      throw new Error('Downloading images needs the desktop app.');
    }
    const rel = await window.dreyApi.saveVaultAssetFromUrl(url, noteRelPath, vaultId ?? undefined);
    if (vaultId !== null) {
      await this.loadTree(vaultId);
    }
    return rel;
  }
}
