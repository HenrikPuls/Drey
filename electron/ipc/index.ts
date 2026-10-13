/**
 * `electron/ipc/` -- the `ipcMain.handle` registrations, split by domain
 * (they were one 300-line function in `main.ts`). Each `register*Handlers`
 * takes exactly the collaborators its channels need; `registerIpcHandlers`
 * wires them from the composition root in `main.ts`.
 */
import { BrowserWindow } from 'electron';
import { AppConfigStore } from '../app-config';
import { DailyNoteManager } from '../daily-note';
import { ExternalFileGate } from '../external-open';
import { NoteHistoryStore } from '../history/note-history-store';
import { LlmClient, LlmDebugLog, LlmTaskRegistry, TagSuggester } from '../llm';
import { McpHttpTransport } from '../mcp';
import { McpClientManager } from '../mcp-client';
import { NoteManager } from '../note-manager';
import { PluginHost, PluginInstaller } from '../plugin-host';
import { SessionBackupStore } from '../session';
import { SpellcheckService } from '../spellcheck';
import { VaultManager } from '../vault-manager';
import { registerAppHandlers } from './app-handlers';
import { registerConfigHandlers } from './config-handlers';
import { ExitBridge } from './exit-bridge';
import { registerExitHandlers } from './exit-handlers';
import { registerExternalHandlers } from './external-handlers';
import { registerExportHandlers } from './export-handlers';
import { registerLlmHandlers } from './llm-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { McpWriteBridge } from './mcp-write-bridge';
import { OpenDocsBridge } from './open-docs-bridge';
import { ToolApprovalBridge } from './tool-approval-bridge';
import { registerPluginHandlers } from './plugin-handlers';
import { registerQueryHandlers } from './query-handlers';
import { registerSessionHandlers } from './session-handlers';
import { registerSpellHandlers } from './spell-handlers';
import { registerVaultHandlers } from './vault-handlers';
import type { ExternalVaultChanges } from '../vault-change-announcer';

export { McpWriteBridge } from './mcp-write-bridge';
export { ToolApprovalBridge } from './tool-approval-bridge';
export { OpenDocsBridge } from './open-docs-bridge';
export { ExitBridge } from './exit-bridge';

export interface IpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  sessionBackups: SessionBackupStore;
  noteHistory: NoteHistoryStore;
  vaultManager: VaultManager;
  dailyNotes: DailyNoteManager;
  noteManager: NoteManager;
  appConfig: AppConfigStore;
  llm: LlmClient;
  llmTasks: LlmTaskRegistry;
  tagSuggester: TagSuggester;
  llmDebug: LlmDebugLog;
  spellcheck: SpellcheckService;
  mcpHttp: McpHttpTransport;
  mcpWriteBridge: McpWriteBridge;
  mcpClients: McpClientManager;
  toolApprovalBridge: ToolApprovalBridge;
  openDocsBridge: OpenDocsBridge;
  syncMcpClients: () => void;
  exitBridge: ExitBridge;
  externalFiles: ExternalFileGate;
  stdioBridgePath: () => string;
  syncMcpHttp: () => Promise<void>;
  syncVaultWatcher: () => Promise<void>;
  syncWindowIcon: () => void;
  fullVaultRefresh: () => void;
  announceVaultChange: (changes: ExternalVaultChanges) => void;
  pluginHost: PluginHost;
  pluginInstaller: PluginInstaller;
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  registerAppHandlers(deps.getMainWindow);
  registerExportHandlers(deps.getMainWindow, deps.vaultManager);
  registerSessionHandlers(deps);
  registerVaultHandlers(deps);
  registerExitHandlers(deps);
  registerExternalHandlers(deps);
  registerQueryHandlers(deps);
  registerLlmHandlers(deps);
  registerConfigHandlers(deps);
  registerMcpHandlers(deps);
  registerSpellHandlers(deps);
  registerPluginHandlers(deps);
}
