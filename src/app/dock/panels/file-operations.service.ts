import { Injectable, inject } from '@angular/core';
import { EditorService } from '../../services/editor.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { VaultService } from '../../vault';
import { LinkUpdateService } from '../../link-update';
import { VaultFileEntry, VaultStatus } from '../../../../shared/ipc-api';
import { TreeTarget, isInvalidEntryName, parentDir } from './files-tree';

/**
 * What the Files panel does TO the vaults: create, rename, move, copy,
 * delete, and the vault registry actions. Each operation carries its own
 * confirmation, keeps open tabs and the panel clipboard in step, and shows
 * a failure in the in-renderer message dialog (the native one breaks
 * keyboard focus on Windows, electron#41602) -- none of them throws.
 *
 * It knows nothing about the tree's view state; where the panel has to
 * react (reveal a destination, drop a stale selection) the operation says
 * so through its return value.
 */
@Injectable({ providedIn: 'root' })
export class FileOperationsService {
  private readonly vault = inject(VaultService);
  private readonly editor = inject(EditorService);
  private readonly dialogs = inject(ConfirmDialogService);
  private readonly linkUpdate = inject(LinkUpdateService);

  /** Registers another vault via the native folder picker. */
  addVault(): Promise<boolean> {
    return this.guarded(() => this.vault.addVault());
  }

  /** Makes this vault the target for daily notes, capture, chats, new notes. */
  setActiveVault(vaultId: string): Promise<boolean> {
    return this.guarded(() => this.vault.setActiveVault(vaultId));
  }

  /** Changes a vault's display name; an empty name changes nothing. */
  async renameVault(vaultId: string, rawName: string): Promise<void> {
    const name = rawName.trim();
    if (!name) {
      return;
    }
    await this.guarded(() => this.vault.renameVault(vaultId, name));
  }

  revealVault(vaultId: string): Promise<boolean> {
    return this.guarded(() => this.vault.revealVaultFolder(vaultId));
  }

