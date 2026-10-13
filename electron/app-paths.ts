import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appIconStem, appIconVariant } from '../shared/app-icon';

/**
 * Where the main process finds the renderer and its own bundled files.
 * `__dirname` is `dist-electron/electron` for every file in this folder.
 */

/**
 * Set via the `dev` npm script (see package.json) to the Angular dev
 * server URL. When unset, we're running a production build and load the
 * built renderer straight from disk instead.
 */
export const rendererDevServerUrl = process.env['DREY_RENDERER_URL'];

export const rendererDistDir = path.join(__dirname, '../../dist/drey/browser');

/**
 * Origin of the main window's page: the dev server's, else the `app://app`
 * the production page loads from. Spelled out because Node's `URL` reports
 * the origin of a non-http scheme as "null".
 */
export const rendererOrigin = rendererDevServerUrl
  ? new URL(rendererDevServerUrl).origin
  : 'app://app';

/**
 * The BrowserWindow / taskbar icon. Packaged, it is an `extraResources`
 * copy under `process.resourcesPath`; in dev it is `build/icon.ico` at the
 * repo root. `.ico` is what Windows wants for a window icon.
 */
const windowIconDir = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', '..', 'build');
export const windowIconPath = path.join(windowIconDir, 'icon.ico');

/**
 * The icon that goes with a theme (req-42): a theme with its own mark gets
 * its own `.ico`, every other one -- and a missing file -- the default.
 * Null when not even the default exists (a checkout without `build/`).
 */
export function windowIconFor(themeId: string): string | null {
  const themed = path.join(windowIconDir, `${appIconStem(appIconVariant(themeId))}.ico`);
  if (fs.existsSync(themed)) {
    return themed;
  }
  return fs.existsSync(windowIconPath) ? windowIconPath : null;
}

/**
 * Absolute path to the MCP stdio bridge script an external client
 * (`node <path>`) runs. Packaged, `__dirname` is inside `app.asar` but the
 * script was `asarUnpack`'d, and a plain external Node does not redirect
 * `app.asar` -> `app.asar.unpacked` the way Electron does -- so point at
 * the real file. `$`-anchored so a path that merely contains "app.asar"
 * earlier is not corrupted.
 */
export function stdioBridgePath(): string {
  const rel = ['dist-electron', 'electron', 'mcp', 'stdio-bridge.js'];
  if (app.isPackaged) {
    return path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), ...rel);
  }
  return path.join(__dirname, 'mcp', 'stdio-bridge.js');
}
