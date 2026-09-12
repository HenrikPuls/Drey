import { ipcMain } from 'electron';
import { IPC_CHANNELS, LlmConnectionTest, LlmDebugEntry, LlmEndpoint } from '../../shared/ipc-api';
import type { LlmClient, LlmDebugLog, LlmTaskRegistry } from '../llm';

export interface LlmHandlerDeps {
  llm: LlmClient;
  llmDebug: LlmDebugLog;
  llmTasks: LlmTaskRegistry;
}

/**
 * LLM IPC — the transport-level handlers that stay BASE (ADR-0044 stage 7):
 * model discovery / connection test, the debug-log feed, and generation
 * cancel. The action/ask/summary/thread channels moved into the assistant
 * plugin (`plugin:invoke` on its own methods).
 */
export function registerLlmHandlers({ llm, llmDebug, llmTasks }: LlmHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.llmListModels, (_event, override?: LlmEndpoint): Promise<string[]> =>
    llm.listModels(override),
  );
  ipcMain.handle(
    IPC_CHANNELS.llmTestConnection,
    (_event, override?: LlmEndpoint): Promise<LlmConnectionTest> => llm.testConnection(override),
  );
  ipcMain.handle(IPC_CHANNELS.llmDebugList, (): LlmDebugEntry[] => llmDebug.all());
  ipcMain.handle(IPC_CHANNELS.llmDebugClear, (): void => llmDebug.clear());
  ipcMain.handle(IPC_CHANNELS.llmCancel, (_event, taskId: string): boolean =>
    llmTasks.cancel(taskId),
  );
}
