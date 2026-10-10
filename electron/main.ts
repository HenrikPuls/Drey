import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC_CHANNELS, type StartupProgressReport } from '../shared/ipc-api';
import { UI_SCALE_FACTORS } from '../shared/app-config';
import { AppConfigStore } from './app-config';
import chokidar from 'chokidar';
import { DailyNoteManager } from './daily-note';
import { ExternalFileGate, extractOpenPaths } from './external-open';
import { installMainProcessLogging, logLine, watchWebContents } from './logger';
import { LlmDebugLog, LlmRouter, LlmTaskRegistry, TagSuggester, buildClients } from './llm';
import { registerIpcHandlers, ExitBridge, McpWriteBridge, ToolApprovalBridge } from './ipc';
import { McpHttpTransport, VaultTools, createVaultMcpServer } from './mcp';
import { AssistantToolbox, McpClientManager, createMcpClientManager } from './mcp-client';
import { attachContextMenu, buildApplicationMenu } from './menu';
import { NoteManager } from './note-manager';
import { OwnWriteLedger } from './own-write-ledger';
import { isHashedAsset, serveWithCaching } from './protocol-cache';
import { PluginHost } from './plugin-host';
import { SessionBackupStore } from './session';
import { SpellcheckService } from './spellcheck';
import { SplashController } from './splash';
import { startupMark } from './startup-timing';
import { VaultChangeAnnouncer } from './vault-change-announcer';
import { NoteHistoryStore } from './history/note-history-store';
import { VaultManager } from './vault-manager';
import { VaultWatcher } from './vault-watcher';

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
      // V8 code cache opt-in (milestone 61). Measured effect on the dev
      // machine: none (Chromium currently keeps custom-scheme responses
      // out of its caches no matter the headers) — kept as the
      // documented switch for the day that changes.
      codeCache: true,
    },
  },
  // Serves images referenced from notes (`![](relative/path.png)`) straight
  // from inside a registered vault. `standard` so
  // `drey-asset://<vaultId>/asset/<path>` parses with host = vault id and a
  // normal pathname; `secure` so an `<img>` on the privileged `app://` page
  // is allowed to load it.
  {
    scheme: 'drey-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // Serves built renderer modules for plugins (ADR-0044):
  // `plugin://<pluginId>/<path under the plugin's renderer/ dir>`. `standard`
  // so the URL parses with host = plugin id (ids are lowercase by the id
  // pattern); `corsEnabled` because an ES-module import from the `app://`
  // page is a CORS-mode fetch, and the handler answers with explicit
  // Content-Type / Access-Control-Allow-Origin headers.
  {
    scheme: 'plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      // Same V8 code cache opt-in and caveat as `app` (milestone 61).
      codeCache: true,
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

    // Cache headers (milestone 61): hashed bundle files are immutable,
    // everything else (index.html, public/ assets) revalidates via ETag.
    return serveWithCaching(request, filePath, { immutable: isHashedAsset(relativePath) });
  });
}

/**
 * `drey-asset://<vaultId>/asset/<url-encoded vault-relative path>` -> the
 * file inside that vault (ADR-0051; the vaultId is the URL host, so the
 * same relative path can resolve differently per vault).
 * `VaultManager.resolveAssetPath` applies the same escape guard as the IPC
 * read path; anything it rejects (unknown vault, `..`, absolute) is a
 * plain 404. The renderer only ever builds these URLs from
 * `resolveVaultImageUrl`, which already normalises the path.
 */
