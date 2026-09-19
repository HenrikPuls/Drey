import type {
  MainPluginContext,
  MainPluginModule,
  SectionSearchProvider,
  SectionSearchScope,
} from '../../../shared/plugin-api';
import { TAG_AUTO_PALETTE, normalizeTagPrefix } from '../../../shared/tag-style';
import type { TagPrefixStyle } from '../../../shared/tag-style';
import { diffStats, lineDiff } from '../../../shared/text-diff';
import type { DiffRow } from '../../../shared/text-diff';
import { buildTextMatcher, patchContent } from '../shared/search';
import type { TagSearchQuery } from '../shared/search';
import { TagIndex } from './tag-index';

/**
 * The Tags plugin's main entry (ADR-0017, converted in ADR-0044 stage 5,
 * per-vault since milestone 33): owns one tag index per registered vault,
 * feeds them through the save-hook and vault-change registries, and
 * registers the section-search provider that MCP's `vault_search`, the
 * SDK's `api.search` and the base tag vocabulary service read. Also owns
 * the tag prefix colors (Settings → Tags, per-plugin config) and the
 * cross-file replace backend.
 */
const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const index = new TagIndex(
      (vaultId) => ctx.vault.listMarkdownFiles({ vaultId }),
      () => ctx.appConfig.get().templates.dir,
    );
    index.setReadContent((vaultId, path) => ctx.vault.read(path, { vaultId }));

    const activeVaultId = async (): Promise<string | null> => {
      const vaults = await ctx.vault.listVaults();
      return vaults.find((v) => v.active)?.id ?? null;
    };

    /** Every push point: the panel's own channel AND the base vocabulary service. */
    const announce = (): void => {
      ctx.ipc.emit('index-updated', { tags: index.getVocabulary().length });
      ctx.search.notifyChanged();
    };

    // note:save -> incremental re-index of that vault's map. Fires for EVERY
    // vault — the per-vault maps made the old boot-race vault guard
    // (`indexVaultId`) unnecessary.
    ctx.save.onNoteSaved((event) => {
      index.reindexFile(event.vaultId, event.path, event.content);
      announce();
    });

    // Vault lifecycle. Scoped events (`vaultId` present) touch exactly that
    // vault's map; the registry-level round (a vault-less `refresh`, renames
    // — content moved in or out of index scope) rebuilds every vault and
    // drops the indexes of unregistered ones.
    const rebuildAll = async (): Promise<void> => {
      const vaults = await ctx.vault.listVaults();
      await Promise.all(vaults.map((v) => index.requestRebuild(v.id)));
      const registered = new Set(vaults.map((v) => v.id));
      for (const id of index.knownVaults()) {
        if (!registered.has(id)) {
          index.dropVault(id);
        }
      }
      announce();
    };

    ctx.vault.onChanged((event) => {
      const { vaultId } = event;
      if (event.kind === 'delete' && event.path !== undefined && vaultId !== undefined) {
        index.removeFile(vaultId, event.path);
        announce();
        return;
      }
      if (event.kind === 'write' && event.path !== undefined && vaultId !== undefined) {
        void ctx.vault
          .read(event.path, { vaultId })
          .then((content) => {
            index.reindexFile(vaultId, event.path as string, content);
            // The renderer's vault:changed pull can outrun this async
            // re-read and render a stale row — the push after the
            // mutation lets it re-pull the settled state.
            announce();
          })
          .catch(() => {
            index.removeFile(vaultId, event.path as string);
            announce();
          });
        return;
      }
      void rebuildAll();
    });

    // -- Prefix colors (Settings → Tags, per-plugin config) ------------------

    const COLOR_SOURCE = /^#[0-9a-f]{6}$/i;

    const normalizePrefixRows = (raw: unknown): TagPrefixStyle[] => {
      if (!Array.isArray(raw)) {
        return [];
      }
      const seen = new Set<string>();
      const out: TagPrefixStyle[] = [];
      for (const row of raw) {
        const prefix =
          typeof (row as { prefix?: unknown })?.prefix === 'string'
            ? normalizeTagPrefix(row.prefix as string)
            : null;
        const color = (row as { color?: unknown })?.color;
        if (
          prefix === null ||
          typeof color !== 'string' ||
          !COLOR_SOURCE.test(color) ||
          seen.has(prefix)
        ) {
          continue;
        }
        seen.add(prefix);
        out.push({ prefix, color: color.toLowerCase() });
      }
      return out;
    };

    // Config lives in the (async) per-plugin store; the provider's
    // `styles()` is synchronous, so the rows are cached here and refreshed
    // whenever the settings page announces a change.
    let prefixes: TagPrefixStyle[] = [];
    const reloadPrefixes = async (): Promise<void> => {
      prefixes = normalizePrefixRows(await ctx.config.get<unknown>('prefixColors'));
    };
    await reloadPrefixes();

    // The provider MCP's `vault_search`, the SDK's `api.search` and the base
    // tag vocabulary service all read. The default scope resolves the active
    // vault at CALL time — no cached active id, no boot race.
    const provider: SectionSearchProvider = {
      search: async (query, scope) => index.search(query, scope, await activeVaultId()),
      vocabulary: () => index.getVocabulary(),
      styles: () => ({ prefixes }),
    };
    ctx.search.registerSectionSearch(provider);

    // -- Plugin backend (panel + settings page) ------------------------------

    // The settings page's swatch strip (the renderer cannot import shared
    // values over plugin://).
    ctx.ipc.handle('palette', () => ({ auto: TAG_AUTO_PALETTE }));

    // Config writes go through the write-through store; the page pokes this
    // afterwards: re-read the rows, then push so pills/chips recolor
    // everywhere.
    ctx.ipc.handle('colors-changed', async () => {
      await reloadPrefixes();
      ctx.search.notifyChanged();
      return {};
    });

    interface ReplaceRequest {
      query?: TagSearchQuery;
      replacement?: string;
      scope?: SectionSearchScope;
      /** Narrow the operation to these files (per-hit / per-file replace). */
      files?: readonly { vaultId: string; path: string }[];
    }

    interface ReplaceOpDto {
      vaultId: string;
      path: string;
      /** Replacements actually applied. */
      occurrences: number;
      /** Sections matched (freshly computed, right now). */
      sections: number;
      added: number;
      removed: number;
      diff: DiffRow[];
    }

    const queryOf = (request: ReplaceRequest): TagSearchQuery => ({
      tags: Array.isArray(request.query?.tags) ? (request.query?.tags as string[]) : [],
      text: typeof request.query?.text === 'string' ? request.query.text : '',
      ...(request.query?.match !== undefined ? { match: request.query.match } : {}),
    });

    const computeOps = async (request: ReplaceRequest): Promise<ReplaceOpDto[]> => {
      const query = queryOf(request);
      const matcher = buildTextMatcher(query);
      if (!matcher.ok) {
        // An invalid regex is a user-facing message, not an exception diet.
        throw new Error(matcher.error);
      }
      const hits = index.search(query, request.scope, await activeVaultId());
      const wanted = new Set((request.files ?? []).map((f) => `${f.vaultId} ${f.path}`));

      const groups = new Map<string, { vaultId: string; path: string }>();
      for (const hit of hits) {
        if (hit.vaultId === undefined) {
          continue;
        }
        if (request.files !== undefined && !wanted.has(`${hit.vaultId} ${hit.path}`)) {
          continue;
        }
        groups.set(`${hit.vaultId} ${hit.path}`, { vaultId: hit.vaultId, path: hit.path });
      }

      const ops: ReplaceOpDto[] = [];
      for (const { vaultId, path } of groups.values()) {
        let content: string;
        try {
          content = await ctx.vault.read(path, { vaultId });
        } catch {
          continue; // Gone or unreadable since the search — nothing to replace.
        }
        // patchContent re-matches the file's sections against THIS content,
        // so what gets replaced is what matches NOW, not at search time.
        const patch = patchContent(content.replace(/\r\n/g, '\n'), query, request.replacement ?? '');
        if (patch === null) {
          continue;
        }
        ops.push({
          vaultId,
          path,
          occurrences: patch.occurrences,
          sections: patch.sections,
          ...diffStats(patch.before, patch.after),
          diff: lineDiff(patch.before, patch.after),
        });
      }
      return ops;
    };

    ctx.ipc.handle('replace-preview', async (payload) => {
      const request = (payload ?? {}) as ReplaceRequest;
      try {
        return { ok: true as const, ops: await computeOps(request) };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ctx.ipc.handle('replace-apply', async (payload) => {
      const request = (payload ?? {}) as ReplaceRequest;
      const applied: Array<{ vaultId: string; path: string; occurrences: number }> = [];
      let error: string | undefined;
      try {
        const query = queryOf(request);
        const matcher = buildTextMatcher(query);
        if (!matcher.ok) {
          throw new Error(matcher.error);
        }
        const ops = await computeOps(request);
        for (const op of ops) {
          // Re-read + re-patch at apply time: what gets written is computed
          // NOW, not what the preview showed (a file changed in between
          // simply contributes what it matches now, or nothing).
          let content: string;
          try {
            content = await ctx.vault.read(op.path, { vaultId: op.vaultId });
          } catch {
            continue;
          }
          const crlf = content.includes('\r\n');
          const patch = patchContent(
            content.replace(/\r\n/g, '\n'),
            query,
            request.replacement ?? '',
          );
          if (patch === null || patch.after === patch.before) {
            continue;
          }
          const restored = crlf ? patch.after.replace(/\n/g, '\r\n') : patch.after;
          await ctx.vault.writeAnnounced(op.path, restored, { vaultId: op.vaultId });
          applied.push({ vaultId: op.vaultId, path: op.path, occurrences: patch.occurrences });
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      return { applied, ...(error !== undefined ? { error } : {}) };
    });

    ctx.log('activated');

    // No initial build here: activation must not block on a full-vault
    // scan. The registry-level refresh round that follows activation (the
    // vault-less `refresh` above) kicks off the boot builds in the
    // background; each finished sweep pushes both channels so the panel and
    // the base vocabulary service re-pull.
  },
};

export default plugin;
