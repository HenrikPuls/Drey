import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  net,
  protocol,
  shell,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC_CHANNELS } from '../shared/ipc-api';
import { UI_SCALE_FACTORS } from '../shared/app-config';
import { AppConfigStore } from './app-config';
import { DailyNoteManager } from './daily-note';
import { installMainProcessLogging, watchWebContents } from './logger';
import { BrowserViewManager } from './browser';
import { LlmDebugLog, LlmTaskRegistry, LmStudioClient, TagSuggester } from './llm';
import { registerIpcHandlers, McpWriteBridge } from './ipc';
import { McpHttpTransport, McpServer, VaultTools } from './mcp';
import { attachContextMenu, buildApplicationMenu } from './menu';
import { NoteManager } from './note-manager';
import { PluginHost } from './plugin-host';
import { SessionBackupStore } from './session';
import { SpellcheckService } from './spellcheck';
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
  // Serves images referenced from notes (`![](relative/path.png)`) straight
  // from inside the active vault. `standard` so `drey-asset://asset/<path>`
  // parses with a normal pathname; `secure` so an `<img>` on the privileged
  // `app://` page is allowed to load it.
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

/**
 * `drey-asset://asset/<url-encoded vault-relative path>` -> the file inside
 * the active vault. `VaultManager.resolveAssetPath` applies the same escape
 * guard as the IPC read path; anything it rejects (no vault, `..`, absolute)
 * is a plain 404. The renderer only ever builds these URLs from
 * `resolveVaultImageUrl`, which already normalises the path.
 */
