import { app, globalShortcut, ipcMain, Menu } from 'electron';
import * as fs from 'node:fs';
import { IPC_CHANNELS, type StartupProgressReport } from '../shared/ipc-api';
import { UI_SCALE_FACTORS } from '../shared/app-config';
import type { LostSecrets } from './app-config';
import {
  rendererDevServerUrl,
  rendererDistDir,
  stdioBridgePath,
  windowIconFor,
  windowIconPath,
} from './app-paths';
import { registerPrivilegedSchemes, registerProtocolHandlers } from './app-protocols';
import { buildAppServices, syncMcpHttpTransport, type AppServices } from './app-services';
import type { DailyNoteManager } from './daily-note';
import { ExternalFileGate, extractOpenPaths } from './external-open';
import { installMainProcessLogging, logLine } from './logger';
import { registerIpcHandlers, ExitBridge, McpWriteBridge, ToolApprovalBridge } from './ipc';
import { MainWindowHost } from './main-window';
import { buildApplicationMenu } from './menu';
import type { UnreadableFile } from './safe-file';
import { SplashController } from './splash';
import {
  reportLostSecrets,
  reportMainProcessError,
  reportUnreadableConfigFiles,
} from './startup-reports';
import { startupMark } from './startup-timing';

/**
 * The main process's entry point and composition root: it decides *when*
 * things happen. What exists is built in `app-services.ts`; the window and
 * its exit prompt are `main-window.ts`; the custom schemes are
 * `app-protocols.ts`.
 */

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
 * What `scripts/dev-electron.mjs` sends over the child-process channel
 * when it has rebuilt `dist-electron/` and wants this (now stale) process
 * replaced. Keep in step with the constant there.
 */
const DEV_RESTART_MESSAGE = 'drey-dev:restart';

/**
 * Dev only: quits when the dev launcher asks. `app.quit()` is the ordinary
 * quit, so unsaved tabs raise the exit prompt; the launcher starts the new
 * build once this process is gone. Without a dev server URL, or when not
 * started by the launcher (no channel), nothing listens.
 */
function listenForDevRestart(): void {
  if (!rendererDevServerUrl || typeof process.send !== 'function') {
    return;
  }
  process.on('message', (message: unknown) => {
    if (message === DEV_RESTART_MESSAGE) {
      logLine('[main/dev] restart requested by the dev launcher');
      app.quit();
    }
  });
}

// Electron wants privileged schemes declared at module load, before `ready`.
registerPrivilegedSchemes();

/** Everything `whenReady` built; null before, and when startup failed early. */
let services: AppServices | null = null;

/** Module-scope handle so the `will-quit` listener can drop the splash. */
let splashForShutdown: SplashController | null = null;

/**
 * The main<->renderer bridge for the save-before-exit prompt (bug-5). The
 * renderer owns the dirty-document registry, so a close just asks it.
 */
const exitBridge: ExitBridge = new ExitBridge(() => mainWindow.current);

const mainWindow: MainWindowHost = new MainWindowHost({
  exitBridge,
  onCreated: (window) => services?.pluginHost.notifyMainWindowCreated(window),
});

/**
 * The main<->renderer bridge for confirming an MCP `vault_write` (ADR-0011 /
 * ADR-0021). Backs both the `VaultTools` confirmation callback and the
 * `mcp:write-decision` IPC handler.
 */
const mcpWriteBridge = new McpWriteBridge(() => mainWindow.current);
/** The same pattern for one external tool call's approval (ADR-0063). */
const toolApprovalBridge = new ToolApprovalBridge(() => mainWindow.current);

/**
 * Files the OS hands to Drey (Explorer "Open with" / a default-program
 * association, ADR-0054). Module-level because a `second-instance` can fire
 * before `whenReady` has built the vault manager -- the gate queues until
 * the renderer pulls, and reads the registry lazily at classification time.
 */
const externalFiles = new ExternalFileGate(
  () => services?.vaultManager.listVaults() ?? [],
  (requests) => mainWindow.current?.webContents.send(IPC_CHANNELS.externalOpenRequest, requests),
);

/**
 * Quick-capture hotkey handler: bring the main window forward and tell the
 * renderer to open today's daily note (created from `templates/daily.md`
 * if needed). The window is raised first so that even the failure case
 * (no vault selected) surfaces -- the sidebar already shows "no vault".
 */
