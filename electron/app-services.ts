import { app, type BrowserWindow } from 'electron';
import chokidar from 'chokidar';
import * as path from 'node:path';
import { DEFAULT_ACTIONS_CONFIG } from '../shared/app-config';
import type { VaultRegistration } from '../shared/ipc-api';
import { AppConfigStore } from './app-config';
import { DailyNoteManager } from './daily-note';
import { NoteHistoryStore } from './history/note-history-store';
import type { McpWriteBridge, OpenDocsBridge, ToolApprovalBridge } from './ipc';
import { LinkRewriter } from './link-rewriter';
import { LlmDebugLog, LlmRouter, LlmTaskRegistry, TagSuggester, buildClients } from './llm';
import { McpHttpTransport, PluginMcpTools, VaultTools, createVaultMcpServer } from './mcp';
import { AssistantToolbox, McpClientManager, createMcpClientManager } from './mcp-client';
import { NoteManager } from './note-manager';
import { OwnWriteLedger } from './own-write-ledger';
import { ManagedVaults, PluginHost, PluginInstaller, type PluginHostDeps } from './plugin-host';
import { SessionBackupStore } from './session';
import { SpellcheckService } from './spellcheck';
import { UpdateService } from './updater/update-service';
import { VaultChangeAnnouncer } from './vault-change-announcer';
import { VaultManager } from './vault-manager';
import { vaultScanIgnore } from './vault-scan-rules';
import { VaultWatcher } from './vault-watcher';

/** What building the services needs from the window-and-lifecycle half. */
export interface AppServicesDeps {
  readonly getMainWindow: () => BrowserWindow | null;
  /** Confirms an MCP / plugin vault write with the user (ADR-0011 / ADR-0021). */
  readonly mcpWriteBridge: McpWriteBridge;
  /** Asks the user about one external tool call (ADR-0063). */
  readonly toolApprovalBridge: ToolApprovalBridge;
  /** The editor's open tabs, for the vault tools (ADR-0071). */
  readonly openDocsBridge: OpenDocsBridge;
  /** Per-plugin activation telemetry (the log file and the splash). */
  readonly onPluginActivated: NonNullable<PluginHostDeps['onPluginActivated']>;
}

/** Every long-lived object of the main process, built once at startup. */
export interface AppServices {
  readonly appConfig: AppConfigStore;
  readonly noteHistory: NoteHistoryStore;
  readonly vaultManager: VaultManager;
  readonly vaultAnnouncer: VaultChangeAnnouncer;
  readonly vaultWatcher: VaultWatcher;
  readonly dailyNotes: DailyNoteManager;
  readonly noteManager: NoteManager;
  readonly llm: LlmRouter;
  readonly llmTasks: LlmTaskRegistry;
  readonly llmDebug: LlmDebugLog;
  readonly tagSuggester: TagSuggester;
  readonly vaultTools: VaultTools;
  readonly mcpHttp: McpHttpTransport;
  readonly mcpClients: McpClientManager;
  readonly pluginHost: PluginHost;
  readonly pluginInstaller: PluginInstaller;
  readonly spellcheck: SpellcheckService;
  readonly sessionBackups: SessionBackupStore;
  readonly updateService: UpdateService;
}

function consoleLog(message: string, level?: 'info' | 'warn' | 'error'): void {
  if (level === 'error') {
    console.error(message);
  } else if (level === 'warn') {
    console.warn(message);
  } else {
    console.log(message);
  }
}

/**
 * Builds the main process's services and wires them to each other. Nothing
 * here creates a window, registers a handler or starts anything that runs
 * on its own (the watcher, the MCP endpoint, plugin activation) -- that is
 * `main.ts`, which decides when.
 *
 * Construction order is forced in two places: the own-write ledger and the
 * history exist before the vault manager, and the plugin host comes after
 * the vault tools it is handed. The tools in turn read the plugin host's
 * providers, so they get closures over the local `pluginHost` variable
 * that are only called once everything is built.
 */
