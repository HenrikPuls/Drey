/**
 * `electron/ipc/` -- the `ipcMain.handle` registrations, split by domain
 * (they were one 300-line function in `main.ts`). Each `register*Handlers`
 * takes exactly the collaborators its channels need; `registerIpcHandlers`
 * wires them from the composition root in `main.ts`.
 */
import { BrowserWindow } from 'electron';
import { AppConfigStore } from '../app-config';
import { BrowserViewManager } from '../browser';
import { ChatStore } from '../chat-store';
import { DailyNoteManager } from '../daily-note';
import { ActionRunner, LlmDebugLog, LmStudioClient } from '../llm';
import { McpHttpTransport } from '../mcp';
import { NoteManager } from '../note-manager';
import { PluginHost } from '../plugin-host';
import { SessionBackupStore } from '../session';
import { SpellcheckService } from '../spellcheck';
import { TaskIndex } from '../tasks';
import { VaultManager } from '../vault-manager';
import { registerAppHandlers } from './app-handlers';
import { registerBrowserHandlers } from './browser-handlers';
import { registerConfigHandlers } from './config-handlers';
import { registerLlmHandlers } from './llm-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { McpWriteBridge } from './mcp-write-bridge';
import { registerPluginHandlers } from './plugin-handlers';
import { registerQueryHandlers } from './query-handlers';
import { registerSessionHandlers } from './session-handlers';
import { registerSpellHandlers } from './spell-handlers';
import { registerVaultHandlers } from './vault-handlers';

export { McpWriteBridge } from './mcp-write-bridge';

export interface IpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  browserViews: BrowserViewManager;
  sessionBackups: SessionBackupStore;
  vaultManager: VaultManager;
  dailyNotes: DailyNoteManager;
  noteManager: NoteManager;
  taskIndex: TaskIndex;
  appConfig: AppConfigStore;
  lmStudio: LmStudioClient;
  actionRunner: ActionRunner;
  llmDebug: LlmDebugLog;
  chatStore: ChatStore;
  spellcheck: SpellcheckService;
  mcpHttp: McpHttpTransport;
  mcpWriteBridge: McpWriteBridge;
  stdioBridgePath: () => string;
  syncMcpHttp: () => Promise<void>;
  pluginHost: PluginHost;
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  registerAppHandlers(deps.getMainWindow);
  registerBrowserHandlers(deps);
  registerSessionHandlers(deps);
  registerVaultHandlers(deps);
  registerQueryHandlers(deps);
  registerLlmHandlers(deps);
  registerConfigHandlers(deps);
  registerMcpHandlers(deps);
  registerSpellHandlers(deps);
  registerPluginHandlers(deps);
}
