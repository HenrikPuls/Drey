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
}

/**
 * Vault filesystem IPC: the active vault, the file tree, read/write, asset
 * saves, create/delete/rename/copy/duplicate, the native save dialog, the
 * daily-note content builder, and `note:save`.
 *
 * There is no file watcher (ADR-0018): any op that can move `.md` content in
 * or out of the plugins' index scope emits a vault-change event, so the
 * plugins rebuild and the renderer sees a consistent picture on its next
 * refresh.
 */
export function registerVaultHandlers({
  vaultManager,
  dailyNotes,
  noteManager,
  pluginHost,
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
    return selected;
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
