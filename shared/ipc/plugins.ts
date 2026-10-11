/**
 * IPC contract, plugin part: the discovery report, the two generic
 * plugin channels (ADR-0044) and local plugin packages (ADR-0068)
 * (`shared/ipc-api.ts` is the barrel).
 */
import type { PluginDescriptorForRenderer, PluginIpcEventPayload } from '../plugin-api/plugin-ipc';

/**
 * Result of `installPluginPackage` (ADR-0068). `status: 'error'` carries a
 * ready-to-show message plus a machine-readable reason; the installer never
 * throws across the bridge.
 */
export type PluginInstallResult =
  | {
      readonly status: 'installed';
      readonly pluginId: string;
      readonly pluginName: string;
      /** True when a previous user install of the same id was replaced (its config.json is kept). */
      readonly upgraded: boolean;
    }
  | {
      readonly status: 'error';
      readonly reason:
        | 'not-a-zip'
        | 'no-manifest'
        | 'invalid-manifest'
        | 'api-version'
        | 'missing-entry'
        | 'builtin-collision'
        | 'unsafe-entry'
        | 'too-large'
        | 'io';
      readonly message: string;
    };

/** Result of `uninstallPlugin` (ADR-0068). */
export type PluginUninstallResult =
  | { readonly status: 'removed'; readonly pluginId: string }
  | {
      readonly status: 'error';
      readonly reason: 'builtin' | 'not-found' | 'io';
      readonly message: string;
    };

/** The plugin host as the renderer sees it. */
export interface PluginsIpc {
  // --- Plugin host (ADR-0044) ---------------------------------------------
  //
  // The renderer never talks to a plugin's IPC channels directly: it sees
  // the discovery report plus two generic primitives, and the plugin host
  // services build everything else on top.

  /** Every discovered plugin with its status (for the Settings → Plugins pane). */
  listPlugins(): Promise<PluginDescriptorForRenderer[]>;

  /** Invokes `method` on `pluginId`'s registered main-process handler. */
  invokePlugin(pluginId: string, method: string, payload?: unknown): Promise<unknown>;

  /**
   * Local plugin packages (ADR-0068). `pickPluginPackage` opens the native
   * .zip dialog (null when cancelled); `installPluginPackage` validates and
   * installs a picked path; `uninstallPlugin` removes a user-installed id.
   * All three apply on the next start — the UI offers `relaunchApp`.
   */
  pickPluginPackage(): Promise<string | null>;
  installPluginPackage(zipPath: string): Promise<PluginInstallResult>;
  uninstallPlugin(pluginId: string): Promise<PluginUninstallResult>;
  relaunchApp(): Promise<void>;

  /**
   * Subscribes to the single plugin event push. `pluginOnEvent` receives
   * every plugin's events; the renderer plugin host fans them out by
   * `pluginId`. Returns an unsubscribe.
   */
  onPluginEvent(listener: (event: PluginIpcEventPayload) => void): () => void;
}
