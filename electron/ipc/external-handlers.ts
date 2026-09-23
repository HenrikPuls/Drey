import { ipcMain } from 'electron';
import { ExternalFileContent, IPC_CHANNELS, OpenRequest } from '../../shared/ipc-api';
import { ExternalFileGate } from '../external-open';

export interface ExternalHandlerDeps {
  externalFiles: ExternalFileGate;
}

/**
 * IPC for files the OS hands to Drey (ADR-0054): the cold-start pull of the
 * launch's files and the gated read / write of an out-of-vault one. The push for
 * later launches (`external:open-request`) is sent by the gate itself.
 */
export function registerExternalHandlers({ externalFiles }: ExternalHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.externalTakePending, (): OpenRequest[] => externalFiles.takePending());
  ipcMain.handle(
    IPC_CHANNELS.externalRead,
    (_e, absolutePath: string): Promise<ExternalFileContent> => externalFiles.read(absolutePath),
  );
  ipcMain.handle(
    IPC_CHANNELS.externalWrite,
    (_e, absolutePath: string, content: string): Promise<number> =>
      externalFiles.write(absolutePath, content),
  );
}
