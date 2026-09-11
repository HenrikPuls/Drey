import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-api';
import type { TagSuggester } from '../llm';
import type { PluginHost } from '../plugin-host';

export interface QueryHandlerDeps {
  tagSuggester: TagSuggester;
  /** The tags feature's vocabulary comes from whichever plugin registered it. */
  pluginHost: PluginHost;
}

/**
 * Read-side index IPC: the LLM-backed `tags:suggest` (the drawer's
 * Autotag). The suggestion's vocabulary comes from the section-search
 * provider -- the Tags plugin -- and the Autotag stays a base surface
 * because it writes into the entry drawer's draft (ADR-0044 stage 7: the
 * engine moved to the assistant plugin, the Autotag did not — it is a
 * tags/drawer feature on base transport).
 */
export function registerQueryHandlers({ tagSuggester, pluginHost }: QueryHandlerDeps): void {
  ipcMain.handle(
    IPC_CHANNELS.tagSuggest,
    (_event, entryText: string, taskId?: string): Promise<string[]> => {
      const provider = pluginHost.getSectionSearchProvider();
      if (provider === null) {
        return Promise.reject(new Error('Tag suggestions need the Tags plugin to be enabled.'));
      }
      return tagSuggester.suggest(
        entryText,
        provider.vocabulary().map((entry) => entry.tag),
        taskId,
      );
    },
  );
}
