import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import { BacklinkIndex } from './backlink-index';

/**
 * The Backlinks plugin's main entry (milestone 54, req-39): one outlink
 * index per registered vault, fed through the save-hook and vault-change
 * registries exactly like the tags/tasks indexes, and one backend method
 * the dock panel queries for the focused note's backlink rows. Resolution
 * is the parity twin of the base wikilink service (see
 * `shared/link-index.ts`) — v1 is same-vault and `.md`-only
 * (`listMarkdownFiles`), matching what the tag index scans.
 */

const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const index = new BacklinkIndex(
      (vaultId) => ctx.vault.listMarkdownFiles({ vaultId }),
      (vaultId, path) => ctx.vault.read(path, { vaultId }),
    );

    const activeVaultId = async (): Promise<string | null> => {
      const vaults = await ctx.vault.listVaults();
      return vaults.find((v) => v.active)?.id ?? null;
    };

    /** The panel re-queries on this push after every index mutation. */
    const changed = (): void => {
      ctx.ipc.emit('links-updated', {});
    };

    // note:save -> incremental re-index of that vault's map.
    ctx.save.onNoteSaved((event) => {
      index.reindexFile(event.vaultId, event.path, event.content);
      changed();
    });

    // Vault lifecycle: scoped delete/write events touch one file; every
    // other round (refresh, renames, registry changes) rebuilds all vaults
    // and drops the ones no longer registered.
    const rebuildAll = async (): Promise<void> => {
      const vaults = await ctx.vault.listVaults();
      await Promise.all(vaults.map((v) => index.requestRebuild(v.id)));
      const registered = new Set(vaults.map((v) => v.id));
      for (const id of index.knownVaults()) {
        if (!registered.has(id)) {
          index.dropVault(id);
        }
      }
      changed();
    };

    ctx.vault.onChanged((event) => {
      const { vaultId } = event;
      if (event.kind === 'delete' && event.path !== undefined && vaultId !== undefined) {
        index.removeFile(vaultId, event.path);
        changed();
        return;
      }
      if (event.kind === 'write' && event.path !== undefined && vaultId !== undefined) {
        void ctx.vault
          .read(event.path, { vaultId })
          .then((content) => {
            index.reindexFile(vaultId, event.path as string, content);
            changed();
          })
          .catch(() => {
            index.removeFile(vaultId, event.path as string);
            changed();
          });
        return;
      }
      void rebuildAll();
    });

    // The panel's one query: the backlink rows of one note (its own vault;
    // `vaultId` defaults to the active one, resolved at call time).
    ctx.ipc.handle('backlinks', async (payload) => {
      const request = (payload ?? {}) as { path?: unknown; vaultId?: unknown };
      const path = typeof request.path === 'string' ? request.path : '';
      if (path === '') {
        return { ok: false as const, error: 'No note path given.' };
      }
      const vaultId =
        typeof request.vaultId === 'string' && request.vaultId !== ''
          ? request.vaultId
          : await activeVaultId();
      if (vaultId === null) {
        return { rows: [] };
      }
      return { rows: index.backlinksFor(vaultId, path) };
    });

    ctx.log('activated');

    // No initial build here: activation must not block on a full-vault
    // scan. The registry-level refresh round that follows activation kicks
    // off the boot sweeps; each finished sweep pushes `links-updated` so
    // the panel re-queries.
  },
};

export default plugin;
