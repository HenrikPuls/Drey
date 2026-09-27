import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  AppConfig,
  CustomDictionary,
  DreyApi,
  DraftSaveRequest,
  EditCommand,
  ExitConfirmRequest,
  ExitDecision,
  ExternalFileContent,
  IPC_CHANNELS,
  LlmCapabilities,
  LlmConnectionTest,
  LlmDebugEntry,
  LlmDeltaEvent,
  LlmEndpoint,
  LogEntry,
  McpStatus,
  McpWriteRequest,
  NoteSaveRequest,
  NoteSaveResult,
  OpenRequest,
  PdfExportRequest,
  PluginDescriptorForRenderer,
  PluginIpcEventPayload,
  SpellCheckResult,
  SpellLanguage,
  TagVocabularyPayload,
  VaultChangedPush,
  VaultFileContent,
  VaultFileEntry,
  VaultRegistration,
  VaultStatus,
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
    // The registration is the exit bridge's readiness signal: a close that
    // raced app startup replays its held request now instead of being lost.
    void ipcRenderer.invoke(IPC_CHANNELS.exitListenerReady);
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
  // Vault registry (ADR-0051).
  listVaults: (): Promise<VaultStatus[]> => ipcRenderer.invoke(IPC_CHANNELS.vaultList),
  getActiveVaultId: () => ipcRenderer.invoke(IPC_CHANNELS.vaultGetActiveId),
  addVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultAdd),
  removeVault: (vaultId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultRemove, vaultId),
  renameVault: (vaultId: string, name: string): Promise<VaultRegistration> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultRenameVault, vaultId, name),
  setActiveVault: (vaultId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultSetActive, vaultId),
  revealVaultFolder: (vaultId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultRevealFolder, vaultId),
  revealVaultPath: (relativePath: string, vaultId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultRevealPath, relativePath, vaultId),
  openVaultFolderInTerminal: (dirRelativePath: string, vaultId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultOpenInTerminal, dirRelativePath, vaultId),
  listVaultFiles: (vaultId?: string): Promise<VaultFileEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultListFiles, vaultId),
  readVaultFile: (relativePath: string, vaultId?: string): Promise<VaultFileContent> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultReadFile, relativePath, vaultId),
  writeVaultFile: (relativePath: string, content: string, vaultId?: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultWriteFile, relativePath, content, vaultId),
  saveVaultAsset: (
    bytes: Uint8Array,
    ext: string,
    noteRelPath: string,
    vaultId?: string,
    preferredName?: string,
  ): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultSaveAsset, bytes, ext, noteRelPath, vaultId, preferredName),
  saveVaultAssetFromUrl: (url: string, noteRelPath: string, vaultId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultSaveAssetFromUrl, url, noteRelPath, vaultId),
  createVaultFile: (relativePath: string, vaultId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateFile, relativePath, vaultId),
  createVaultDirectory: (relativePath: string, vaultId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateDirectory, relativePath, vaultId),
  renameVaultEntry: (
    fromRelativePath: string,
    toRelativePath: string,
    fromVaultId?: string,
    toVaultId?: string,
  ): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultRename, fromRelativePath, toRelativePath, fromVaultId, toVaultId),
  copyVaultEntry: (
    sourceRelativePath: string,
    destDirRelativePath: string,
    sourceVaultId?: string,
    destVaultId?: string,
  ): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCopy, sourceRelativePath, destDirRelativePath, sourceVaultId, destVaultId),
  duplicateVaultEntry: (sourceRelativePath: string, vaultId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultDuplicate, sourceRelativePath, vaultId),
  deleteVaultEntry: (relativePath: string, vaultId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultDelete, relativePath, vaultId),
  deleteVaultEntries: (relativePaths: string[], vaultId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultDeleteMany, relativePaths, vaultId),
  pickSavePath: (suggestedName: string, vaultId?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultPickSavePath, suggestedName, vaultId),
  exportNotePdf: (request: PdfExportRequest): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.exportNotePdf, request),
  buildDailyNoteContent: (date: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.dailyBuildContent, date),
  saveNote: (request: NoteSaveRequest): Promise<NoteSaveResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.noteSave, request),
  suggestTags: (entryText: string, taskId?: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.tagSuggest, entryText, taskId),
  searchVocabulary: (): Promise<TagVocabularyPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.searchVocabulary),
  onSearchChanged: (listener: () => void): (() => void) => {
    // Forward only the signal (no payload), never the IpcRendererEvent.
    const wrapped = (): void => listener();
    ipcRenderer.on(IPC_CHANNELS.searchChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.searchChanged, wrapped);
  },
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
  onLlmDelta: (listener: (event: LlmDeltaEvent) => void): (() => void) => {
    // Same rule as onLlmDebugEntry: payload only (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, event: LlmDeltaEvent): void => listener(event);
    ipcRenderer.on(IPC_CHANNELS.llmDelta, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.llmDelta, wrapped);
  },
  onLlmCapabilitiesChanged: (listener: (capabilities: LlmCapabilities) => void): (() => void) => {
    // Same rule as onLlmDebugEntry: payload only (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, caps: LlmCapabilities): void => listener(caps);
    ipcRenderer.on(IPC_CHANNELS.llmCapabilitiesChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.llmCapabilitiesChanged, wrapped);
  },
  cancelLlmTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.llmCancel, taskId),
  checkSpelling: (words: string[], language?: string): Promise<SpellCheckResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellCheck, words, language),
  suggestSpelling: (word: string, language?: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellSuggest, word, language),
  listSpellLanguages: (): Promise<SpellLanguage[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellLanguages),
  addSpellDictionary: (): Promise<CustomDictionary | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellAddDictionary),
  addSpellWord: (word: string, target: 'language' | 'personal', language?: string): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellAddWord, word, target, language),
  onOpenDailyNote: (listener: (relativePath: string) => void): (() => void) => {
    // The wrapper drops the IpcRendererEvent and forwards only the path --
    // the renderer must never get a handle to the event or to ipcRenderer
    // (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, relativePath: string): void =>
      listener(relativePath);
    ipcRenderer.on(IPC_CHANNELS.dailyOpen, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dailyOpen, wrapped);
  },
  takePendingOpenRequests: (): Promise<OpenRequest[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.externalTakePending),
  onOpenRequest: (listener: (requests: OpenRequest[]) => void): (() => void) => {
    // Payload only, never the IpcRendererEvent (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, requests: OpenRequest[]): void =>
      listener(requests);
    ipcRenderer.on(IPC_CHANNELS.externalOpenRequest, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.externalOpenRequest, wrapped);
  },
  readExternalFile: (absolutePath: string): Promise<ExternalFileContent> =>
    ipcRenderer.invoke(IPC_CHANNELS.externalRead, absolutePath),
  writeExternalFile: (absolutePath: string, content: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.externalWrite, absolutePath, content),
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
