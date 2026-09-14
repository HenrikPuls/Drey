import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS, PdfExportRequest } from '../../shared/ipc-api';
import { exportNoteToPdf } from '../pdf-export';
import { VaultManager } from '../vault-manager';

/**
 * Note-export IPC: the "Export as PDF…" flow shared by the editor `⋯`
 * menu, the tab context menu and the Files panel row. Dialog parenting and
 * vault resolution live in `electron/pdf-export.ts`; this is the bridge.
 */
export function registerExportHandlers(
  getMainWindow: () => BrowserWindow | null,
  vaultManager: VaultManager,
): void {
  ipcMain.handle(
    IPC_CHANNELS.exportNotePdf,
    (_event, request: PdfExportRequest): Promise<string | null> =>
      exportNoteToPdf({ vaultManager, getParentWindow: getMainWindow }, request),
  );
}
