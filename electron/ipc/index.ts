/**
 * `electron/ipc/` -- the `ipcMain.handle` registrations, split by domain
 * (they were one 300-line function in `main.ts`). Each `register*Handlers`
 * takes exactly the collaborators its channels need; `registerIpcHandlers`
 * wires them from the composition root in `main.ts`.
 */
import { BrowserWindow } from 'electron';
import { AppConfigStore } from '../app-config';
import { DailyNoteManager } from '../daily-note';
import { LlmClient, LlmDebugLog, LlmTaskRegistry, TagSuggester } from '../llm';
import { McpHttpTransport } from '../mcp';
import { NoteManager } from '../note-manager';
import { PluginHost } from '../plugin-host';
import { SessionBackupStore } from '../session';
import { SpellcheckService } from '../spellcheck';
import { VaultManager } from '../vault-manager';
import { registerAppHandlers } from './app-handlers';
import { registerConfigHandlers } from './config-handlers';
import { ExitBridge } from './exit-bridge';
import { registerExitHandlers } from './exit-handlers';
import { registerLlmHandlers } from './llm-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { McpWriteBridge } from './mcp-write-bridge';
import { registerPluginHandlers } from './plugin-handlers';
import { registerQueryHandlers } from './query-handlers';
import { registerSessionHandlers } from './session-handlers';
import { registerSpellHandlers } from './spell-handlers';
import { registerVaultHandlers } from './vault-handlers';

export { McpWriteBridge } from './mcp-write-bridge';
export { ExitBridge } from './exit-bridge';

export interface IpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  sessionBackups: SessionBackupStore;
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
  exitBridge: ExitBridge;
  stdioBridgePath: () => string;
  syncMcpHttp: () => Promise<void>;
  syncVaultWatcher: () => Promise<void>;
  fullVaultRefresh: () => void;
  pluginHost: PluginHost;
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  registerAppHandlers(deps.getMainWindow);
  registerSessionHandlers(deps);
  registerVaultHandlers(deps);
  registerExitHandlers(deps);
  registerQueryHandlers(deps);
  registerLlmHandlers(deps);
  registerConfigHandlers(deps);
  registerMcpHandlers(deps);
  registerSpellHandlers(deps);
  registerPluginHandlers(deps);
}
