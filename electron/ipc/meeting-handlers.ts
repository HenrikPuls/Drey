import { dialog, ipcMain } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { IPC_CHANNELS } from '../../shared/ipc-api';
import { MeetingImporter } from '../meeting';

export interface MeetingHandlerDeps {
  meetingImporter: MeetingImporter;
}

/**
 * Calendar-invite IPC (ADR-0041): `meeting:decode` takes a dropped file's
 * bytes; `meeting:import` opens a native picker for the "File → Import
 * meeting …" fallback. Both return the ready-to-insert Markdown section
 * and throw a user-facing message on a bad file.
 */
export function registerMeetingHandlers({ meetingImporter }: MeetingHandlerDeps): void {
  ipcMain.handle(
    IPC_CHANNELS.meetingDecode,
    (_event, bytes: Uint8Array, filename: string): Promise<string> =>
      meetingImporter.decode(bytes, filename),
  );

  ipcMain.handle(IPC_CHANNELS.meetingImport, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Import meeting',
      properties: ['openFile'],
      filters: [{ name: 'Calendar invite', extensions: ['ics', 'msg'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    const bytes = new Uint8Array(await fsp.readFile(filePath));
    return meetingImporter.decode(bytes, path.basename(filePath));
  });
}
