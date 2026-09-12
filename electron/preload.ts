import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  AppConfig,
  CustomDictionary,
  DreyApi,
  DraftSaveRequest,
  EditCommand,
  ExitConfirmRequest,
  ExitDecision,
  IPC_CHANNELS,
  LlmConnectionTest,
  LlmDebugEntry,
  LlmEndpoint,
  LogEntry,
  McpStatus,
  McpWriteRequest,
  NoteSaveRequest,
  NoteSaveResult,
  PluginDescriptorForRenderer,
  PluginIpcEventPayload,
  SpellCheckResult,
  SpellLanguage,
  VaultChangedPush,
  VaultFileContent,
  VaultFileEntry,
} from '../shared/ipc-api';

/**
 * The only thing the renderer ever gets: this typed object. No
 * `ipcRenderer` reference, no Node globals -- see
 * docs/09_architecture_decisions/0001-electron-process-split-contextbridge.md.
 */
const dreyApi: DreyApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
  recoverInputFocus: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.windowRecoverInput),
  onExitConfirmRequest: (listener: (request: ExitConfirmRequest) => void): (() => void) => {
    // Forward only the payload, never the IpcRendererEvent (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, request: ExitConfirmRequest): void =>
      listener(request);
    ipcRenderer.on(IPC_CHANNELS.exitConfirmRequest, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.exitConfirmRequest, wrapped);
  },
  resolveExitConfirm: (id: number, decision: ExitDecision): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.exitDecision, id, decision),
  saveDraftNote: (request: DraftSaveRequest): Promise<NoteSaveResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.draftSave, request),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized),
  onWindowMaximizeChange: (listener: (maximized: boolean) => void): (() => void) => {
    // Forward only the payload, never the IpcRendererEvent (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, maximized: boolean): void => listener(maximized);
    ipcRenderer.on(IPC_CHANNELS.windowMaximizeChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.windowMaximizeChanged, wrapped);
  },
  execEditCommand: (command: EditCommand): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.editExec, command),
  setUiZoomFactor: (factor: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.uiSetZoom, factor),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  logMessage: (entry: LogEntry): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.appLog, entry),
  getActiveVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultGetActive),
  selectVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultSelect),
  listVaultFiles: (): Promise<VaultFileEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.vaultListFiles),
  readVaultFile: (relativePath: string): Promise<VaultFileContent> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultReadFile, relativePath),
  writeVaultFile: (relativePath: string, content: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultWriteFile, relativePath, content),
  saveVaultAsset: (bytes: Uint8Array, ext: string, noteRelPath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultSaveAsset, bytes, ext, noteRelPath),
  saveVaultAssetFromUrl: (url: string, noteRelPath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultSaveAssetFromUrl, url, noteRelPath),
  createVaultFile: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateFile, relativePath),
  createVaultDirectory: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateDirectory, relativePath),
  renameVaultEntry: (fromRelativePath: string, toRelativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultRename, fromRelativePath, toRelativePath),
  copyVaultEntry: (sourceRelativePath: string, destDirRelativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCopy, sourceRelativePath, destDirRelativePath),
  duplicateVaultEntry: (sourceRelativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultDuplicate, sourceRelativePath),
  deleteVaultEntry: (relativePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultDelete, relativePath),
  deleteVaultEntries: (relativePaths: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultDeleteMany, relativePaths),
  pickSavePath: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultPickSavePath, suggestedName),
  buildDailyNoteContent: (date: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.dailyBuildContent, date),
  saveNote: (request: NoteSaveRequest): Promise<NoteSaveResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.noteSave, request),
  suggestTags: (entryText: string, taskId?: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.tagSuggest, entryText, taskId),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC_CHANNELS.configGet),
  setConfig: (config: AppConfig): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.configSet, config),
  listLlmModels: (override?: LlmEndpoint): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.llmListModels, override),
  testLlmConnection: (override?: LlmEndpoint): Promise<LlmConnectionTest> =>
    ipcRenderer.invoke(IPC_CHANNELS.llmTestConnection, override),
  getLlmDebugLog: (): Promise<LlmDebugEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.llmDebugList),
  clearLlmDebugLog: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.llmDebugClear),
  onLlmDebugEntry: (listener: (entry: LlmDebugEntry) => void): (() => void) => {
    // Same rule as onOpenDailyNote: forward only the payload, never the
    // IpcRendererEvent or ipcRenderer itself (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, entry: LlmDebugEntry): void => listener(entry);
    ipcRenderer.on(IPC_CHANNELS.llmDebugEntry, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.llmDebugEntry, wrapped);
  },
  cancelLlmTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.llmCancel, taskId),
  checkSpelling: (words: string[]): Promise<SpellCheckResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellCheck, words),
  listSpellLanguages: (): Promise<SpellLanguage[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellLanguages),
  addSpellDictionary: (): Promise<CustomDictionary | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellAddDictionary),
  addSpellWord: (word: string, target: 'language' | 'personal'): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellAddWord, word, target),
  onOpenDailyNote: (listener: (relativePath: string) => void): (() => void) => {
    // The wrapper drops the IpcRendererEvent and forwards only the path --
    // the renderer must never get a handle to the event or to ipcRenderer
    // (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, relativePath: string): void =>
      listener(relativePath);
    ipcRenderer.on(IPC_CHANNELS.dailyOpen, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dailyOpen, wrapped);
  },
  getMcpStatus: (): Promise<McpStatus> => ipcRenderer.invoke(IPC_CHANNELS.mcpStatus),
  onMcpWriteRequest: (listener: (request: McpWriteRequest) => void): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, request: McpWriteRequest): void => listener(request);
    ipcRenderer.on(IPC_CHANNELS.mcpWriteRequest, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.mcpWriteRequest, wrapped);
  },
  resolveMcpWrite: (id: number, approved: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpWriteDecision, id, approved),
  onVaultChanged: (listener: (push: VaultChangedPush) => void): (() => void) => {
    // Forward only the payload, never the IpcRendererEvent (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, push: VaultChangedPush): void => listener(push);
    ipcRenderer.on(IPC_CHANNELS.vaultChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.vaultChanged, wrapped);
  },
  refreshVault: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.vaultRefresh),
  // Session history (ADR-0043).
  writeSessionBackup: (id: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionWriteBackup, id, content),
  readSessionBackup: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionReadBackup, id),
  listSessionBackups: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.sessionListBackups),
  deleteSessionBackups: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionDeleteBackups, ids),
  // Plugin host (ADR-0044). Exactly three members: the discovery report and
  // the two generic primitives. Per-plugin surface lives behind the plugin
  // host services, not in this bridge.
  listPlugins: (): Promise<PluginDescriptorForRenderer[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.pluginList),
  invokePlugin: (pluginId: string, method: string, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.pluginInvoke, { pluginId, method, payload }),
  onPluginEvent: (listener: (event: PluginIpcEventPayload) => void): (() => void) => {
    // Forward only the payload, never the IpcRendererEvent (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, payload: PluginIpcEventPayload): void =>
      listener(payload);
    ipcRenderer.on(IPC_CHANNELS.pluginEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.pluginEvent, wrapped);
  },
};

contextBridge.exposeInMainWorld('dreyApi', dreyApi);