async function openTodayDailyNote(dailyNotes: DailyNoteManager): Promise<void> {
  const window = mainWindow.current;
  if (!window || !mainWindow.raise()) {
    return;
  }

  try {
    const relativePath = await dailyNotes.ensureTodayNote();
    window.webContents.send(IPC_CHANNELS.dailyOpen, relativePath);
  } catch (err) {
    // No vault active / vault folder gone. A renderer-side toast can come
    // later; for now the raised window + sidebar state is the feedback.
    console.warn(`Quick-capture: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  installMainProcessLogging((err) => reportMainProcessError(err, mainWindow.current));
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
    mainWindow.raise();
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
    let unreadableConfigFiles: UnreadableFile[] = [];
    let lostSecrets: LostSecrets | null = null;
    let absoluteSplashFailOpen: NodeJS.Timeout | undefined;
    let loadSplashFailOpen: NodeJS.Timeout | undefined;
    const splashHandover = (): void => {
      if (splashHandoverDone) {
        return;
      }
      splashHandoverDone = true;
      clearTimeout(absoluteSplashFailOpen);
      clearTimeout(loadSplashFailOpen);
      mainWindow.current?.show();
      setTimeout(() => splash.close(), 120);
      reportUnreadableConfigFiles(unreadableConfigFiles, mainWindow.current);
      reportLostSecrets(lostSecrets, mainWindow.current);
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

    const built = buildAppServices({
      getMainWindow: () => mainWindow.current,
      mcpWriteBridge,
      toolApprovalBridge,
      onPluginActivated: ({ id, name, ok, ms, index, total }) => {
        logLine(
          `[startup] plugin "${id}" ${ok ? 'activated' : 'FAILED'} in ${Math.round(ms)}ms`,
        );
        // The splash band for plugin activation (milestone 62): 15–60 %,
        // one step per main entry, named for the user.
        splash.progress(`Loading plugin ${name}`, 15 + (45 * index) / total);
      },
    });
    services = built;
    const {
      appConfig,
      vaultManager,
      vaultAnnouncer,
      vaultWatcher,
      dailyNotes,
      llm,
      llmDebug,
      mcpHttp,
      mcpClients,
      pluginHost,
    } = built;
    unreadableConfigFiles = [appConfig.loadProblem, vaultManager.loadProblem].filter(
      (problem): problem is UnreadableFile => problem !== null,
    );
    lostSecrets = appConfig.lostSecrets;
    startupMark('base services + plugin host constructed');
    splash.progress('Loading settings', 10);

    // Push each new debug entry to the renderer so the LLM settings pane
    // updates live while a request is in flight.
    llmDebug.onEntry((entry) => {
      mainWindow.current?.webContents.send(IPC_CHANNELS.llmDebugEntry, entry);
    });

    // Push the active provider's capabilities after every config write -- a
    // provider switch changes them, and plugins cache them for
    // synchronously-readable UI gating (the ocr plugin's menu row).
    appConfig.onChange(() => {
      try {
        mainWindow.current?.webContents.send(
          IPC_CHANNELS.llmCapabilitiesChanged,
          llm.capabilities(),
        );
      } catch {
        // Unrouted provider id -- capabilities are meaningless until the
        // config is fixed; the next successful write re-pushes.
      }
    });

    registerProtocolHandlers(vaultManager, pluginHost);
    registerIpcHandlers({
      getMainWindow: () => mainWindow.current,
      sessionBackups: built.sessionBackups,
      noteHistory: built.noteHistory,
      vaultManager,
      dailyNotes,
      noteManager: built.noteManager,
      appConfig,
      llm,
      llmTasks: built.llmTasks,
      tagSuggester: built.tagSuggester,
      llmDebug,
      spellcheck: built.spellcheck,
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
      syncWindowIcon: () => {
        const icon = windowIconFor(appConfig.get().appearance.theme);
        const window = mainWindow.current;
        if (icon !== null && window !== null && !window.isDestroyed()) {
          window.setIcon(icon);
        }
      },
      fullVaultRefresh: () => vaultAnnouncer.announceFullRefresh(),
      announceVaultChange: (changes) => vaultAnnouncer.announceExternal(changes),
      pluginHost,
      pluginInstaller: built.pluginInstaller,
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
    const activation = pluginHost.discoverAndActivate();
    const bootWindow = mainWindow.create(uiScaleFactor, {
      hiddenUntilReady: true,
      themeId: appConfig.get().appearance.theme,
    });
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
      if (mainWindow.isGone) {
        mainWindow.create(uiScaleFactor, { themeId: appConfig.get().appearance.theme });
      }
    });
    listenForDevRestart();
    startupMark('main-process startup complete');
  }).catch((err: unknown) => {
    // A startup step threw: without this the app would sit there with no
    // window and only a log line.
    logLine(`[main/startup] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    reportMainProcessError(
      err instanceof Error ? err : new Error(String(err)),
      mainWindow.current,
    );
  });

  // An app-level quit with the window still open goes through the
  // save-before-exit prompt first.
  app.on('before-quit', (event) => mainWindow.interceptQuit(event));

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    splashForShutdown?.close();
    void services?.mcpHttp.stop();
    void services?.mcpClients.dispose();
    void services?.vaultWatcher.stop();
    // Plugin will-quit hooks first (native teardown, e.g. the browser
    // plugin's WebContentsViews), then deactivate.
    void services?.pluginHost.runWillQuitHooks();
    void services?.pluginHost.deactivateAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
