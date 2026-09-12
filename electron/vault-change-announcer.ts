import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, VaultChangedPush } from '../shared/ipc-api';
import { PluginHost } from './plugin-host';

/** Cap for the `paths` payload of a `vault:changed` push. */
const PUSH_PATHS_CAP = 200;

export interface ExternalVaultChanges {
  /** Vault-relative `.md` paths whose content appeared or changed. */
  readonly changedPaths: readonly string[];
  /** Vault-relative `.md` paths that no longer exist. */
  readonly deletedPaths: readonly string[];
}

/**
 * One "external change landed" round, shared by every source of vault
 * changes (ADR-0045): the watcher's debounced batch, the manual refresh,
 * and an MCP `vault_write`. Two halves, in this order:
 *
 * 1. **Plugin index events** (`pluginHost.emitVaultChange`) -- per-file
 *    `write`/`delete` for `.md` files (the tags/tasks indexes key on
 *    files, never folders; an external rename arrives as a delete+add
 *    pair), or one whole-vault `refresh` for the coarse cases.
 * 2. **The renderer push** (`vault:changed`) -- reloads the file tree,
 *    re-pulls the plugin panels, and lets `EditorService` auto-reload
 *    clean open tabs.
 *
 * The deps are lazy closures because the announcer is constructed before
 * the plugin host and the window exist (the `vaultTools` pattern in
 * `main.ts`).
 */
export class VaultChangeAnnouncer {
  constructor(
    private readonly pluginHost: () => PluginHost | null,
    private readonly getMainWindow: () => BrowserWindow | null,
  ) {}

  /** Whole-vault re-index + a payload-less push (consumers reload everything). */
  announceFullRefresh(): void {
    this.pluginHost()?.emitVaultChange({ kind: 'refresh' });
    this.push({});
  }

  /**
   * A batch of external changes: per-file index events for the `.md`
   * paths, then one push whose `paths` let the renderer scope its work.
   * An empty batch (e.g. only non-Markdown files changed) still pushes --
   * the tree must show the new attachment -- but emits no index events.
   * Over {@link PUSH_PATHS_CAP} paths the payload omits `paths`; the
   * consumers then treat it as a full refresh.
   */
  announceExternal(changes: ExternalVaultChanges): void {
    const host = this.pluginHost();
    for (const path of changes.changedPaths) {
      host?.emitVaultChange({ kind: 'write', path });
    }
    for (const path of changes.deletedPaths) {
      host?.emitVaultChange({ kind: 'delete', path });
    }

    const paths = [...changes.changedPaths, ...changes.deletedPaths];
    this.push(paths.length > 0 && paths.length <= PUSH_PATHS_CAP ? { paths } : {});
  }

  private push(payload: VaultChangedPush): void {
    this.getMainWindow()?.webContents.send(IPC_CHANNELS.vaultChanged, payload);
  }
}
