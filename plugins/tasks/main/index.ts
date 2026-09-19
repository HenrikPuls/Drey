import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import { TaskIndex } from './task-index';

/**
 * The Tasks plugin's main entry (ADR-0033, converted in ADR-0044 stage 6,
 * per-vault since milestone 34): owns one task index per registered vault
 * and keeps them current through the save-hook and vault-change registries.
 */
const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const index = new TaskIndex(
      (vaultId) => ctx.vault.listMarkdownFiles({ vaultId }),
      () => ctx.appConfig.get().templates.dir,
    );
    index.setReadContent((vaultId, path) => ctx.vault.read(path, { vaultId }));

    /** Every push point: the panel re-pulls its vault / all-vaults list. */
    const announce = (): void => {
      ctx.ipc.emit('index-updated', { tasks: index.all().length });
    };

    // note:save -> incremental re-index of that vault's map (the
    // `templates/` exclusion lives in the index). Fires for EVERY vault —
    // the per-vault maps made the old mirror-the-active-vault guard
    // (`indexVaultId`) unnecessary.
    ctx.save.onNoteSaved((event) => {
      index.reindexFile(event.vaultId, event.path, event.content);
      announce();
    });

    // Vault lifecycle. Scoped events (`vaultId` present) touch exactly that
    // vault's map; the registry-level round (a vault-less `refresh`, a
    // rename — content moved in or out of index scope) rebuilds every vault
    // and drops the indexes of unregistered ones.
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
        // A raw vault write (the panel's closed-file toggle, an MCP write)
        // bypasses note:save -- re-read just that file.
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

    // The renderer panel's vault / all-vaults list: every record carries
    // its `vaultId`; the panel scopes client-side (the active vault is
    // resolved there at pull time).
    ctx.ipc.handle('list', () => index.all());

    ctx.log('activated');

    // No initial build here: activation must not block on a full-vault
    // scan. The registry-level refresh round that follows activation (the
    // vault-less `refresh` above) kicks off the boot builds in the
    // background; each finished sweep pushes `index-updated` so the
    // renderer re-pulls the list.
  },
};

export default plugin;
