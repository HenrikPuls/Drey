import { contextBridge, ipcRenderer } from 'electron';
import { CyberNotesApi, IPC_CHANNELS, VaultFileEntry } from '../shared/ipc-api';

/**
 * The only thing the renderer ever gets: this typed object. No
 * `ipcRenderer` reference, no Node globals -- see
 * docs/09_architecture_decisions/0001-electron-process-split-contextbridge.md.
 */
const cyberNotesApi: CyberNotesApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getActiveVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultGetActive),
  selectVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultSelect),
  listVaultFiles: (): Promise<VaultFileEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.vaultListFiles),
};

contextBridge.exposeInMainWorld('cyberNotesApi', cyberNotesApi);