function registerAssetProtocol(vaultManager: VaultManager): void {
  protocol.handle('drey-asset', (request) => {
    const relativePath = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const filePath = vaultManager.resolveAssetPath(relativePath);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
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
    try {
      const fileResponse = await net.fetch(pathToFileURL(filePath).toString());
      const body = await fileResponse.arrayBuffer();
      const ext = path.extname(filePath).toLowerCase();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
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

/**
 * The in-editor browser tab views (Req-19, ADR-0040). Held at module scope
 * so `will-quit` / `window 'closed'` can tear every native `WebContentsView`
 * down -- an orphaned one keeps its renderer process alive.
 */
let browserViews: BrowserViewManager | null = null;

/**
 * The main<->renderer bridge for confirming an MCP `vault_write` (ADR-0011 /
 * ADR-0021). Backs both the `VaultTools` confirmation callback and the
 * `mcp:write-decision` IPC handler.
 */
const mcpWriteBridge = new McpWriteBridge(() => mainWindow);

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

function createMainWindow(getUiScaleFactor?: () => number): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
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
  // Bind the browser-tab view manager to this window (it was constructed
  // before the window so the IPC layer could take it as a dep).
  browserViews?.attach(window);
  // Plugins activated before the window existed; deliver it to the ones
  // that subscribed via `ctx.app.onMainWindowCreated`.
  pluginHost?.notifyMainWindowCreated(window);

  window.on('closed', () => {
    mainWindow = null;
    // Every browser-tab WebContentsView belonged to this window -- drop
    // them so no renderer process is orphaned.
    browserViews?.destroyAll();
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
  installMainProcessLogging();
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const vaultManager = new VaultManager();
    const dailyNotes = new DailyNoteManager(vaultManager);
    const appConfig = new AppConfigStore();
    const llmDebug = new LlmDebugLog();
    const lmStudio = new LmStudioClient(appConfig, llmDebug);
    const llmTasks = new LlmTaskRegistry();
    // The vault tool set (ADR-0021): one instance backs both the MCP
    // server and the assistant's in-process tool-calling loop.
    const vaultTools = new VaultTools(
      vaultManager,
      // The section-search seam (ADR-0044): reads whichever provider a
      // plugin registered (the Tags plugin). The closure reads the module
      // variable lazily, so construction order stays free.
      () => pluginHost?.getSectionSearchProvider() ?? null,
      () => appConfig.get(),
      (request) => mcpWriteBridge.requestConfirmation(request),
      () => {
        mainWindow?.webContents.send(IPC_CHANNELS.mcpVaultChanged);
        // An MCP write bypasses note:save — plugin vault listeners rebuild.
        pluginHostRef?.emitVaultChange({ kind: 'write' });
      },
    );
    const tagSuggester = new TagSuggester(appConfig, lmStudio, llmTasks);
    // The plugin host activates main entries before the window exists and
    // before IPC registration — plugins register their method handlers in
    // activate(), and the window-created callback reaches them afterwards.
    // It sits between the LLM facade (which plugins consume) and the
    // NoteManager (whose save hooks it carries).
    pluginHost = new PluginHost({
      // `__dirname` is `dist-electron/electron`, so the built-ins the plugin
      // build script emits live one level up.
      builtinRoot: path.join(__dirname, '..', 'plugins'),
      userRoot: path.join(app.getPath('userData'), 'plugins'),
      extraRoot: process.env['DREY_EXTRA_PLUGIN_DIR'] ?? null,
      getMainWindow: () => mainWindow,
      vaultManager,
      appConfig,
      lmStudio,
      llmTasks,
      vaultTools,
      tagSuggester,
      llmDebug,
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
    await pluginHost.discoverAndActivate();
    // The on-save Actions are the assistant plugin's save hook since
    // ADR-0044 stage 7 — the last base adapter is gone.
    const pluginHostRef = pluginHost;
    const noteManager = new NoteManager(vaultManager, {
      onNoteSaved: (hook) => pluginHostRef.save.onNoteSaved(hook),
      emitNoteSaved: (event) => pluginHostRef.emitNoteSaved(event),
    });
    const spellcheck = new SpellcheckService(appConfig);
    const mcpServer = new McpServer(vaultTools, app.getVersion());
    const mcpHttp = new McpHttpTransport(mcpServer);
    mcpHttpForShutdown = mcpHttp;
    // Constructed here (before `registerIpcHandlers`, which needs it) but
    // bound to the window later in `createMainWindow` via `attach()`.
    browserViews = new BrowserViewManager(() => mainWindow);
    const sessionBackups = new SessionBackupStore();
    // Plugins can react to the initial vault load like any later refresh
    // (the tags and tasks plugins rebuild their indexes from this event).
    pluginHostRef.emitVaultChange({ kind: 'refresh' });
    await syncMcpHttpTransport(mcpHttp, appConfig);

    // Push each new debug entry to the renderer so the LLM settings pane
    // updates live while a request is in flight.
    llmDebug.onEntry((entry) => {
      mainWindow?.webContents.send(IPC_CHANNELS.llmDebugEntry, entry);
    });

    registerAppProtocol();
    registerAssetProtocol(vaultManager);
    registerPluginProtocol();
    registerIpcHandlers({
      getMainWindow: () => mainWindow,
      browserViews,
      sessionBackups,
      vaultManager,
      dailyNotes,
      noteManager,
      appConfig,
      lmStudio,
      llmTasks,
      tagSuggester,
      llmDebug,
      spellcheck,
      mcpHttp,
      mcpWriteBridge,
      stdioBridgePath,
      syncMcpHttp: () => syncMcpHttpTransport(mcpHttp, appConfig),
      pluginHost,
    });
    // The File/Edit/Selection/View menus are drawn by the renderer titlebar
    // now (ADR-0019). Keep a native menu only on macOS, where the menu bar
    // belongs to the system and its accelerators are expected there.
    Menu.setApplicationMenu(process.platform === 'darwin' ? buildApplicationMenu() : null);
    const uiScaleFactor = (): number => UI_SCALE_FACTORS[appConfig.get().appearance.uiScale];
    createMainWindow(uiScaleFactor);

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
        createMainWindow(uiScaleFactor);
      }
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    void mcpHttpForShutdown?.stop();
    browserViews?.destroyAll();
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
