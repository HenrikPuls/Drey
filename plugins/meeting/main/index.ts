import { dialog } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import { MeetingImporter } from './meeting-importer';

/**
 * The Meeting plugin's main entry (ADR-0041, converted in ADR-0044 stage 4):
 * two namespaced methods — `decode` (a dropped file's bytes) and `import`
 * (the native picker fallback for "File → Import meeting …") — plus the
 * ical.js / msgreader decoding, which lives in-process with full Node.
 */
const plugin: MainPluginModule = {
  activate(ctx: MainPluginContext) {
    const importer = new MeetingImporter(ctx.vault);

    ctx.ipc.handle('decode', (payload) => {
      // NOTE: a Uint8Array sent through the contextBridge can arrive as a
      // plain object with numeric keys (Electron serialisation), so accept
      // both shapes and coerce.
      const shape = (payload ?? {}) as { bytes?: unknown; filename?: unknown };
      const raw = shape.bytes;
      const bytes =
        raw instanceof Uint8Array
          ? raw
          : raw !== null && typeof raw === 'object'
            ? Uint8Array.from(Object.values(raw as Record<string, number>))
            : undefined;
      if (bytes === undefined || typeof shape.filename !== 'string') {
        throw new Error('malformed decode payload');
      }
      return importer.decode(bytes, shape.filename);
    });

    ctx.ipc.handle('import', async () => {
      const win = ctx.app.getMainWindow();
      const options = {
        title: 'Import meeting',
        properties: ['openFile' as const],
        filters: [{ name: 'Calendar invite', extensions: ['ics', 'msg'] }],
      };
      const result =
        win !== null ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const filePath = result.filePaths[0];
      const bytes = new Uint8Array(await fsp.readFile(filePath));
      return importer.decode(bytes, path.basename(filePath));
    });

    ctx.log('activated');
  },
};

export default plugin;
