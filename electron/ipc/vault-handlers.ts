import { ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  NoteSaveRequest,
  NoteSaveResult,
  VaultFileContent,
  VaultFileEntry,
  VaultRegistration,
} from '../../shared/ipc-api';
import { DailyNoteManager } from '../daily-note';
import { NoteManager } from '../note-manager';
import { PluginHost } from '../plugin-host';
import { VaultManager } from '../vault-manager';

export interface VaultHandlerDeps {
  vaultManager: VaultManager;
  dailyNotes: DailyNoteManager;
  noteManager: NoteManager;
  pluginHost: PluginHost;
  /** Restarts the vault watcher to match the (possibly new) vault + config. */
  syncVaultWatcher: () => Promise<void>;
  /** One full external-change round: index rebuild + `vault:changed` push. */
  fullVaultRefresh: () => void;
}

/**
 * Vault filesystem IPC: the vault registry (ADR-0051), the file trees,
 * read/write, asset saves, create/delete/rename/copy/duplicate, the native
 * save dialog, the daily-note content builder, and `note:save`.
 *
 * Every data op takes an optional trailing `vaultId` defaulting to the
 * active vault. Ops that move `.md` content in or out of the plugins'
 * index scope emit vault-change events scoped to that vault, so the
 * plugins rebuild and the renderer sees a consistent picture on its next
 * refresh; a registry mutation (add/remove/rename/set-active) runs the
 * all-vaults refresh round instead. External changes reach the same
 * machinery through the vault watcher / `vault:refresh` (ADR-0045).
 */
