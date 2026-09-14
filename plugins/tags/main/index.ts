import type {
  MainPluginContext,
  MainPluginModule,
  SectionSearchProvider,
} from '../../../shared/plugin-api';
import { TagIndex } from './tag-index';

/**
 * The Tags plugin's main entry (ADR-0017, converted in ADR-0044 stage 5):
 * owns the tag index, feeds it through the save-hook and vault-change
 * registries, and registers the section-search provider that MCP's
 * `vault_search` and the SDK's `api.search` read.
 */
const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const index = new TagIndex(() => ctx.vault.listMarkdownFiles(), () =>
      ctx.appConfig.get().templates.dir,
    );
    index.setReadContent((path) => ctx.vault.read(path));

    // Which vault this (single) index mirrors: the ACTIVE one. A scoped
    // event for any OTHER vault is ignored (the index is not polluted with
    // foreign paths) -- per-vault indexes land with the M-B search scopes.
    let indexVaultId: string | null = null;
    void ctx.vault.listVaults().then((vaults) => {
      indexVaultId = vaults.find((v) => v.active)?.id ?? null;
    });

    // note:save -> incremental re-index (the `templates/` exclusion lives in
    // the index). Fires only for real saves; rewrite-applying saves are
    // filtered by the pipeline's `applyingAction` guard. A save in another
    // vault is skipped -- it belongs to that vault's (future) index.
    ctx.save.onNoteSaved((event) => {
      if (indexVaultId !== null && event.vaultId !== indexVaultId) {
        return;
      }
      index.reindexFile(event.path, event.content);
    });

    // Vault lifecycle -> full rebuild (refresh/select), removal on delete,
    // single-file re-index on a scoped write (the watcher's per-file events
    // and MCP writes land here -- same shape as the tasks plugin). A
    // vault-less `refresh` is the registry-level round (rebuild); a scoped
    // event for another vault is ignored.
    //
    // Full rebuilds run in the background and coalesce
    // (`index.requestRebuild`): activation must not block on a full-vault
    // scan — the window comes up first, and each finished sweep pushes
    // `index-updated` so the renderer re-pulls the vocabulary even when no
    // vault-change event announced the rebuild.
    const rebuildAndAnnounce = (): void => {
      void index.requestRebuild().then(() => {
        ctx.ipc.emit('index-updated', { tags: index.getVocabulary().length });
      });
    };
    ctx.vault.onChanged((event) => {
      if (event.vaultId !== undefined && indexVaultId !== null && event.vaultId !== indexVaultId) {
        return;
      }
      if (event.kind === 'delete' && event.path !== undefined) {
        index.removeFile(event.path);
        return;
      }
      if (event.kind === 'write' && event.path !== undefined) {
        void ctx.vault
          .read(event.path)
          .then((content) => index.reindexFile(event.path as string, content))
          .then(() => {
            // The renderer's vault:changed pull can outrun this async
            // re-read and render a stale row — the push after the
            // mutation lets it re-pull the settled state.
            ctx.ipc.emit('index-updated', { tags: index.getVocabulary().length });
          })
          .catch(() => index.removeFile(event.path as string));
        return;
      }
      if (event.kind === 'rename' && event.path !== undefined) {
        // Full rebuild: the rename moved content in or out of index scope.
        rebuildAndAnnounce();
        return;
      }
      rebuildAndAnnounce();
      // A registry-level round may have changed which vault is active.
      void ctx.vault.listVaults().then((vaults) => {
        indexVaultId = vaults.find((v) => v.active)?.id ?? null;
      });
    });

    // The provider MCP's `vault_search` and the SDK's `api.search` read.
    const provider: SectionSearchProvider = {
      search: async (query) => index.search(query),
      vocabulary: () => index.getVocabulary(),
    };
    ctx.search.registerSectionSearch(provider);

    // The renderer panel's vocabulary + search, namespaced.
    ctx.ipc.handle('vocabulary', () => index.getVocabulary());
    ctx.ipc.handle('search', (payload) => {
      const query = (payload ?? {}) as { tags?: string[]; text?: string };
      return index.search({
        tags: Array.isArray(query.tags) ? query.tags : [],
        text: typeof query.text === 'string' ? query.text : '',
      });
    });

    ctx.log('activated');

    // No initial build here: activation must not block on a full-vault
    // scan. The registry-level refresh round that follows activation (the
    // vault-less `refresh` above) kicks off the one boot build in the
    // background; `index-updated` tells the renderer when it is ready.
  },
};

export default plugin;
