import { ipcMain } from 'electron';
import { IPC_CHANNELS, NoteHistoryEntry } from '../../shared/ipc-api';
import { NoteHistoryStore } from '../history/note-history-store';
import { SessionBackupStore } from '../session';
import { VaultManager } from '../vault-manager';

export interface SessionHandlerDeps {
  sessionBackups: SessionBackupStore;
  noteHistory: NoteHistoryStore;
  vaultManager: VaultManager;
}

/**
 * Session-history backup store IPC (ADR-0043). The layout / open-tab list
 * is persisted renderer-side in `localStorage`; these channels only carry
 * the buffer text that has no file on disk to reload from.
 */
export function registerSessionHandlers({
  sessionBackups,
  noteHistory,
  vaultManager,
}: SessionHandlerDeps): void {
  // Local note history (ADR-0060) -- the read side and the one renderer
  // write: text that exists only in a tab.
  ipcMain.handle(
    IPC_CHANNELS.historyList,
    (_e, relativePath: string, vaultId?: string): Promise<NoteHistoryEntry[]> =>
      noteHistory.list(vaultManager.resolveVaultId(vaultId), relativePath),
  );
  ipcMain.handle(
    IPC_CHANNELS.historyRead,
    (_e, relativePath: string, entryId: string, vaultId?: string): Promise<string | null> =>
      noteHistory.read(vaultManager.resolveVaultId(vaultId), relativePath, entryId),
  );
  ipcMain.handle(
    IPC_CHANNELS.historyCapture,
    (_e, relativePath: string, content: string, origin: string, vaultId?: string): Promise<boolean> =>
      noteHistory.capture(vaultManager.resolveVaultId(vaultId), relativePath, content, origin),
  );

  ipcMain.handle(
    IPC_CHANNELS.sessionWriteBackup,
    (_e, id: string, content: string): Promise<void> => sessionBackups.write(id, content),
  );
  ipcMain.handle(
    IPC_CHANNELS.sessionReadBackup,
    (_e, id: string): Promise<string | null> => sessionBackups.read(id),
  );
  ipcMain.handle(
    IPC_CHANNELS.sessionListBackups,
    (): Promise<string[]> => sessionBackups.list(),
  );
  ipcMain.handle(
    IPC_CHANNELS.sessionDeleteBackups,
    (_e, ids: string[]): Promise<void> => sessionBackups.delete(ids),
  );
}
