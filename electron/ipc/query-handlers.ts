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
 * Read-side index IPC: the LLM-backed `tags:suggest` (the editor's
 * `⋯` "Suggest tags" row, req-36) and the base `search:vocabulary` pull
 * (tag completion, prefix colors). Both read through the section-search
 * provider -- the Tags plugin -- which stays the single data owner
 * (ADR-0044); the Autotag stays a base surface because its write target is
 * the base editor (formerly the entry drawer's draft, ADR-0044 stage 7),
 * and the vocabulary pull is base transport so base surfaces never
 * hardcode a plugin id.
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

  // Degenerates to empty arrays with no provider registered (tags plugin
  // disabled/failed): completion and prefix colors degrade, nothing throws.
  ipcMain.handle(IPC_CHANNELS.searchVocabulary, () => {
    const provider = pluginHost.getSectionSearchProvider();
    if (provider === null) {
      return { entries: [], prefixes: [] };
    }
    return {
      entries: provider.vocabulary(),
      prefixes: provider.styles?.().prefixes ?? [],
    };
  });
}
