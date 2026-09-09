import { ipcMain } from 'electron';
import {
  ActionContext,
  ActionOutcome,
  AskOutcome,
  ChatMessage,
  ChatThread,
  IPC_CHANNELS,
  LlmConnectionTest,
  LlmDebugEntry,
  LlmEndpoint,
} from '../../shared/ipc-api';
import { ActionRunner, LlmDebugLog, LmStudioClient } from '../llm';
import { ChatStore } from '../chat-store';

export interface LlmHandlerDeps {
  lmStudio: LmStudioClient;
  llmDebug: LlmDebugLog;
  actionRunner: ActionRunner;
  chatStore: ChatStore;
}

/**
 * LLM IPC: model discovery / connection test, the debug-log feed, running an
 * Action, the assistant's Ask + per-note summary, generation cancel, and the
 * note's sidecar chat thread read/write (ADR-0012).
 */
export function registerLlmHandlers({
  lmStudio,
  llmDebug,
  actionRunner,
  chatStore,
}: LlmHandlerDeps): void {
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
}
