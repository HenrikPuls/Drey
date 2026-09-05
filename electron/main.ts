import { app, BrowserWindow, globalShortcut, ipcMain, Menu, net, protocol } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppInfo, IPC_CHANNELS, VaultFileContent, VaultFileEntry } from '../shared/ipc-api';
import { DailyNoteManager } from './daily-note';
import { attachContextMenu, buildApplicationMenu } from './menu';
import { VaultManager } from './vault-manager';

/**
 * Global hotkey for quick-capture (milestone 4). One constant here until a
 * settings UI can rebind it (later milestone). `Ctrl/Cmd+Alt+N`: mnemonic
 * (N = note), and `Ctrl+Alt`+letter is rarely claimed as a system-wide
 * shortcut, so collision risk is low.
 *
 * It does not open a popup (the specs' original plan) -- per the project
 * owner's call it brings the main window forward and opens today's daily
 * note in the editor. See docs/09_architecture_decisions/0002-*.md.
 */
const CAPTURE_SHORTCUT = 'CommandOrControl+Alt+N';

/**
 * Set via the `dev` npm script (see package.json) to the Angular dev
 * server URL. When unset, we're running a production build and load the
 * built renderer straight from disk instead.
 */
const rendererDevServerUrl = process.env['DREY_RENDERER_URL'];

const rendererDistDir = path.join(__dirname, '../../dist/drey/browser');

/**
 * Production loads go through a custom `app://` scheme instead of plain
 * `file://`. Angular's esbuild output is `<script type="module">`, and
 * Chromium refuses to load module scripts (and their relative imports)
 * from `file://` as a CORS violation -- the page loads with silently zero
 * content. A privileged custom scheme behaves like a normal origin
 * instead. Registered before `app.whenReady()` because Electron requires
 * privileged schemes to be declared at module load time.
 *
 * This is also the same mechanism the roadmap earmarks for safe local
 * image rendering in Phase 3 (see specs/roadmap.md) -- one protocol
 * handler pattern, reused later for a second scheme/purpose.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.normalize(path.join(rendererDistDir, relativePath));

    // Guard against escaping rendererDistDir (defense in depth; nothing
    // in the app currently constructs one, but the handler is a public
    // surface for anything the renderer navigates to).
    if (!filePath.startsWith(rendererDistDir)) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function registerIpcHandlers(vaultManager: VaultManager, dailyNotes: DailyNoteManager): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
  }));

  ipcMain.handle(IPC_CHANNELS.vaultGetActive, (): string | null =>
    vaultManager.getActiveVaultPath(),
  );
  ipcMain.handle(IPC_CHANNELS.vaultSelect, (): Promise<string | null> =>
    vaultManager.selectVault(),
  );
  ipcMain.handle(IPC_CHANNELS.vaultListFiles, (): Promise<VaultFileEntry[]> =>
    vaultManager.listFiles(),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultReadFile,
    (_event, relativePath: string): Promise<VaultFileContent> =>
      vaultManager.readFile(relativePath),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultWriteFile,
    (_event, relativePath: string, content: string): Promise<number> =>
      vaultManager.writeFile(relativePath, content),
  );
  ipcMain.handle(IPC_CHANNELS.vaultCreateFile, (_event, relativePath: string): Promise<string> =>
    vaultManager.createFile(relativePath),
  );
  ipcMain.handle(
    IPC_CHANNELS.vaultCreateDirectory,
    (_event, relativePath: string): Promise<string> => vaultManager.createDirectory(relativePath),
  );
  ipcMain.handle(IPC_CHANNELS.dailyBuildContent, (_event, date: string): Promise<string> =>
    dailyNotes.noteContentFor(date),
  );
}

let mainWindow: BrowserWindow | null = null;

/**
 * Quick-capture hotkey handler: bring the main window forward and tell the
 * renderer to open today's daily note (created from `templates/daily.md`
 * if needed). The window is raised first so that even the failure case
 * (no vault selected) surfaces -- the sidebar already shows "no vault".
 */
async function openTodayDailyNote(dailyNotes: DailyNoteManager): Promise<void> {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();

  try {
    const relativePath = await dailyNotes.ensureTodayNote();
    mainWindow.webContents.send(IPC_CHANNELS.dailyOpen, relativePath);
  } catch (err) {
    // No vault active / vault folder gone. A renderer-side toast can come
    // later; for now the raised window + sidebar state is the feedback.
    console.warn(`Quick-capture: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    // Matches the dark theme default (see CLAUDE.md, UI/UX Design) so the
    // window doesn't flash white while the renderer loads.
    backgroundColor: '#1e1e1e',
    // Keep the menu bar out of the minimal layout (CLAUDE.md, UI/UX
    // Design) but still bound -- Alt reveals it, and its accelerators
    // (Ctrl+C/V/X, ...) stay active while hidden.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // NOT sandboxed: a sandboxed preload's require() is restricted to a
      // handful of built-ins and can't load our own shared/ipc-api.js
      // (see docs/09_architecture_decisions/0001-*.md) -- it silently
      // fails to run, leaving window.dreyApi undefined with no thrown
      // error surfaced to the renderer. contextIsolation + no Node
      // integration (the two properties the ADR actually commits to)
      // still fully apply; only the extra OS-level process sandbox is
      // deferred. Revisit once preload has a bundling step that can
      // inline shared/ into a single file with no runtime require().
      sandbox: false,
    },
  });

  attachContextMenu(window);
  mainWindow = window;

  window.on('closed', () => {
    mainWindow = null;
  });

  if (rendererDevServerUrl) {
    window.loadURL(rendererDevServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Host segment ("app") is an arbitrary placeholder -- the handler
    // below only looks at the path, not the host. Using a real host
    // instead of e.g. `app://index.html` keeps pathname unambiguous
    // (`/index.html`, not `/`) for this request and every relative
    // sub-resource request the page makes afterwards.
    window.loadURL('app://app/index.html');
  }

  return window;
}

// A second launch can't register the already-taken global shortcut and
// would leave the user with a dead hotkey and no visible error. Refuse
// it; focus the running window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const vaultManager = new VaultManager();
    const dailyNotes = new DailyNoteManager(vaultManager);

    registerAppProtocol();
    registerIpcHandlers(vaultManager, dailyNotes);
    Menu.setApplicationMenu(buildApplicationMenu());
    createMainWindow();

    const shortcutRegistered = globalShortcut.register(CAPTURE_SHORTCUT, () => {
      void openTodayDailyNote(dailyNotes);
    });
    if (!shortcutRegistered) {
      // Another app owns the combo. Non-fatal -- the rest of the app
      // works, and a later settings UI will let the user pick another.
      console.warn(
        `Quick-capture hotkey ${CAPTURE_SHORTCUT} could not be registered (already in use).`,
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
