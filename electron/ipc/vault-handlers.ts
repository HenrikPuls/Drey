import { ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  NoteSaveRequest,
  NoteSaveResult,
  VaultFileContent,
  VaultFileEntry,
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
 * Vault filesystem IPC: the active vault, the file tree, read/write, asset
 * saves, create/delete/rename/copy/duplicate, the native save dialog, the
 * daily-note content builder, and `note:save`.
 *
 * Ops that move `.md` content in or out of the plugins' index scope emit
 * vault-change events, so the plugins rebuild and the renderer sees a
 * consistent picture on its next refresh. External changes reach the same
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
  ipcMain.handle(IPC_CHANNELS.vaultSelect, async (): Promise<string | null> => {
    const selected = await vaultManager.selectVault();
    await rebuildIndexes();
    // The watcher follows the active vault -- stop on the old root, start
    // on the new one (no-op when disabled).
    await syncVaultWatcher();
    return selected;
  });
  // The manual refresh (Files panel button / ADR-0045): one full round in
  // main -- index rebuild plus the renderer push -- instead of the old
  // tree-only pull that left the tag/task indexes stale.
  ipcMain.handle(IPC_CHANNELS.vaultRefresh, async (): Promise<void> => {
    fullVaultRefresh();
  });
  ipcMain.handle(IPC_CHANNELS.vaultListFiles, (): Promise<VaultFileEntry[]> =>
    vaultManager.listFiles(),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultReadFile,
    (_event, relativePath: string): Promise<VaultFileContent> =>
      vaultManager.readFile(relativePath),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultWriteFile,
    async (_event, relativePath: string, content: string): Promise<number> => {
      const modifiedMs = await vaultManager.writeFile(relativePath, content);
      // A raw write bypasses the note:save pipeline — tell plugins directly.
      pluginHost.emitVaultChange({ kind: 'write', path: relativePath });
      return modifiedMs;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultSaveAsset,
    (_event, bytes: Uint8Array, ext: string, noteRelPath: string): Promise<string> =>
      vaultManager.saveAsset(bytes, ext, noteRelPath),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultSaveAssetFromUrl,
    (_event, url: string, noteRelPath: string): Promise<string> =>
      vaultManager.saveAssetFromUrl(url, noteRelPath),
  );
  ipcMain.handle(IPC_CHANNELS.vaultCreateFile, (_event, relativePath: string): Promise<string> =>
    vaultManager.createFile(relativePath),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultCreateDirectory,
    (_event, relativePath: string): Promise<string> => vaultManager.createDirectory(relativePath),
  );
  ipcMain.handle(IPC_CHANNELS.vaultDelete, async (_event, relativePath: string): Promise<void> => {
    await vaultManager.deleteEntry(relativePath);
    // No file watcher -- the tag / task indexes would otherwise still list
    // entries from the deleted file until the next full rebuild.
    await rebuildIndexes();
  });
  // Multi-select delete (bug-8): one round trip, one re-index for the whole
  // batch. Missing targets are not errors, so overlapping paths (a folder
  // and a file inside it) just work.
  ipcMain.handle(
    IPC_CHANNELS.vaultDeleteMany,
    async (_event, relativePaths: string[]): Promise<void> => {
      for (const relativePath of relativePaths) {
        await vaultManager.deleteEntry(relativePath);
      }
      await rebuildIndexes();
    },
  );
  // Rename / copy / duplicate can move `.md` content in or out of the
  // indexes' scope, so each rebuilds them (same reason as `vault:delete`).
  ipcMain.handle(
    IPC_CHANNELS.vaultRename,
    async (_event, fromRel: string, toRel: string): Promise<string> => {
      const next = await vaultManager.renameEntry(fromRel, toRel);
      await rebuildIndexes();
      pluginHost.emitVaultChange({ kind: 'rename', path: next });
      return next;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultCopy,
    async (_event, srcRel: string, destDirRel: string): Promise<string> => {
      const next = await vaultManager.copyEntry(srcRel, destDirRel);
      await rebuildIndexes();
      return next;
    },
  );
  ipcMain.handle(IPC_CHANNELS.vaultDuplicate, async (_event, srcRel: string): Promise<string> => {
    const next = await vaultManager.duplicateEntry(srcRel);
    await rebuildIndexes();
    return next;
  });
  ipcMain.handle(
    IPC_CHANNELS.vaultPickSavePath,
    (_event, suggestedName: string): Promise<string | null> =>
      vaultManager.pickSavePath(suggestedName),
  );
  ipcMain.handle(IPC_CHANNELS.dailyBuildContent, (_event, date: string): Promise<string> =>
    dailyNotes.noteContentFor(date),
  );
  ipcMain.handle(
    IPC_CHANNELS.noteSave,
    (_event, request: NoteSaveRequest): Promise<NoteSaveResult> => noteManager.saveNote(request),
  );
}
