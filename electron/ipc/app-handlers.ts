import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { AppInfo, EditCommand, IPC_CHANNELS } from '../../shared/ipc-api';
import { logFromRenderer, logLine } from '../logger';
import { localPathFromFileHref, openDocumentInDefaultProgram } from '../open-document';

/**
 * App-shell IPC: version info, the frameless-titlebar window controls
 * (ADR-0019), the HTML Edit menu's native editing commands, the app-wide
 * UI-scale zoom, `openExternal`, and the renderer -> log-file bridge.
 */
export function registerAppHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
  }));

  // Custom-titlebar window controls (the window is frameless, ADR-0019).
  ipcMain.handle(IPC_CHANNELS.windowMinimize, (): void => getMainWindow()?.minimize());
  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, (): void => {
    const win = getMainWindow();
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle(IPC_CHANNELS.windowClose, (): void => getMainWindow()?.close());
  ipcMain.handle(
    IPC_CHANNELS.windowIsMaximized,
    (): boolean => getMainWindow()?.isMaximized() ?? false,
  );
  // Fullscreen toggle (the renderer's F11 command / View-menu row).
  ipcMain.handle(IPC_CHANNELS.windowToggleFullScreen, (): void => {
    const win = getMainWindow();
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.windowIsFullScreen,
    (): boolean => getMainWindow()?.isFullScreen() ?? false,
  );

  // The HTML Edit menu (frameless titlebar, ADR-0019) drives the focused
  // editable element through the same native editing commands the
  // auto-hidden application menu already exposes via accelerators
  // (electron/menu.ts). CodeMirror honours the resulting DOM events, so this
  // needs nothing in the renderer beyond the menu click.
  ipcMain.handle(IPC_CHANNELS.editExec, (_event, command: EditCommand): void => {
    const wc = getMainWindow()?.webContents;
    if (!wc) {
      return;
    }
    ({
      undo: () => wc.undo(),
      redo: () => wc.redo(),
      cut: () => wc.cut(),
      copy: () => wc.copy(),
      paste: () => wc.paste(),
      selectAll: () => wc.selectAll(),
    })[command]?.();
  });

  // App-wide UI scale (Settings -> Appearance "Base font size"). Browser-zoom
  // the whole renderer -- resets on reload, so the renderer re-sends it from
  // config on startup.
  ipcMain.handle(IPC_CHANNELS.uiSetZoom, (_event, factor: number): void => {
    const wc = getMainWindow()?.webContents;
    if (wc && Number.isFinite(factor) && factor > 0) {
      wc.setZoomFactor(factor);
    }
  });

  // Ctrl/Cmd-click on a link in the editor. Same allowlist as the
  // `setWindowOpenHandler` guard -- only web + mail, everything else is a
  // no-op so a note can never drive `shell.openExternal` to e.g. `file:`.
  ipcMain.handle(IPC_CHANNELS.openExternal, (_event, url: unknown): void => {
    if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url.trim())) {
      void shell.openExternal(url.trim());
    }
  });

  // Ctrl/Cmd-click on a `file:` link (ADR-0066): the one exception to the
  // guard above, and a narrow one -- a document on this machine, by
  // extension allowlist, opened in its own program. Never an executable,
  // never a network share.
  ipcMain.handle(IPC_CHANNELS.openLocalDocument, async (_event, href: unknown): Promise<void> => {
    if (typeof href !== 'string') {
      throw new Error('This link is not a file link.');
    }
    await openDocumentInDefaultProgram(localPathFromFileHref(href));
  });

  // Renderer -> log file (`<userData>/logs/drey.log`). The packaged build
  // has no DevTools; this is how a field problem leaves a trace.
  ipcMain.handle(
    IPC_CHANNELS.appLog,
    (_event, entry: { level?: string; message?: string; context?: unknown }): void => {
      if (entry && typeof entry.message === 'string') {
        logFromRenderer(String(entry.level ?? 'info'), entry.message, entry.context);
      }
    },
  );
}