export function buildAppServices(deps: AppServicesDeps): AppServices {
  let pluginHost: PluginHost | null = null;

  // The own-write ledger records every mutating vault-manager call so the
  // watcher can drop the app's own echoes (ADR-0045).
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
  const vaultAnnouncer = new VaultChangeAnnouncer(() => pluginHost, deps.getMainWindow);
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
        // The vault-scan rules (T-0044): the dot entries the file tree
        // and the indexes exclude (.git, .obsidian, .drafts/,
        // .<name>.chat.json sidecars), plus reserved `_` root folders
        // (the fleet's `_worktrees/` base) — agent writes there must
        // never reach the indexes.
        ignored: vaultScanIgnore(root),
        // OneDrive & friends deliver files in flux; wait for the write
        // to settle so indexes never see half a file.
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      }),
    log: consoleLog,
  });
  const dailyNotes = new DailyNoteManager(vaultManager, appConfig, (vaultId, paths) =>
    vaultAnnouncer.announceExternal({ vaultId, changedPaths: paths, deletedPaths: [] }),
  );
  const llmDebug = new LlmDebugLog();
  // The provider router (ADR-0047): one client per implemented backend,
  // picked per call from `llm.provider` -- switching in Settings applies
  // on the next request, no restart.
  const llm = new LlmRouter(appConfig, buildClients(appConfig, llmDebug));
  const llmTasks = new LlmTaskRegistry();
  // The vault tool set (ADR-0021): one instance backs both the MCP
  // server and the assistant's in-process tool-calling loop.
  const linkRewriter = new LinkRewriter(vaultManager);
  const isNote = (file: string): boolean => file.toLowerCase().endsWith('.md');
  const vaultTools = new VaultTools({
    vault: vaultManager,
    // The section-search seam (ADR-0044): reads whichever provider a
    // plugin registered (the Tags plugin).
    getSearchProvider: () => pluginHost?.getSectionSearchProvider() ?? null,
    // The task-index seam (SDK 1.11): reads the tasks plugin's provider.
    getTaskProvider: () => pluginHost?.getTaskQueryProvider() ?? null,
    getConfig: () => appConfig.get(),
    confirmWrite: (request) => deps.mcpWriteBridge.requestConfirmation(request),
    // A move or a delete has no diff to show: the approval dialog asks,
    // without its "Always allow".
    approve: ({ tool, args }) =>
      deps.toolApprovalBridge.request({ source: 'vault', sourceName: 'Vault', tool, args, once: true }),
    rename: (request) => linkRewriter.apply(request),
    // A tool write bypasses note:save -- run the same external-change
    // round the watcher uses (index events + renderer push, scoped to
    // the touched files and their vault).
    announce: ({ vaultId, changedPaths, deletedPaths }) =>
      vaultAnnouncer.announceExternal({
        vaultId,
        changedPaths: changedPaths.filter(isNote),
        deletedPaths: deletedPaths.filter(isNote),
        otherPaths: [...changedPaths, ...deletedPaths].filter((file) => !isNote(file)),
      }),
    announceRefresh: (vaultId) => vaultAnnouncer.announceFullRefresh(vaultId),
    // A tool reads and changes an open file through its tab (ADR-0071).
    openDocs: deps.openDocsBridge,
  });
  // The assistant's external tools (ADR-0063): the configured MCP
  // servers plus the built-in web_fetch, each behind its approval rule.
  const mcpClients = createMcpClientManager(app.getVersion(), (message, level) =>
    level === 'warn' || level === 'error' ? console.warn(message) : console.log(message),
  );
  const assistantToolbox = new AssistantToolbox(
    () => appConfig.get(),
    mcpClients,
    (request) => deps.toolApprovalBridge.request(request),
  );
  // The plugin-tool seam on the MCP server (SDK 1.29, M85): plugins
  // register providers at activation; the server lists and routes them
  // beside the vault tools.
  const pluginMcpTools = new PluginMcpTools(consoleLog);
  const tagSuggester = new TagSuggester(
    // The actions slice lives in the assistant plugin's own config (the
    // ADR-0010 later change); the host seam reads + normalizes it. The
    // closure runs long after `pluginHost` is assigned.
    async () => (pluginHost !== null ? await pluginHost.readActionsConfig() : DEFAULT_ACTIONS_CONFIG),
    () => appConfig.get().llm.enabled,
    llm,
    llmTasks,
  );
  // The plugin-managed vault registry (SDK 1.32): plugins claim their
  // structured vaults through ctx.vault.markManaged, the git plugin's
  // read-only guard reads them back through ctx.vault.managedBy.
  const managedVaults = new ManagedVaults();
  // One-click vault registration for plugins (SDK 1.33, T-0045): the
  // same composed round the `vaultAdd` IPC handler runs — register the
  // folder, sync the watcher to the new registry, then one full refresh
  // round so trees, indexes and the Source control panel all follow.
  const registerVaultAt = async (folderPath: string): Promise<VaultRegistration> => {
    const added = vaultManager.addVaultAt(folderPath);
    await vaultWatcher.syncFromConfig();
    vaultAnnouncer.announceFullRefresh();
    return added;
  };
  // The plugin host registers its method handlers during activate().
  // Since milestone 61 discovery+activation STARTS before the window is
  // created and runs while the renderer parses its bundle — every IPC
  // handler that exposes plugin-owned state awaits `activationDone()`,
  // so the renderer can never observe a half-activated host.
  const host = new PluginHost({
    // `__dirname` is `dist-electron/electron`, so the built-ins the plugin
    // build script emits live one level up.
    builtinRoot: path.join(__dirname, '..', 'plugins'),
    userRoot: path.join(app.getPath('userData'), 'plugins'),
    extraRoot: process.env['DREY_EXTRA_PLUGIN_DIR'] ?? null,
    getMainWindow: deps.getMainWindow,
    vaultManager,
    appConfig,
    llm,
    llmTasks,
    vaultTools,
    managedVaults,
    registerVaultAt,
    assistantToolbox,
    mcpTools: pluginMcpTools,
    confirmWrite: (request) => deps.mcpWriteBridge.requestConfirmation(request),
    tagSuggester,
    llmDebug,
    // Plugin vault writes that must be visible immediately (chat notes)
    // run the same external-change round as an MCP write.
    vaultAnnouncer: () => vaultAnnouncer,
    onPluginActivated: deps.onPluginActivated,
    log: consoleLog,
  });
  pluginHost = host;
  // Local plugin packages (ADR-0068): install/remove under the same user
  // root the host discovers from.
  const pluginInstaller = new PluginInstaller({
    userRoot: path.join(app.getPath('userData'), 'plugins'),
    pluginHost: host,
    log: consoleLog,
  });
  const noteManager = new NoteManager(vaultManager, {
    onNoteSaved: (hook) => host.save.onNoteSaved(hook),
    emitNoteSaved: (event) => host.emitNoteSaved(event),
  });
  const spellcheck = new SpellcheckService(appConfig);
  const mcpHttp = new McpHttpTransport(() =>
    createVaultMcpServer(vaultTools, app.getVersion(), pluginMcpTools),
  );
  const sessionBackups = new SessionBackupStore();
  // The in-app update system (ADR-0074): inert unless this is a packaged
  // Windows NSIS build; main.ts decides when the startup check runs.
  const updateService = new UpdateService({ getMainWindow: deps.getMainWindow, appConfig });

  return {
    appConfig,
    noteHistory,
    vaultManager,
    vaultAnnouncer,
    vaultWatcher,
    dailyNotes,
    noteManager,
    llm,
    llmTasks,
    llmDebug,
    tagSuggester,
    vaultTools,
    mcpHttp,
    mcpClients,
    pluginHost: host,
    pluginInstaller,
    spellcheck,
    sessionBackups,
    updateService,
  };
}

/** Starts / stops the localhost MCP HTTP endpoint to match the current config. */
export async function syncMcpHttpTransport(
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
