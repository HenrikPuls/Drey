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
    async (_event, entryText: string, taskId?: string): Promise<string[]> => {
      // Await activation (milestone 61): the provider registers during
      // the tags plugin's activate(), which now races the renderer boot.
      await pluginHost.activationDone();
      const provider = pluginHost.getSectionSearchProvider();
      if (provider === null) {
        throw new Error('Tag suggestions need the Tags plugin to be enabled.');
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
  ipcMain.handle(IPC_CHANNELS.searchVocabulary, async () => {
    // Same activation gate — a boot-time pull must not read a provider
    // the tags plugin hasn't registered yet (milestone 61).
    await pluginHost.activationDone();
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