function registerAssetProtocol(vaultManager: VaultManager): void {
  protocol.handle('drey-asset', (request) => {
    const url = new URL(request.url);
    // host = the vault id; `/asset/<path>` = the vault-relative path.
    const vaultId = decodeURIComponent(url.hostname);
    const relativePath = decodeURIComponent(url.pathname)
      .replace(/^\/asset\/?/, '')
      .replace(/^\/+/, '');
    const filePath = vaultManager.resolveAssetPath(relativePath, vaultId || undefined);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString()).then((response) => {
      // A PDF must arrive with an exact `application/pdf` Content-Type or
      // the built-in viewer refuses the frame (ADR-0052); the file://
      // loader's MIME guessing is registry-dependent on Windows, so it is
      // pinned here. Everything else keeps the sniffed headers (images
      // have worked through this channel since ADR-0024).
      if (!filePath.toLowerCase().endsWith('.pdf')) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'application/pdf');
      return new Response(response.body, { status: response.status, headers });
    });
  });
}

let mainWindow: BrowserWindow | null = null;

/** Module-scope handle so `createMainWindow` / `will-quit` can reach the host. */
let pluginHost: PluginHost | null = null;

/**
 * `plugin://<pluginId>/<path under the plugin root>` -> that file
 * (built-ins: `<dist-electron>/plugins/<id>`; user-installed:
 * `<userData>/plugins/<id>`). The path is root-relative exactly like the
 * manifest's `renderer` / `css` entries, so `plugin://<id>/renderer/index.js`
 * serves `<root>/renderer/index.js`.
 *
 * Unlike the `app://` handler's `startsWith` guard, the escape check here
 * is `path.relative`-based: it also rejects a target on another drive /
 * a sibling prefix (e.g. a root of `C:\x\plugins` vs `C:\x\plugins-evil`),
 * which `startsWith` lets through. Module fetches are CORS-mode, so the
 * response carries explicit `Content-Type` (Chromium refuses a module
 * without a JS MIME type) and a permissive `Access-Control-Allow-Origin`.
 */
function registerPluginProtocol(): void {
  const MIME_BY_EXT: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  protocol.handle('plugin', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const pluginId = url.hostname;
    const rootDir = pluginHost?.rendererRootFor(pluginId) ?? null;
    if (rootDir === null) {
      return new Response('Not found', { status: 404 });
    }
    const relativePath = decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(rootDir, relativePath));
    // `path.relative(rootDir, filePath)` is `..`-prefixed (or empty->same
    // file) exactly when the join escaped the plugin root.
    if (path.relative(rootDir, filePath).startsWith('..')) {
      return new Response('Forbidden', { status: 403 });
    }
    const ext = path.extname(filePath).toLowerCase();
    // ETag revalidation, never immutable (milestone 61): an app update
    // rewrites plugin files under stable names, so every launch
    // revalidates and only unchanged files answer 304 — the cached
    // scripts (and V8's bytecode for them) survive, changed ones reload.
    return serveWithCaching(request, filePath, {
      immutable: false,
      contentType: MIME_BY_EXT[ext],
    });
  });
}

/**
 * The BrowserWindow / taskbar icon. Packaged, it is an `extraResources`
 * copy under `process.resourcesPath`; in dev it is `build/icon.ico` at the
 * repo root (`__dirname` is `dist-electron/electron`). `.ico` is what
 * Windows wants for a window icon.
 */
const windowIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '..', '..', 'build', 'icon.ico');

/**
 * Absolute path to the MCP stdio bridge script an external client
 * (`node <path>`) runs. Packaged, `__dirname` is inside `app.asar` but the
 * script was `asarUnpack`'d, and a plain external Node does not redirect
 * `app.asar` -> `app.asar.unpacked` the way Electron does -- so point at
 * the real file. `$`-anchored so a path that merely contains "app.asar"
 * earlier is not corrupted.
 */
function stdioBridgePath(): string {
  const rel = ['dist-electron', 'electron', 'mcp', 'stdio-bridge.js'];
  if (app.isPackaged) {
    return path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), ...rel);
  }
  return path.join(__dirname, 'mcp', 'stdio-bridge.js');
}

/** Module-scope handle so the `will-quit` listener can close the socket. */
let mcpHttpForShutdown: McpHttpTransport | null = null;
let mcpClientsForShutdown: McpClientManager | null = null;

