import { ipcMain } from 'electron';
import { IPC_CHANNELS, type UpdateStatus } from '../../shared/ipc-api';
import type { UpdateService } from '../updater/update-service';

/**
 * Update-system IPC (milestone 82, ADR-0074): thin handlers over
 * `UpdateService` — the flow, its dialogs and their state live there.
 */
export interface UpdateHandlerDeps {
  readonly updateService: UpdateService;
  readonly getMainWindow: () => Electron.BrowserWindow | null;
}

export function registerUpdateHandlers(deps: UpdateHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.updateGetStatus, (): UpdateStatus => deps.updateService.status());

  // The manual check's result dialogs are shown by the service (main);
  // the renderer gets the status it ended on.
  ipcMain.handle(IPC_CHANNELS.updateCheck, (): Promise<UpdateStatus> =>
    deps.updateService.checkManually(),
  );
  ipcMain.handle(IPC_CHANNELS.updateDownload, (): Promise<UpdateStatus> =>
    deps.updateService.download(),
  );
  // Fire-and-forget: closing the window tears this renderer down mid-call.
  ipcMain.handle(IPC_CHANNELS.updateInstall, (): void => {
    deps.updateService.install();
  });
  ipcMain.handle(IPC_CHANNELS.updateOpenReleases, (): void => {
    deps.updateService.openReleasesPage();
  });

  // Status push, same shape as the other main -> renderer events.
  deps.updateService.onStatus((status) => {
    const window = deps.getMainWindow();
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.updateStatusChanged, status);
    }
  });
}
