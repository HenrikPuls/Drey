import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import { TaskIndex } from './task-index';

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
 * The Tasks plugin's main entry (ADR-0033, converted in ADR-0044 stage 6):
 * owns the whole-vault task index and keeps it current through the
 * save-hook and vault-change registries.
 */
const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const index = new TaskIndex(async () => markdownPaths(await ctx.vault.list()), () =>
      ctx.appConfig.get().templates.dir,
    );
    index.setReadContent((path) => ctx.vault.read(path));

    // Which vault this (single) index mirrors: the ACTIVE one. A scoped
    // event for any OTHER vault is ignored -- per-vault indexes and the
    // "all vaults" scope land with the M-B work.
    let indexVaultId: string | null = null;
    void ctx.vault.listVaults().then((vaults) => {
      indexVaultId = vaults.find((v) => v.active)?.id ?? null;
    });

    // note:save -> incremental re-index (the `templates/` exclusion lives
    // in the index). The tags plugin's provider runs on the same hook. A
    // save in another vault is skipped.
    ctx.save.onNoteSaved((event) => {
      if (indexVaultId !== null && event.vaultId !== indexVaultId) {
        return;
      }
      index.reindexFile(event.path, event.content);
    });

    // Vault lifecycle: removal on delete, full rebuild on rename / refresh.
    // A vault-less `refresh` is the registry-level round (rebuild); a
    // scoped event for another vault is ignored.
    ctx.vault.onChanged((event) => {
      if (event.vaultId !== undefined && indexVaultId !== null && event.vaultId !== indexVaultId) {
        return;
      }
      if (event.kind === 'delete' && event.path !== undefined) {
        index.removeFile(event.path);
        return;
      }
      if (event.kind === 'rename' && event.path !== undefined) {
        // The rename moved content in or out of index scope.
        void index.rebuild();
        return;
      }
      if (event.kind === 'write' && event.path !== undefined) {
        // A raw vault write (the panel's closed-file toggle, an MCP write)
        // bypasses note:save -- re-read just that file.
        const path = event.path;
        void ctx.vault
          .read(path)
          .then((content) => index.reindexFile(path, content))
          .catch(() => index.removeFile(path));
        return;
      }
      void index.rebuild();
      // A registry-level round may have changed which vault is active.
      void ctx.vault.listVaults().then((vaults) => {
        indexVaultId = vaults.find((v) => v.active)?.id ?? null;
      });
    });

    // The renderer panel's whole-vault list.
    ctx.ipc.handle('list', () => index.all());

    ctx.log('activated');

    // Initial build before activation completes: the window (and so the
    // panel's first `list` pull) comes up after the host awaited activate,
    // so the whole-vault list is populated on first read. Vault-change
    // events keep it current from here.
    await index.rebuild();
  },
};

export default plugin;