/** Module-scope handle so the `will-quit` listener can stop the watcher. */
let vaultWatcherForShutdown: VaultWatcher | null = null;

/** Module-scope handle so the `will-quit` listener can drop the splash. */
let splashForShutdown: SplashController | null = null;

/**
 * The main<->renderer bridge for confirming an MCP `vault_write` (ADR-0011 /
 * ADR-0021). Backs both the `VaultTools` confirmation callback and the
 * `mcp:write-decision` IPC handler.
 */
const mcpWriteBridge = new McpWriteBridge(() => mainWindow);
/** The same pattern for one external tool call's approval (ADR-0063). */
const toolApprovalBridge = new ToolApprovalBridge(() => mainWindow);

/**
 * The main<->renderer bridge for the save-before-exit prompt (bug-5). The
 * renderer owns the dirty-document registry, so a close just asks it.
 */
const exitBridge = new ExitBridge(() => mainWindow);

/**
 * Files the OS hands to Drey (Explorer "Open with" / a default-program
 * association, ADR-0054). Module-level because a `second-instance` can fire
 * before `whenReady` has built the vault manager -- the gate queues until
 * the renderer pulls, and reads the registry lazily at classification time.
 */
let vaultManagerForGate: VaultManager | null = null;
const externalFiles = new ExternalFileGate(
  () => vaultManagerForGate?.listVaults() ?? [],
  (requests) => mainWindow?.webContents.send(IPC_CHANNELS.externalOpenRequest, requests),
);

/**
 * Exit-prompt state machine (bug-5):
 * - `exitApproved` -- the renderer answered "save"/"exit without saving";
 *   the next `close` event is the real one and passes.
 * - `quitIntent` -- a quit was requested at app level (Cmd+Q, taskbar Quit)
 *   and routed through the prompt; `app.quit()` is called after the window
 *   actually closes. Reset when the user cancels (and when a fresh window
 *   opens, so a later close always prompts).
 */
let exitApproved = false;
let quitIntent = false;

