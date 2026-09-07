import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ActionContext,
  ActionOutcome,
  AppConfig,
  AppInfo,
  AskOutcome,
  ChatThread,
  CustomDictionary,
  IPC_CHANNELS,
  LlmConnectionTest,
  LlmDebugEntry,
  LlmEndpoint,
  NoteSaveRequest,
  NoteSaveResult,
  SpellCheckResult,
  SpellLanguage,
  TagEntry,
  TagSearchHit,
  TagSearchQuery,
  VaultFileContent,
  VaultFileEntry,
} from '../shared/ipc-api';
import { AppConfigStore } from './app-config';
import { ChatStore } from './chat-store';
import { DailyNoteManager } from './daily-note';
import { ActionRunner, LlmDebugLog, LlmTaskRegistry, LmStudioClient } from './llm';
import { attachContextMenu, buildApplicationMenu } from './menu';
import { NoteManager } from './note-manager';
import { SpellcheckService } from './spellcheck';
import { TagIndex } from './tags';
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

function registerIpcHandlers(
  vaultManager: VaultManager,
  dailyNotes: DailyNoteManager,
  noteManager: NoteManager,
  tagIndex: TagIndex,
  appConfig: AppConfigStore,
  lmStudio: LmStudioClient,
  actionRunner: ActionRunner,
  llmDebug: LlmDebugLog,
  chatStore: ChatStore,
  spellcheck: SpellcheckService,
): void {
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
  ipcMain.handle(IPC_CHANNELS.vaultSelect, async (): Promise<string | null> => {
    const selected = await vaultManager.selectVault();
    await tagIndex.rebuild();
    return selected;
  });
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
  ipcMain.handle(IPC_CHANNELS.vaultDelete, async (_event, relativePath: string): Promise<void> => {
    await vaultManager.deleteEntry(relativePath);
    // No file watcher -- the tag index would otherwise still list tags from
    // the deleted file until the next full rebuild.
    await tagIndex.rebuild();
  });
  ipcMain.handle(IPC_CHANNELS.dailyBuildContent, (_event, date: string): Promise<string> =>
    dailyNotes.noteContentFor(date),
  );
  ipcMain.handle(
    IPC_CHANNELS.noteSave,
    (_event, request: NoteSaveRequest): Promise<NoteSaveResult> => noteManager.saveNote(request),
  );
  ipcMain.handle(IPC_CHANNELS.tagList, (): TagEntry[] => tagIndex.getVocabulary());
  ipcMain.handle(IPC_CHANNELS.tagSearch, (_event, query: TagSearchQuery): TagSearchHit[] =>
    tagIndex.search(query),
  );
  ipcMain.handle(
    IPC_CHANNELS.tagSummariseResults,
    (_event, query: TagSearchQuery, taskId?: string): Promise<string> =>
      actionRunner.summariseSearchResults(formatHitsForSummary(tagIndex.search(query)), taskId),
  );

  ipcMain.handle(IPC_CHANNELS.configGet, (): AppConfig => appConfig.get());
  ipcMain.handle(IPC_CHANNELS.configSet, (_event, next: AppConfig): AppConfig => {
    const stored = appConfig.set(next);
    // The language or a dictionary path may have changed; the next check
    // reloads rather than answering from a stale dictionary.
    spellcheck.invalidate();
    return stored;
  });
  ipcMain.handle(IPC_CHANNELS.llmListModels, (_event, override?: LlmEndpoint): Promise<string[]> =>
    lmStudio.listModels(override),
  );
  ipcMain.handle(
    IPC_CHANNELS.llmTestConnection,
    (_event, override?: LlmEndpoint): Promise<LlmConnectionTest> =>
      lmStudio.testConnection(override),
  );
  ipcMain.handle(IPC_CHANNELS.llmDebugList, (): LlmDebugEntry[] => llmDebug.all());
  ipcMain.handle(IPC_CHANNELS.llmDebugClear, (): void => llmDebug.clear());
  ipcMain.handle(
    IPC_CHANNELS.actionRun,
    (_event, triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome> =>
      actionRunner.run(triggerId, context, taskId),
  );
  ipcMain.handle(
    IPC_CHANNELS.chatAsk,
    (_event, context: ActionContext, question: string, taskId?: string): Promise<AskOutcome> =>
      actionRunner.ask(context, question, taskId),
  );
  ipcMain.handle(IPC_CHANNELS.llmCancel, (_event, taskId: string): boolean =>
    actionRunner.cancel(taskId),
  );

  ipcMain.handle(IPC_CHANNELS.threadRead, (_event, notePath: string): Promise<ChatThread> =>
    chatStore.read(notePath),
  );
  ipcMain.handle(IPC_CHANNELS.threadWrite, (_event, thread: ChatThread): Promise<void> =>
    chatStore.write(thread),
  );
  ipcMain.handle(
    IPC_CHANNELS.threadSummarize,
    (_event, context: ActionContext, taskId?: string): Promise<string> =>
      actionRunner.summarize(context, taskId),
  );

  ipcMain.handle(IPC_CHANNELS.spellCheck, (_event, words: string[]): Promise<SpellCheckResult> =>
    spellcheck.check(words),
  );
  ipcMain.handle(IPC_CHANNELS.spellLanguages, (): Promise<SpellLanguage[]> =>
    spellcheck.listLanguages(),
  );
  ipcMain.handle(IPC_CHANNELS.spellAddDictionary, (): Promise<CustomDictionary | null> =>
    pickDictionary(),
  );
}

/**
 * Flattens search hits into the user message for the result summary: one
 * `## <heading> (<path>)` block per hit followed by its snippet, capped so
 * a very broad search does not blow the model's context.
 */
function formatHitsForSummary(hits: readonly TagSearchHit[]): string {
  const MAX_HITS = 40;
  const MAX_CHARS = 8000;
  const blocks = hits
    .slice(0, MAX_HITS)
    .map((hit) => `## ${hit.heading} (${hit.path})\n${hit.snippet}`);
  let out = blocks.join('\n\n');
  if (out.length > MAX_CHARS) {
    out = `${out.slice(0, MAX_CHARS)}\n…`;
  }
  return out;
}

/**
 * Asks for a Hunspell `.dic` and pairs it with the `.aff` of the same name
 * beside it -- the layout every Hunspell distribution uses, so one pick is
 * enough and the user is not walked through two dialogs. The language id
 * is the file's base name (`fr_FR.dic` -> `fr_FR`), which is also what
 * such files are conventionally named after.
 */
async function pickDictionary(): Promise<CustomDictionary | null> {
  const result = await dialog.showOpenDialog({
    title: 'Select a Hunspell dictionary (.dic)',
    properties: ['openFile'],
    filters: [{ name: 'Hunspell dictionary', extensions: ['dic'] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const dicPath = result.filePaths[0];
  const affPath = `${dicPath.slice(0, -'.dic'.length)}.aff`;
  if (!fs.existsSync(affPath)) {
    // Without the affix file nspell cannot build a checker at all, so
    // this is refused here rather than stored as a broken entry.
    await dialog.showMessageBox({
      type: 'warning',
      message: 'No matching .aff file found',
      detail: `Expected ${path.basename(affPath)} in the same folder as the .dic file.`,
    });
    return null;
  }
  const id = path.basename(dicPath, '.dic');
  return { id, label: id, affPath, dicPath };
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
  // The app is not a zoomable web page: Ctrl +/-/0 scales the editor
  // content in the renderer (ADR-0015), and the touchpad pinch gesture
  // must not zoom the whole window. Ctrl+wheel is suppressed renderer-side
  // (EditorZoomService).
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {
    // Older Electron rejects this off the main frame; harmless.
  });
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

  app.whenReady().then(async () => {
    const vaultManager = new VaultManager();
    const dailyNotes = new DailyNoteManager(vaultManager);
    const tagIndex = new TagIndex(vaultManager);
    const appConfig = new AppConfigStore();
    const llmDebug = new LlmDebugLog();
    const lmStudio = new LmStudioClient(appConfig, llmDebug);
    const llmTasks = new LlmTaskRegistry();
    const actionRunner = new ActionRunner(appConfig, lmStudio, llmTasks);
    const noteManager = new NoteManager(vaultManager, tagIndex, actionRunner);
    const chatStore = new ChatStore(vaultManager);
    const spellcheck = new SpellcheckService(appConfig);
    await tagIndex.rebuild();

    // Push each new debug entry to the renderer so the LLM settings pane
    // updates live while a request is in flight.
    llmDebug.onEntry((entry) => {
      mainWindow?.webContents.send(IPC_CHANNELS.llmDebugEntry, entry);
    });

    registerAppProtocol();
    registerAssetProtocol(vaultManager);
    registerIpcHandlers(
      vaultManager,
      dailyNotes,
      noteManager,
      tagIndex,
      appConfig,
      lmStudio,
      actionRunner,
      llmDebug,
      chatStore,
      spellcheck,
    );
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
