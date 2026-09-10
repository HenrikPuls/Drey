import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-api';
import { SessionBackupStore } from '../session';

export interface SessionHandlerDeps {
  sessionBackups: SessionBackupStore;
}

/**
 * Session-history backup store IPC (ADR-0043). The layout / open-tab list
 * is persisted renderer-side in `localStorage`; these channels only carry
 * the buffer text that has no file on disk to reload from.
 */
export function registerSessionHandlers({ sessionBackups }: SessionHandlerDeps): void {
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
