import {
  app,
  BrowserWindow,
  dialog,
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
import {
  ActionContext,
  ActionOutcome,
  AppConfig,
  AppInfo,
  AskOutcome,
  ChatMessage,
  ChatThread,
  CustomDictionary,
  EditCommand,
  IPC_CHANNELS,
  LlmConnectionTest,
  LlmDebugEntry,
  LlmEndpoint,
  McpStatus,
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
import { McpHttpTransport, McpServer, VaultTools } from './mcp';
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
  mcpHttp: McpHttpTransport,
): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
  }));

  // Custom-titlebar window controls (the window is frameless, ADR-0019).
  ipcMain.handle(IPC_CHANNELS.windowMinimize, (): void => mainWindow?.minimize());
  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, (): void => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.handle(IPC_CHANNELS.windowClose, (): void => mainWindow?.close());
  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, (): boolean => mainWindow?.isMaximized() ?? false);

  // The HTML Edit menu (frameless titlebar, ADR-0019) drives the focused
  // editable element through the same native editing commands the
  // auto-hidden application menu already exposes via accelerators
  // (electron/menu.ts). CodeMirror honours the resulting DOM events, so this
  // needs nothing in the renderer beyond the menu click.
  ipcMain.handle(IPC_CHANNELS.editExec, (_event, command: EditCommand): void => {
    const wc = mainWindow?.webContents;
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
    const wc = mainWindow?.webContents;
    if (wc && Number.isFinite(factor) && factor > 0) {
      wc.setZoomFactor(factor);
    }
  });

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
  ipcMain.handle(
    IPC_CHANNELS.vaultSaveAsset,
    (_event, bytes: Uint8Array, ext: string, noteRelPath: string): Promise<string> =>
      vaultManager.saveAsset(bytes, ext, noteRelPath),
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
  ipcMain.handle(
    IPC_CHANNELS.vaultPickSavePath,
    (_event, suggestedName: string): Promise<string | null> =>
      vaultManager.pickSavePath(suggestedName),
  );
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
  ipcMain.handle(
    IPC_CHANNELS.tagSuggest,
    (_event, entryText: string, taskId?: string): Promise<string[]> =>
      actionRunner.suggestTags(
        entryText,
        tagIndex.getVocabulary().map((entry) => entry.tag),
        taskId,
      ),
  );

  ipcMain.handle(IPC_CHANNELS.configGet, (): AppConfig => appConfig.get());
  ipcMain.handle(IPC_CHANNELS.configSet, async (_event, next: AppConfig): Promise<AppConfig> => {
    const stored = appConfig.set(next);
    // The language or a dictionary path may have changed; the next check
    // reloads rather than answering from a stale dictionary.
    spellcheck.invalidate();
    // The MCP block may have flipped -- open/close the HTTP endpoint to match.
    await syncMcpHttpTransport(mcpHttp, appConfig);
    return stored;
  });

  ipcMain.handle(IPC_CHANNELS.mcpStatus, (): McpStatus => ({
    enabled: appConfig.get().mcp.enabled,
    httpListening: mcpHttp.running,
    httpPort: mcpHttp.activePort,
    stdioBridgePath: stdioBridgePath(),
  }));
  ipcMain.handle(IPC_CHANNELS.mcpWriteDecision, (_event, id: number, approved: boolean): void => {
    pendingMcpWrites.get(id)?.(approved);
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
    (
      _event,
      context: ActionContext,
      question: string,
      taskId?: string,
      history?: ChatMessage[],
    ): Promise<AskOutcome> => actionRunner.ask(context, question, taskId, history),
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
  ipcMain.handle(
    IPC_CHANNELS.spellAddWord,
    (_event, word: string, target: 'language' | 'personal'): AppConfig => {
      const trimmed = word.trim();
      const current = appConfig.get();
      const sc = current.spellcheck;
      const personalWords = [...sc.personalWords];
      const languageWords: Record<string, string[]> = {};
      for (const [id, list] of Object.entries(sc.languageWords)) {
        languageWords[id] = [...list];
      }
      if (trimmed !== '') {
        if (target === 'personal') {
          if (!personalWords.includes(trimmed)) {
            personalWords.push(trimmed);
          }
        } else {
          const list = languageWords[sc.language] ?? [];
          if (!list.includes(trimmed)) {
            languageWords[sc.language] = [...list, trimmed];
          }
        }
      }
      const stored = appConfig.set({
        ...current,
        spellcheck: { ...sc, personalWords, languageWords },
      });
      // This path doesn't go through the `config:set` handler, so reload
      // the checker here.
      spellcheck.invalidate();
      return stored;
    },
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
 * Absolute path to the MCP stdio bridge script an external client
 * (`node <path>`) runs. Packaged, `__dirname` is inside `app.asar` but the
 * script was `asarUnpack`'d, and a plain external Node does not redirect
 * `app.asar` -> `app.asar.unpacked` the way Electron does -- so point at
 * the real file. `$`-anchored so a path that merely contains "app.asar"
 * earlier is not corrupted.
 */
/**
 * The BrowserWindow / taskbar icon. Packaged, it is an `extraResources`
 * copy under `process.resourcesPath`; in dev it is `build/icon.ico` at the
 * repo root (`__dirname` is `dist-electron/electron`). `.ico` is what
 * Windows wants for a window icon.
 */
const windowIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '..', '..', 'build', 'icon.ico');

function stdioBridgePath(): string {
  const rel = ['dist-electron', 'electron', 'mcp', 'stdio-bridge.js'];
  if (app.isPackaged) {
    return path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), ...rel);
  }
  return path.join(__dirname, 'mcp', 'stdio-bridge.js');
}

/**
 * In-flight `vault_write` confirmations from MCP clients, keyed by the id
 * sent to the renderer. Resolved by the `mcp:write-decision` IPC reply; a
 * missing renderer / a timeout defaults to a reject (never write
 * unattended).
 */
const pendingMcpWrites = new Map<number, (approved: boolean) => void>();
let mcpWriteSeq = 0;
/** Module-scope handle so the `will-quit` listener can close the socket. */
let mcpHttpForShutdown: McpHttpTransport | null = null;
const MCP_WRITE_CONFIRM_TIMEOUT_MS = 120_000;

function requestMcpWriteConfirmation(request: {
  path: string;
  before: string;
  after: string;
  mode: 'overwrite' | 'append';
}): Promise<boolean> {
  const wc = mainWindow?.webContents;
  if (!wc) {
    return Promise.resolve(false);
  }
  const id = ++mcpWriteSeq;
  return new Promise<boolean>((resolve) => {
    const done = (approved: boolean): void => {
      if (pendingMcpWrites.delete(id)) {
        clearTimeout(timer);
        resolve(approved);
      }
    };
    const timer = setTimeout(() => done(false), MCP_WRITE_CONFIRM_TIMEOUT_MS);
    pendingMcpWrites.set(id, done);
    wc.send(IPC_CHANNELS.mcpWriteRequest, { id, ...request });
  });
}

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

function createMainWindow(): BrowserWindow {
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
    // The vault tool set (ADR-0021): one instance backs both the MCP
    // server and the assistant's in-process tool-calling loop.
    const vaultTools = new VaultTools(
      vaultManager,
      tagIndex,
      () => appConfig.get(),
      requestMcpWriteConfirmation,
      () => mainWindow?.webContents.send(IPC_CHANNELS.mcpVaultChanged),
    );
    const actionRunner = new ActionRunner(appConfig, lmStudio, llmTasks, vaultTools);
    const noteManager = new NoteManager(vaultManager, tagIndex, actionRunner);
    const chatStore = new ChatStore(vaultManager);
    const spellcheck = new SpellcheckService(appConfig);
    const mcpServer = new McpServer(vaultTools, app.getVersion());
    const mcpHttp = new McpHttpTransport(mcpServer);
    mcpHttpForShutdown = mcpHttp;
    await tagIndex.rebuild();
    await syncMcpHttpTransport(mcpHttp, appConfig);

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
      mcpHttp,
    );
    // The File/Edit/Selection/View menus are drawn by the renderer titlebar
    // now (ADR-0019). Keep a native menu only on macOS, where the menu bar
    // belongs to the system and its accelerators are expected there.
    Menu.setApplicationMenu(process.platform === 'darwin' ? buildApplicationMenu() : null);
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
    void mcpHttpForShutdown?.stop();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
