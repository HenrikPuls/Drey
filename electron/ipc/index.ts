/**
 * `electron/ipc/` -- the `ipcMain.handle` registrations, split by domain
 * (they were one 300-line function in `main.ts`). Each `register*Handlers`
 * takes exactly the collaborators its channels need; `registerIpcHandlers`
 * wires them from the composition root in `main.ts`.
 */
import { BrowserWindow } from 'electron';
import { AppConfigStore } from '../app-config';
import { ChatStore } from '../chat-store';
import { DailyNoteManager } from '../daily-note';
import { ActionRunner, LlmDebugLog, LmStudioClient } from '../llm';
import { McpHttpTransport } from '../mcp';
import { NoteManager } from '../note-manager';
import { SpellcheckService } from '../spellcheck';
import { TagIndex } from '../tags';
import { TaskIndex } from '../tasks';
import { VaultManager } from '../vault-manager';
import { registerAppHandlers } from './app-handlers';
import { registerConfigHandlers } from './config-handlers';
import { registerLlmHandlers } from './llm-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { McpWriteBridge } from './mcp-write-bridge';
import { registerQueryHandlers } from './query-handlers';
import { registerSpellHandlers } from './spell-handlers';
import { registerVaultHandlers } from './vault-handlers';

export { McpWriteBridge } from './mcp-write-bridge';

export interface IpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  vaultManager: VaultManager;
  dailyNotes: DailyNoteManager;
  noteManager: NoteManager;
  tagIndex: TagIndex;
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
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  registerAppHandlers(deps.getMainWindow);
  registerVaultHandlers(deps);
  registerQueryHandlers(deps);
  registerLlmHandlers(deps);
  registerConfigHandlers(deps);
  registerMcpHandlers(deps);
  registerSpellHandlers(deps);
}