/** Starts / stops the localhost MCP HTTP endpoint to match the current config. */
async function syncMcpHttpTransport(
  transport: McpHttpTransport,
  appConfig: AppConfigStore,
): Promise<void> {
  const { enabled, httpEnabled, httpPort } = appConfig.get().mcp;
  try {
    if (enabled && httpEnabled) {
      await transport.start(httpPort);
    } else {
      await transport.stop();
    }
  } catch (err) {
    console.warn(
      `MCP HTTP endpoint on 127.0.0.1:${httpPort} could not start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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

function createMainWindow(
  getUiScaleFactor?: () => number,
  opts: { hiddenUntilReady?: boolean } = {},
): BrowserWindow {
  // A fresh window is a fresh session: the next close prompts again.
  quitIntent = false;
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    // Milestone 62 (ADR-0062): the boot window stays hidden until the
    // renderer reports the workspace ready — the splash covers the parse
    // and the handover shows a painted app. Later windows (macOS
    // reopen) show immediately as before.
    show: opts.hiddenUntilReady !== true,
    // The frameless window draws no title bar, but this still sets the
    // taskbar / Alt-Tab icon (dev too, where there is no exe icon to
    // inherit).
    ...(fs.existsSync(windowIconPath) ? { icon: windowIconPath } : {}),
    // Matches the dark theme default (see CLAUDE.md, UI/UX Design) so the
    // window doesn't flash white while the renderer loads.
    backgroundColor: '#1b1a19',
    // Frameless: the renderer draws its own titlebar (accent square, the
    // File/Edit/Selection/View menu bar and the window controls) --
    // "VS Code style", ADR-0019. macOS keeps its traffic lights inset over
    // that bar; every other platform gets renderer-drawn buttons.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Still bound so Alt reveals the (macOS-only) native menu and its
    // accelerators stay live where one exists.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The app ships its own spellchecker (nspell + CodeMirror
      // decorations, ADR-0013) and it is meant to be the only one.
      // Chromium's native checker would otherwise also underline every
      // <input>/<textarea> in its own default language (en-US on Windows,
      // never the configured one), with corrections reachable only through
      // a context menu we don't build -- exactly the "wrong language, no
      // way to fix a word" behaviour we're removing. Off, so spellcheck
      // looks and behaves identically everywhere.
      spellcheck: false,
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
      // Chromium's built-in (PDFium) PDF viewer -- the only thing this
      // flag enables on modern Electron -- so PDF embeds
      // (`![](attachments/x.pdf)`, ADR-0052) and PDF tabs render inside
      // iframes instead of downloading or showing a blank frame.
      plugins: true,
    },
  });

  attachContextMenu(window);
  // Renderer-process failures -> the log file (ADR-0032).
  watchWebContents(window.webContents);

  // Belt-and-braces for the renderer's window-level drag/drop guard
  // (ADR-0027): a stray file / link drop must never navigate the window
  // away from the SPA, and an http(s) link opens in the OS browser.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = rendererDevServerUrl
      ? url.startsWith(rendererDevServerUrl)
      : url.startsWith('app://');
    if (!allowed) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Keep the renderer titlebar's maximize/restore glyph in sync with the
  // real window state.
  const emitMaximizeState = (): void => {
    window.webContents.send(IPC_CHANNELS.windowMaximizeChanged, window.isMaximized());
  };
  window.on('maximize', emitMaximizeState);
  window.on('unmaximize', emitMaximizeState);
  // Same sync for fullscreen (the View menu's "Full screen" check mark) --
  // also covers an F11 pressed outside the renderer's keybindings.
  const emitFullScreenState = (): void => {
    window.webContents.send(IPC_CHANNELS.windowFullScreenChanged, window.isFullScreen());
  };
  window.on('enter-full-screen', emitFullScreenState);
  window.on('leave-full-screen', emitFullScreenState);
  // The app is not a zoomable web page: Ctrl +/-/0 scales the editor
  // content in the renderer (ADR-0015), and the touchpad pinch gesture
  // must not zoom the whole window. Ctrl+wheel is suppressed renderer-side
  // (EditorZoomService).
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {
    // Older Electron rejects this off the main frame; harmless.
  });

  // Re-apply the app-wide "Base font size" (Settings -> Appearance) after
  // every load. `webContents.setZoomFactor` is reset by Chromium on each
  // navigation, and the renderer's own one-shot call on first config load
  // races the initial commit and is dropped -- so on a cold start the UI
  // opened unscaled even though the setting was stored. This is the
  // authoritative re-apply (ADR-0020).
  if (getUiScaleFactor) {
    window.webContents.on('did-finish-load', () => {
      const factor = getUiScaleFactor();
      if (Number.isFinite(factor) && factor > 0) {
        window.webContents.setZoomFactor(factor);
      }
    });
  }
  mainWindow = window;
  // Plugins activated before the window existed; deliver it to the ones
  // that subscribed via `ctx.app.onMainWindowCreated`.
  pluginHost?.notifyMainWindowCreated(window);

  // Save-before-exit prompt (bug-5). Every close path -- the titlebar X
  // (window:close IPC), Alt+F4, the taskbar, a macOS role close -- ends up
  // here, so this is the one interception point: hold the window, ask the
  // renderer (which owns the dirty-document registry), and only let the
  // close through once it answers "save" or "exit without saving".
  window.on('close', (event) => {
    if (exitApproved) {
      return; // the deliberate second close() after the prompt
    }
    event.preventDefault();
    if (exitBridge.hasPending()) {
      return; // a second X while the dialog is up -- keep waiting
    }
    void exitBridge.requestDecision().then((decision) => {
      if (decision === 'cancel') {
        quitIntent = false;
        return;
      }
      exitApproved = true;
      window.close();
      // Non-darwin quits by itself via window-all-closed; on macOS closing
      // the window is not quitting -- finish an app-level quit explicitly.
      if (quitIntent) {
        app.quit();
      }
    });
  });

  window.on('closed', () => {
    mainWindow = null;
    // A fresh window (macOS reopen) prompts again.
    exitApproved = false;
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

// A second launch would leave the user with a dead quick-capture hotkey
// (the registration below degrades to a warning) and no window. Refuse
// it; focus the running window instead. `DREY_MULTI_INSTANCE=1` (set by
// `dev.ps1 -Multi`) is the dev escape hatch: parallel checkouts run side
// by side sharing this userData's settings -- the lock holder keeps the
// hotkey and the Explorer file-open pushes.
const allowMultiInstance = process.env['DREY_MULTI_INSTANCE'] === '1';
if (!app.requestSingleInstanceLock() && !allowMultiInstance) {
  app.quit();
} else {
  installMainProcessLogging();
  // The launch's own files (`drey.exe notes.md`, an Explorer double-click on
  // a cold start); the renderer pulls them once it has finished starting.
  externalFiles.enqueue(
    extractOpenPaths(process.argv, { isPackaged: app.isPackaged, cwd: process.cwd() }),
  );
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // A double-click while Drey runs: same window, the file arrives as a push.
    externalFiles.enqueue(
      extractOpenPaths(argv, { isPackaged: app.isPackaged, cwd: workingDirectory }),
    );
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    startupMark('Electron app ready');

    // The startup splash (milestone 62, ADR-0062): shown before anything
    // heavy, closed at the handover below. Every later stage — main's and
    // the renderer's — feeds its bar + activity line.
    const splash = new SplashController({
      rendererDistDir,
      // `|| null`: an EMPTY DREY_RENDERER_URL (the e2e fixtures force it)
      // must take the packaged `app://` path, not a relative dev URL.
      rendererDevServerUrl: rendererDevServerUrl || null,
      iconPath: fs.existsSync(windowIconPath) ? windowIconPath : null,
    });
    splashForShutdown = splash;
    splash.create();
    splash.progress('Starting…', 3, app.getVersion());

    /**
     * The hidden-until-ready handover: show the main window, then close
     * the splash a beat later (the brief overlap hides the swap). One-
     * shot; the fail-open timers below reach it too, so a splash can
     * never trap the app behind a ready signal that never comes.
     */
    let splashHandoverDone = false;
    let absoluteSplashFailOpen: NodeJS.Timeout | undefined;
    let loadSplashFailOpen: NodeJS.Timeout | undefined;
    const splashHandover = (): void => {
      if (splashHandoverDone) {
        return;
      }
      splashHandoverDone = true;
      clearTimeout(absoluteSplashFailOpen);
      clearTimeout(loadSplashFailOpen);
      mainWindow?.show();
      setTimeout(() => splash.close(), 120);
      startupMark('workspace ready — main window shown, splash closing');
    };
    // Fail-open 1: nothing (not even the main window's page) loaded in
    // 30 s — show whatever there is and drop the splash.
    absoluteSplashFailOpen = setTimeout(() => {
      if (!splashHandoverDone) {
        logLine('[startup] splash fail-open: 30 s absolute timer fired');
      }
      splashHandover();
    }, 30_000);
    // Renderer-fed stages while the splash is up (fire-and-forget sends).
    ipcMain.on(IPC_CHANNELS.startupProgress, (_event, report: StartupProgressReport) => {
      if (splashHandoverDone || report === null || typeof report !== 'object') {
        return;
      }
      if (typeof report.label === 'string' && typeof report.pct === 'number') {
        splash.progress(report.label, report.pct);
      }
    });
    ipcMain.on(IPC_CHANNELS.startupReady, () => splashHandover());

    // The own-write ledger records every mutating vault-manager call so the
    // watcher can drop the app's own echoes (ADR-0045). Must exist before
    // the manager; the announcer closes over module state lazily, so
    // construction order stays free.
    const ownWrites = new OwnWriteLedger();
    const appConfig = new AppConfigStore();
    // Local note history (ADR-0060): earlier versions under the user-data
    // dir, fed by every vault write. Expired versions go once per start.
    const noteHistory = new NoteHistoryStore(
      path.join(app.getPath('userData'), 'history'),
      () => appConfig.get().vault.history,
    );
    void noteHistory.sweep();
    const vaultManager = new VaultManager(ownWrites, noteHistory);
    vaultManagerForGate = vaultManager;
    const vaultAnnouncer = new VaultChangeAnnouncer(
      () => pluginHost,
      () => mainWindow,
    );
    const vaultWatcher = new VaultWatcher({
      getRoot: () => vaultManager.getActiveVaultPath(),
      getVaultId: () => vaultManager.getActiveVaultId(),
      isEnabled: () => appConfig.get().vault.watch,
      ledger: ownWrites,
      announcer: vaultAnnouncer,
      watchFactory: (root) =>
        chokidar.watch(root, {
          // The initial scan must not announce every existing file as a
          // change; the `ready` gate covers anything that slips through.
          ignoreInitial: true,
          // Same dot-entries the file tree and the indexes exclude
          // (.git, .obsidian, .drafts/, .<name>.chat.json sidecars).
          ignored: /(^|[\\/])\./,
          // OneDrive & friends deliver files in flux; wait for the write
          // to settle so indexes never see half a file.
          awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        }),
      log: (message, level) => {
        if (level === 'error') {
          console.error(message);
        } else if (level === 'warn') {
          console.warn(message);
        } else {
          console.log(message);
        }
      },
    });
    vaultWatcherForShutdown = vaultWatcher;
    const dailyNotes = new DailyNoteManager(vaultManager, appConfig);
    const llmDebug = new LlmDebugLog();
    // The provider router (ADR-0047): one client per implemented backend,
    // picked per call from `llm.provider` -- switching in Settings applies
    // on the next request, no restart.
    const llm = new LlmRouter(appConfig, buildClients(appConfig, llmDebug));
    const llmTasks = new LlmTaskRegistry();
    // The vault tool set (ADR-0021): one instance backs both the MCP
    // server and the assistant's in-process tool-calling loop.
    const vaultTools = new VaultTools(
      vaultManager,
      // The section-search seam (ADR-0044): reads whichever provider a
      // plugin registered (the Tags plugin). The closure reads the module
      // variable lazily, so construction order stays free.
      () => pluginHost?.getSectionSearchProvider() ?? null,
      // The task-index seam (SDK 1.11): reads the tasks plugin's provider.
      () => pluginHost?.getTaskQueryProvider() ?? null,
      () => appConfig.get(),
      (request) => mcpWriteBridge.requestConfirmation(request),
      // An MCP write bypasses note:save -- run the same external-change
      // round the watcher uses (index events + renderer push, scoped to
      // the written file and its vault).
      (writtenPath, writtenVaultId) =>
        vaultAnnouncer.announceExternal({
          vaultId: writtenVaultId ?? vaultManager.resolveVaultId(),
          changedPaths: [writtenPath],
          deletedPaths: [],
        }),
    );
    // The assistant's external tools (ADR-0063): the configured MCP
    // servers plus the built-in web_fetch, each behind its approval rule.
    // Connecting is fire-and-forget -- a slow or broken server never
    // delays the start.
    const mcpClients = createMcpClientManager(app.getVersion(), (message, level) =>
      level === 'warn' || level === 'error' ? console.warn(message) : console.log(message),
    );
    mcpClientsForShutdown = mcpClients;
    const assistantToolbox = new AssistantToolbox(
      () => appConfig.get(),
      mcpClients,
      (request) => toolApprovalBridge.request(request),
    );
    const tagSuggester = new TagSuggester(appConfig, llm, llmTasks);
    // The plugin host registers its method handlers during activate().
    // Since milestone 61 discovery+activation STARTS before the window is
    // created and runs while the renderer parses its bundle — every IPC
    // handler that exposes plugin-owned state awaits `activationDone()`,
    // so the renderer can never observe a half-activated host.
    pluginHost = new PluginHost({
      // `__dirname` is `dist-electron/electron`, so the built-ins the plugin
      // build script emits live one level up.
      builtinRoot: path.join(__dirname, '..', 'plugins'),
      userRoot: path.join(app.getPath('userData'), 'plugins'),
      extraRoot: process.env['DREY_EXTRA_PLUGIN_DIR'] ?? null,
      getMainWindow: () => mainWindow,
      vaultManager,
      appConfig,
      llm,
      llmTasks,
      vaultTools,
      assistantToolbox,
      confirmWrite: (request) => mcpWriteBridge.requestConfirmation(request),
      tagSuggester,
      llmDebug,
      // Plugin vault writes that must be visible immediately (chat notes)
      // run the same external-change round as an MCP write.
      vaultAnnouncer: () => vaultAnnouncer,
      onPluginActivated: ({ id, name, ok, ms, index, total }) => {
        logLine(
          `[startup] plugin "${id}" ${ok ? 'activated' : 'FAILED'} in ${Math.round(ms)}ms`,
        );
        // The splash band for plugin activation (milestone 62): 15–60 %,
        // one step per main entry, named for the user.
        splash.progress(`Loading plugin ${name}`, 15 + (45 * index) / total);
      },
      log: (message, level) => {
        if (level === 'error') {
          console.error(message);
        } else if (level === 'warn') {
          console.warn(message);
        } else {
          console.log(message);
        }
      },
    });
    const pluginHostRef = pluginHost;
    const noteManager = new NoteManager(vaultManager, {
      onNoteSaved: (hook) => pluginHostRef.save.onNoteSaved(hook),
      emitNoteSaved: (event) => pluginHostRef.emitNoteSaved(event),
    });
    const spellcheck = new SpellcheckService(appConfig);
    const mcpHttp = new McpHttpTransport(() =>
      createVaultMcpServer(vaultTools, app.getVersion()),
    );
    mcpHttpForShutdown = mcpHttp;
    const sessionBackups = new SessionBackupStore();
    startupMark('base services + plugin host constructed');
    splash.progress('Loading settings', 10);

    // Push each new debug entry to the renderer so the LLM settings pane
    // updates live while a request is in flight.
    llmDebug.onEntry((entry) => {
      mainWindow?.webContents.send(IPC_CHANNELS.llmDebugEntry, entry);
    });

    // Push the active provider's capabilities after every config write -- a
    // provider switch changes them, and plugins cache them for
    // synchronously-readable UI gating (the ocr plugin's menu row).
    appConfig.onChange(() => {
      try {
        mainWindow?.webContents.send(IPC_CHANNELS.llmCapabilitiesChanged, llm.capabilities());
      } catch {
        // Unrouted provider id -- capabilities are meaningless until the
        // config is fixed; the next successful write re-pushes.
      }
    });

    registerAppProtocol();
    registerAssetProtocol(vaultManager);
    registerPluginProtocol();
    registerIpcHandlers({
      getMainWindow: () => mainWindow,
      sessionBackups,
      noteHistory,
      vaultManager,
      dailyNotes,
      noteManager,
      appConfig,
      llm,
      llmTasks,
      tagSuggester,
      llmDebug,
      spellcheck,
      mcpHttp,
      mcpWriteBridge,
      mcpClients,
      toolApprovalBridge,
      syncMcpClients: () => mcpClients.sync(appConfig.get().tools.servers),
      exitBridge,
      externalFiles,
      stdioBridgePath,
      syncMcpHttp: () => syncMcpHttpTransport(mcpHttp, appConfig),
      syncVaultWatcher: () => vaultWatcher.syncFromConfig(),
      fullVaultRefresh: () => vaultAnnouncer.announceFullRefresh(),
      pluginHost,
    });
    // The File/Edit/Selection/View menus are drawn by the renderer titlebar
    // now (ADR-0019). Keep a native menu only on macOS, where the menu bar
    // belongs to the system and its accelerators are expected there.
    Menu.setApplicationMenu(process.platform === 'darwin' ? buildApplicationMenu() : null);
    const uiScaleFactor = (): number => UI_SCALE_FACTORS[appConfig.get().appearance.uiScale];
    startupMark('protocols + IPC registered');

    // Window-first startup (milestone 61): the discovery+activation round
    // starts here and runs while the window below loads the renderer —
    // the renderer's JS parse used to wait for it serially. The gated
    // handlers make the overlap safe; `discoverAndActivate()` assigns its
    // completion promise synchronously, before the window exists.
    // Since milestone 62 the window is HIDDEN until the renderer reports
    // ready (ADR-0062): the user sees the splash instead of a blank dark
    // frame during the parse.
    const activation = pluginHostRef.discoverAndActivate();
    const bootWindow = createMainWindow(uiScaleFactor, { hiddenUntilReady: true });
    splash.progress('Starting the interface', 68);
    startupMark('main window created (plugin activation running)');

    // Fail-open 2: the page loaded but "ready" never arrived within 15 s
    // (a crashed or wedged renderer must not leave the splash up).
    bootWindow.webContents.once('did-finish-load', () => {
      loadSplashFailOpen = setTimeout(() => {
        if (!splashHandoverDone) {
          logLine('[startup] splash fail-open: ready signal missing 15 s after page load');
        }
        splashHandover();
      }, 15_000);
    });
    // A renderer that died shows whatever there is and drops the splash;
    // a closed main window takes the splash with it (it must never be the
    // last window standing — `window-all-closed` would never fire).
    bootWindow.webContents.once('render-process-gone', () => splashHandover());
    bootWindow.once('closed', () => splash.close());

    await activation;
    startupMark('plugin activation finished');

    // No boot index round from main anymore (milestone 61): the
    // renderer's boot `vault:refresh` (VaultService's constructor) runs
    // the identical full announcer round — plugin index rebuilds plus the
    // `vault:changed` push — and that handler awaits `activationDone()`,
    // so the round always lands on fully registered plugin hooks. One
    // round instead of two, and it no longer contends with the renderer
    // bundle fetches.

    await syncMcpHttpTransport(mcpHttp, appConfig);
    mcpClients.sync(appConfig.get().tools.servers);
    // Start watching if the stored config enables it (ADR-0045).
    await vaultWatcher.syncFromConfig();
    startupMark('MCP transport + vault watcher synced');

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
      // `mainWindow`, not `getAllWindows().length`: the splash also is a
      // window, and it is no reason to skip recreating the main one.
      if (mainWindow === null || mainWindow.isDestroyed()) {
        createMainWindow(uiScaleFactor);
      }
    });
    startupMark('main-process startup complete');
  });

  // An app-level quit (taskbar "Quit", Cmd+Q / role quit) with the window
  // still open routes through the same prompt: intercept once, close the
  // window -- the close handler above asks the renderer -- and re-issue the
  // quit (`quitIntent`) after the window is really gone. The `!mainWindow`
  // clause is load-bearing: after an approved plain window close,
  // window-all-closed -> app.quit() fires this with no window to ask
  // through, and it must not re-intercept.
  app.on('before-quit', (event) => {
    if (exitApproved || quitIntent || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    event.preventDefault();
    quitIntent = true;
    mainWindow.close();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    splashForShutdown?.close();
    void mcpHttpForShutdown?.stop();
    void mcpClientsForShutdown?.dispose();
    void vaultWatcherForShutdown?.stop();
    // Plugin will-quit hooks first (native teardown, e.g. the browser
    // plugin's WebContentsViews), then deactivate.
    void pluginHost?.runWillQuitHooks();
    void pluginHost?.deactivateAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
