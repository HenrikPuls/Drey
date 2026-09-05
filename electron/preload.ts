import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { DreyApi, IPC_CHANNELS, VaultFileContent, VaultFileEntry } from '../shared/ipc-api';

/**
 * The only thing the renderer ever gets: this typed object. No
 * `ipcRenderer` reference, no Node globals -- see
 * docs/09_architecture_decisions/0001-electron-process-split-contextbridge.md.
 */
const dreyApi: DreyApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getActiveVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultGetActive),
  selectVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultSelect),
  listVaultFiles: (): Promise<VaultFileEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.vaultListFiles),
  readVaultFile: (relativePath: string): Promise<VaultFileContent> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultReadFile, relativePath),
  writeVaultFile: (relativePath: string, content: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultWriteFile, relativePath, content),
  createVaultFile: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateFile, relativePath),
  createVaultDirectory: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateDirectory, relativePath),
  buildDailyNoteContent: (date: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.dailyBuildContent, date),
  onOpenDailyNote: (listener: (relativePath: string) => void): (() => void) => {
    // The wrapper drops the IpcRendererEvent and forwards only the path --
    // the renderer must never get a handle to the event or to ipcRenderer
    // (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, relativePath: string): void =>
      listener(relativePath);
    ipcRenderer.on(IPC_CHANNELS.dailyOpen, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dailyOpen, wrapped);
  },
};

contextBridge.exposeInMainWorld('dreyApi', dreyApi);