export function registerVaultHandlers({
  vaultManager,
  dailyNotes,
  noteManager,
  pluginHost,
  syncVaultWatcher,
  fullVaultRefresh,
}: VaultHandlerDeps): void {
  const rebuildIndexes = async (): Promise<void> => {
    // Plugins re-read whatever they cache on any index-affecting change.
    pluginHost.emitVaultChange({ kind: 'refresh' });
  };

  ipcMain.handle(IPC_CHANNELS.vaultGetActive, (): string | null =>
    vaultManager.getActiveVaultPath(),
  );

  // --- Vault registry (ADR-0051) -----------------------------------------
  // Every mutation runs the FULL refresh round (all-vaults): the plugins
  // rebuild their indexes for the new registry and the renderer reloads
  // the registry + all trees via the payload-less `vault:changed` push.
  // This is also what fixes the old `vault:select` gap, where a switch
  // rebuilt main-side indexes but never pushed to the renderer.
  ipcMain.handle(IPC_CHANNELS.vaultList, () => vaultManager.listVaults());
  ipcMain.handle(IPC_CHANNELS.vaultGetActiveId, (): string | null =>
    vaultManager.getActiveVaultId(),
  );
  ipcMain.handle(IPC_CHANNELS.vaultAdd, async (): Promise<VaultRegistration | null> => {
    const added = await vaultManager.addVault();
    if (added !== null) {
      await syncVaultWatcher();
      fullVaultRefresh();
    }
    return added;
  });
  ipcMain.handle(IPC_CHANNELS.vaultRemove, async (_event, vaultId: string): Promise<void> => {
    vaultManager.removeVault(vaultId);
    await syncVaultWatcher();
    fullVaultRefresh();
  });
  ipcMain.handle(
    IPC_CHANNELS.vaultRenameVault,
    (_event, vaultId: string, name: string) => vaultManager.renameVault(vaultId, name),
  );
  ipcMain.handle(IPC_CHANNELS.vaultSetActive, async (_event, vaultId: string): Promise<void> => {
    vaultManager.setActiveVault(vaultId);
    await syncVaultWatcher();
    fullVaultRefresh();
  });
  ipcMain.handle(IPC_CHANNELS.vaultRevealFolder, (_event, vaultId: string): void => {
    vaultManager.revealVaultFolder(vaultId);
  });
  ipcMain.handle(IPC_CHANNELS.vaultRevealPath, (_event, relativePath: string, vaultId: string): void => {
    vaultManager.revealPath(relativePath, vaultId);
  });
  ipcMain.handle(
    IPC_CHANNELS.vaultOpenInTerminal,
    async (_event, dirRelativePath: string, vaultId: string): Promise<void> => {
      await vaultManager.openTerminalIn(dirRelativePath, vaultId);
    },
  );

  // --- Filesystem ops -----------------------------------------------------
  // The manual refresh (Files panel button / ADR-0045): one full round in
  // main -- index rebuild plus the renderer push -- instead of the old
  // tree-only pull that left the tag/task indexes stale.
  ipcMain.handle(IPC_CHANNELS.vaultRefresh, async (): Promise<void> => {
    fullVaultRefresh();
  });
  ipcMain.handle(
    IPC_CHANNELS.vaultListFiles,
    (_event, vaultId?: string): Promise<VaultFileEntry[]> => vaultManager.listFiles(vaultId),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultReadFile,
    (_event, relativePath: string, vaultId?: string): Promise<VaultFileContent> =>
      vaultManager.readFile(relativePath, vaultId),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultWriteFile,
    async (_event, relativePath: string, content: string, vaultId?: string): Promise<number> => {
      const resolvedVaultId = vaultManager.resolveVaultId(vaultId);
      const modifiedMs = await vaultManager.writeFile(relativePath, content, resolvedVaultId);
      // A raw write bypasses the note:save pipeline — tell plugins directly.
      pluginHost.emitVaultChange({ kind: 'write', path: relativePath, vaultId: resolvedVaultId });
      return modifiedMs;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultSaveAsset,
    (
      _event,
      bytes: Uint8Array,
      ext: string,
      noteRelPath: string,
      vaultId?: string,
      preferredName?: string,
    ): Promise<string> => vaultManager.saveAsset(bytes, ext, noteRelPath, vaultId, preferredName),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultSaveAssetFromUrl,
    (_event, url: string, noteRelPath: string, vaultId?: string): Promise<string> =>
      vaultManager.saveAssetFromUrl(url, noteRelPath, vaultId),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultCreateFile,
    (_event, relativePath: string, vaultId?: string): Promise<string> =>
      vaultManager.createFile(relativePath, vaultId),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultCreateDirectory,
    (_event, relativePath: string, vaultId?: string): Promise<string> =>
      vaultManager.createDirectory(relativePath, vaultId),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultDelete,
    async (_event, relativePath: string, vaultId?: string): Promise<void> => {
      const resolvedVaultId = vaultManager.resolveVaultId(vaultId);
      await vaultManager.deleteEntry(relativePath, resolvedVaultId);
      // No file watcher -- the tag / task indexes would otherwise still list
      // entries from the deleted file until the next full rebuild.
      await rebuildIndexes();
    },
  );
  // Multi-select delete (bug-8): one round trip, one re-index for the whole
  // batch. Missing targets are not errors, so overlapping paths (a folder
  // and a file inside it) just work.
  ipcMain.handle(
    IPC_CHANNELS.vaultDeleteMany,
    async (_event, relativePaths: string[], vaultId?: string): Promise<void> => {
      for (const relativePath of relativePaths) {
        await vaultManager.deleteEntry(relativePath, vaultId);
      }
      await rebuildIndexes();
    },
  );
  // Rename / copy / duplicate can move `.md` content in or out of the
  // indexes' scope, so each rebuilds them (same reason as `vault:delete`).
  // A cross-vault move touches two indexes -- the all-vaults round covers it.
  ipcMain.handle(
    IPC_CHANNELS.vaultRename,
    async (
      _event,
      fromRel: string,
      toRel: string,
      fromVaultId?: string,
      toVaultId?: string,
    ): Promise<string> => {
      const resolvedFrom = vaultManager.resolveVaultId(fromVaultId);
      const resolvedTo = vaultManager.resolveVaultId(toVaultId ?? fromVaultId);
      const next = await vaultManager.renameEntry(fromRel, toRel, resolvedFrom, resolvedTo);
      if (resolvedFrom === resolvedTo) {
        await rebuildIndexes();
        pluginHost.emitVaultChange({ kind: 'rename', path: next, vaultId: resolvedTo });
      } else {
        fullVaultRefresh();
      }
      return next;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultCopy,
    async (
      _event,
      srcRel: string,
      destDirRel: string,
      srcVaultId?: string,
      destVaultId?: string,
    ): Promise<string> => {
      const resolvedFrom = vaultManager.resolveVaultId(srcVaultId);
      const resolvedTo = vaultManager.resolveVaultId(destVaultId ?? srcVaultId);
      const next = await vaultManager.copyEntry(srcRel, destDirRel, resolvedFrom, resolvedTo);
      if (resolvedFrom === resolvedTo) {
        await rebuildIndexes();
      } else {
        fullVaultRefresh();
      }
      return next;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultDuplicate,
    async (_event, srcRel: string, vaultId?: string): Promise<string> => {
      const next = await vaultManager.duplicateEntry(srcRel, vaultId);
      await rebuildIndexes();
      return next;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultPickSavePath,
    (_event, suggestedName: string, vaultId?: string): Promise<string | null> =>
      vaultManager.pickSavePath(suggestedName, vaultId),
  );
  ipcMain.handle(IPC_CHANNELS.dailyBuildContent, (_event, date: string): Promise<string> =>
    dailyNotes.noteContentFor(date),
  );
  ipcMain.handle(
    IPC_CHANNELS.noteSave,
    (_event, request: NoteSaveRequest): Promise<NoteSaveResult> => noteManager.saveNote(request),
  );
}