  /**
   * Registry-only removal: the folder and its files stay on disk. Open tabs
   * of this vault close first -- clean ones silently, each dirty one
   * through its own prompt; a cancelled prompt aborts the removal.
   */
  async removeVault(vault: VaultStatus): Promise<void> {
    const tabs = this.editor.openDocs().filter((d) => d.vaultId === vault.id);
    const removeConfirmed = await this.dialogs.confirm({
      title: 'Remove vault',
      message:
        `Remove vault "${vault.name}" from the list? The folder and its files stay on disk.` +
        (tabs.length > 0 ? ` ${tabs.length} open tab(s) will be closed.` : ''),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!removeConfirmed) {
      return;
    }
    for (const doc of tabs) {
      if (!(await this.editor.closeTab(doc.key))) {
        return; // a dirty-tab prompt was cancelled -- keep the vault
      }
    }
    await this.guarded(() => this.vault.removeVault(vault.id));
  }

  /** Opens a file the ordinary way: it replaces the focused pane's clean tab. */
  open(vaultId: string, relativePath: string): void {
    void this.editor.openFile(relativePath, vaultId);
  }

  /** Opens a file pinned, so the next plain open does not replace it. */
  openPinned(vaultId: string, relativePath: string): void {
    void this.editor.openFile(relativePath, vaultId, { pinned: true });
  }

  /** Opens every *file* among `targets`; folders are skipped. */
  openAll(targets: readonly TreeTarget[]): void {
    let first = true;
    for (const target of targets) {
      if (target.entry.type === 'file') {
        // Only the first open replaces the focused clean tab (`openFile`'s
        // default); the rest must open alongside it, not close each other.
        void this.editor.openFile(target.entry.relativePath, target.vaultId, {
          keepFocused: !first,
        });
        first = false;
      }
    }
  }

  /** Reveals the file/folder in the OS file manager (selected in its parent). */
  reveal(vaultId: string, relativePath: string): Promise<boolean> {
    return this.guarded(() => this.vault.revealPath(relativePath, vaultId));
  }

  /** Opens the OS terminal in a vault folder. */
  openInTerminal(vaultId: string, dir: string): Promise<boolean> {
    return this.guarded(() => this.vault.openInTerminal(dir, vaultId));
  }

  /** Marks an entry for a later `paste`. */
  copy(vaultId: string, entry: VaultFileEntry): void {
    this.vault.clipboard.set({ vaultId, path: entry.relativePath, name: entry.name });
  }

  /** Copies the clipboard entry into `dir` of `vaultId`; true when a copy was made. */
  async paste(vaultId: string, dir: string): Promise<boolean> {
    const clip = this.vault.clipboard();
    if (!clip) {
      return false;
    }
    return this.guarded(() => this.vault.copyEntry(clip.path, dir, clip.vaultId, vaultId));
  }

  duplicate(vaultId: string, relativePath: string): Promise<boolean> {
    return this.guarded(() => this.vault.duplicateEntry(relativePath, vaultId));
  }

  /** "Export as PDF…" on a .md file -- main reads the file straight from disk. */
  exportPdf(vaultId: string, relativePath: string): Promise<boolean> {
    return this.guarded(() => this.vault.exportPdf(relativePath, vaultId));
  }

  /**
   * Creates a file (opened afterwards; `.md` when the name has no
   * extension) or a folder in `dir`. An empty name does nothing.
   */
  async create(
    kind: 'file' | 'directory',
    vaultId: string,
    dir: string,
    rawName: string,
  ): Promise<void> {
    const name = rawName.trim();
    if (!name) {
      return;
    }
    if (isInvalidEntryName(name)) {
      void this.dialogs.message({ message: `Invalid name: ${name}` });
      return;
    }
    const finalName = kind === 'file' && !name.includes('.') ? `${name}.md` : name;
    const relativePath = dir ? `${dir}/${finalName}` : finalName;
    await this.guarded(async () => {
      await this.vault.createEntry(kind, relativePath, vaultId);
      if (kind === 'file') {
        await this.editor.openFile(relativePath, vaultId);
      }
    });
  }

  /**
   * Renames an entry in place. Links and attachments follow (milestone 59;
   * the user may cancel there), and so does the panel clipboard. An empty
   * or unchanged name does nothing.
   */
  async rename(vaultId: string, entry: VaultFileEntry, rawName: string): Promise<void> {
    const nextName = rawName.trim();
    if (!nextName || nextName === entry.name) {
      return;
    }
    if (isInvalidEntryName(nextName)) {
      void this.dialogs.message({ message: `Invalid name: ${nextName}` });
      return;
    }
    const parent = parentDir(entry.relativePath);
    const toPath = parent ? `${parent}/${nextName}` : nextName;
    await this.relocate(vaultId, entry.relativePath, vaultId, toPath, nextName);
  }

  /**
   * Moves an entry into `destDir` (req-23), possibly of ANOTHER vault
   * (ADR-0051: copy + delete in main, the assistant sidecar travels along).
   * Open tabs are re-pointed keeping unsaved buffers. True when the entry
   * moved -- false when the user cancelled the link update or it failed.
   */
  move(fromVaultId: string, fromRel: string, toVaultId: string, destDir: string): Promise<boolean> {
    const name = fromRel.slice(fromRel.lastIndexOf('/') + 1);
    const toRel = destDir ? `${destDir}/${name}` : name;
    return this.relocate(fromVaultId, fromRel, toVaultId, toRel, name);
  }

  /**
   * One `confirm`, per-path tab/clipboard cleanup, one batched IPC delete
   * PER VAULT (a selection can span vaults since ADR-0051). True once the
   * user confirmed -- the panel then drops its selection, also when the
   * delete itself failed.
   */
  async deleteEntries(targets: readonly TreeTarget[]): Promise<boolean> {
    if (targets.length === 0) {
      return false;
    }
    const what =
      targets.length === 1
        ? targets[0].entry.type === 'directory'
          ? 'folder'
          : 'file'
        : `${targets.length} items`;
    const names = targets.map((t) => `"${t.entry.relativePath}"`).join(', ');
    const deleteConfirmed = await this.dialogs.confirm({
      title: `Delete ${what}`,
      message: `${names} will be moved to the recycle bin.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!deleteConfirmed) {
      return false;
    }
    for (const target of targets) {
      this.editor.closeTabsUnder(target.vaultId, target.entry.relativePath);
      const clip = this.vault.clipboard();
      if (
        clip &&
        clip.vaultId === target.vaultId &&
        (clip.path === target.entry.relativePath ||
          clip.path.startsWith(`${target.entry.relativePath}/`))
      ) {
        this.vault.clipboard.set(null);
      }
    }
    await this.guarded(async () => {
      const byVault = new Map<string, string[]>();
      for (const target of targets) {
        const list = byVault.get(target.vaultId) ?? [];
        list.push(target.entry.relativePath);
        byVault.set(target.vaultId, list);
      }
      const notTrashed: string[] = [];
      for (const [vaultId, paths] of byVault) {
        notTrashed.push(...(await this.vault.deleteEntries(paths, vaultId)));
      }
      if (notTrashed.length > 0) {
        // The volume has no recycle bin (network share, some removable
        // drives): the delete stood, but permanently -- say so.
        await this.dialogs.message({
          title: 'Deleted permanently',
          message:
            notTrashed.length === 1
              ? `"${notTrashed[0]}" could not be moved to the recycle bin and was deleted permanently.`
              : `${notTrashed.length} items could not be moved to the recycle bin and were deleted permanently.`,
        });
      }
    });
    return true;
  }

  /** The shared half of rename and move: the link-aware rename, then the clipboard follows. */
  private async relocate(
    fromVaultId: string,
    fromRel: string,
    toVaultId: string,
    toRel: string,
    name: string,
  ): Promise<boolean> {
    let relocated = false;
    await this.guarded(async () => {
      // null = the user cancelled the link-update dialog.
      if ((await this.linkUpdate.rename(fromVaultId, fromRel, toVaultId, toRel)) === null) {
        return;
      }
      const clip = this.vault.clipboard();
      if (clip && clip.vaultId === fromVaultId && clip.path === fromRel) {
        this.vault.clipboard.set({ vaultId: toVaultId, path: toRel, name });
      }
      relocated = true;
    });
    return relocated;
  }

  /** Runs one operation; a failure is shown, not thrown. False when it failed. */
  private async guarded(run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (err) {
      void this.dialogs.message({ message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
}
