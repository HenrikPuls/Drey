import type {
  MainPluginContext,
  MainPluginModule,
  SectionSearchProvider,
} from '../../../shared/plugin-api';
import { TagIndex } from './tag-index';

interface VaultNode {
  type: string;
  relativePath: string;
  children?: VaultNode[];
}

/** Flattens the vault tree to vault-relative `.md` paths (forward-slash). */
function markdownPaths(entries: readonly VaultNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly VaultNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'file' && /\.md$/i.test(node.relativePath)) {
        out.push(node.relativePath);
      }
      if (node.children !== undefined) {
        walk(node.children);
      }
    }
  };
  walk(entries);
  return out;
}

/**
 * The Tags plugin's main entry (ADR-0017, converted in ADR-0044 stage 5):
 * owns the tag index, feeds it through the save-hook and vault-change
 * registries, and registers the section-search provider that MCP's
 * `vault_search` and the SDK's `api.search` read.
 */
const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const index = new TagIndex(async () => markdownPaths(await ctx.vault.list()), () =>
      ctx.appConfig.get().templates.dir,
    );
    index.setReadContent((path) => ctx.vault.read(path));

    // note:save -> incremental re-index (the `templates/` exclusion lives in
    // the index). Fires only for real saves; rewrite-applying saves are
    // filtered by the pipeline's `applyingAction` guard.
    ctx.save.onNoteSaved((event) => {
      index.reindexFile(event.path, event.content);
    });

    // Vault lifecycle -> full rebuild (refresh/select), removal on delete.
    ctx.vault.onChanged((event) => {
      if (event.kind === 'delete' && event.path !== undefined) {
        index.removeFile(event.path);
        return;
      }
      if (event.kind === 'rename' && event.path !== undefined) {
        // Full rebuild: the rename moved content in or out of index scope.
        void index.rebuild();
        return;
      }
      void index.rebuild();
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

    // Initial build before activation completes: the window (and so the
    // Search panel's first vocabulary pull / MCP's first vault_search)
    // comes up after the host awaited activate. Vault-change events keep
    // it current from here.
    await index.rebuild();
  },
};

export default plugin;
