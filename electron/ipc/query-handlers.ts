import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-api';
import type { ActionRunner } from '../llm';
import type { PluginHost } from '../plugin-host';
import type { TaskIndex } from '../tasks';

export interface QueryHandlerDeps {
  taskIndex: TaskIndex;
  actionRunner: ActionRunner;
  /** The tags feature's vocabulary comes from whichever plugin registered it. */
  pluginHost: PluginHost;
}

/**
 * Read-side index IPC: the whole-vault task list, and the LLM-backed
 * `tags:suggest` (the drawer's Autotag). The suggestion's vocabulary comes
 * from the section-search provider — the Tags plugin until the tasks
 * plugin takes its own path — and the Autotag stays a base surface because
 * it writes into the entry drawer's draft.
 */
export function registerQueryHandlers({
  taskIndex,
  actionRunner,
  pluginHost,
}: QueryHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.taskList, () => taskIndex.all());
  ipcMain.handle(
    IPC_CHANNELS.tagSuggest,
    (_event, entryText: string, taskId?: string): Promise<string[]> => {
      const provider = pluginHost.getSectionSearchProvider();
      if (provider === null) {
        return Promise.reject(new Error('Tag suggestions need the Tags plugin to be enabled.'));
      }
      return actionRunner.suggestTags(
        entryText,
        provider.vocabulary().map((entry) => entry.tag),
        taskId,
      );
    },
  );
}
