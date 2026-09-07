import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  ActionContext,
  ActionOutcome,
  AppConfig,
  AskOutcome,
  ChatThread,
  CustomDictionary,
  DreyApi,
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

/**
 * The only thing the renderer ever gets: this typed object. No
 * `ipcRenderer` reference, no Node globals -- see
 * docs/09_architecture_decisions/0001-electron-process-split-contextbridge.md.
 */
const dreyApi: DreyApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getActiveVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultGetActive),
  selectVault: () => ipcRenderer.invoke(IPC_CHANNELS.vaultSelect),
  listVaultFiles: (): Promise<VaultFileEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.vaultListFiles),
  readVaultFile: (relativePath: string): Promise<VaultFileContent> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultReadFile, relativePath),
  writeVaultFile: (relativePath: string, content: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultWriteFile, relativePath, content),
  createVaultFile: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateFile, relativePath),
  createVaultDirectory: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultCreateDirectory, relativePath),
  deleteVaultEntry: (relativePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.vaultDelete, relativePath),
  buildDailyNoteContent: (date: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.dailyBuildContent, date),
  saveNote: (request: NoteSaveRequest): Promise<NoteSaveResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.noteSave, request),
  listTags: (): Promise<TagEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.tagList),
  searchTags: (query: TagSearchQuery): Promise<TagSearchHit[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.tagSearch, query),
  summariseSearchResults: (query: TagSearchQuery, taskId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.tagSummariseResults, query, taskId),
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
  runAction: (triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome> =>
    ipcRenderer.invoke(IPC_CHANNELS.actionRun, triggerId, context, taskId),
  askChat: (context: ActionContext, question: string, taskId?: string): Promise<AskOutcome> =>
    ipcRenderer.invoke(IPC_CHANNELS.chatAsk, context, question, taskId),
  cancelLlmTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.llmCancel, taskId),
  readChatThread: (notePath: string): Promise<ChatThread> =>
    ipcRenderer.invoke(IPC_CHANNELS.threadRead, notePath),
  writeChatThread: (thread: ChatThread): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.threadWrite, thread),
  summarizeNote: (context: ActionContext, taskId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.threadSummarize, context, taskId),
  checkSpelling: (words: string[]): Promise<SpellCheckResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellCheck, words),
  listSpellLanguages: (): Promise<SpellLanguage[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellLanguages),
  addSpellDictionary: (): Promise<CustomDictionary | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.spellAddDictionary),
  onOpenDailyNote: (listener: (relativePath: string) => void): (() => void) => {
    // The wrapper drops the IpcRendererEvent and forwards only the path --
    // the renderer must never get a handle to the event or to ipcRenderer
    // (ADR-0001).
    const wrapped = (_event: IpcRendererEvent, relativePath: string): void =>
      listener(relativePath);
    ipcRenderer.on(IPC_CHANNELS.dailyOpen, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dailyOpen, wrapped);
  },
};

contextBridge.exposeInMainWorld('dreyApi', dreyApi);
