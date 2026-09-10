/**
 * The plugin IPC payloads and the plugin descriptor the renderer sees.
 *
 * Two FIXED channels (ADR-0044), not per-plugin names: the preload is a
 * hand-written typed object, and arbitrary channel strings through the
 * contextBridge are a security smell for no benefit.
 *
 * - `plugin:invoke` (renderer -> main): `{ pluginId, method, payload }`,
 *   routed to that plugin's registered method allowlist. Unknown plugin or
 *   method -> rejection. Errors come back as strings (structured clone
 *   cannot carry `Error`).
 * - `plugin:event` (main -> renderer push): `{ pluginId, event, data }`,
 *   fanned out renderer-side by the plugin host to the owning plugin.
 *
 * This file is DOM-free and Electron-free: both processes and the preload
 * import it.
 */
import type { PluginManifest, PluginPermission } from './manifest';
import type { PluginStatus } from './versions';

/** Channel names, added to `IPC_CHANNELS` as `pluginInvoke` / `pluginEvent`. */
export const PLUGIN_IPC_CHANNELS = {
  pluginInvoke: 'plugin:invoke',
  pluginEvent: 'plugin:event',
} as const;

/** Payload of the fixed `plugin:invoke` request. */
export interface PluginIpcInvokePayload {
  readonly pluginId: string;
  readonly method: string;
  readonly payload?: unknown;
}

/** Payload of the fixed `plugin:event` push. */
export interface PluginIpcEventPayload {
  readonly pluginId: string;
  readonly event: string;
  readonly data?: unknown;
}

/**
 * One discovered plugin, as `pluginList()` hands it to the renderer. The
 * renderer entry URL is `plugin://<id>/<renderer entry>` — the main
 * process resolves the plugin root (bundled or `<userData>`), the renderer
 * only ever sees the URL. `error` carries the quarantine reason for
 * `incompatible` / `failed`.
 */
export interface PluginDescriptorForRenderer {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly permissions: readonly PluginPermission[];
  readonly status: PluginStatus;
  readonly error?: string;
  /** The validated manifest, handed back so `api.manifest` is the real thing. */
  readonly manifest: PluginManifest;
  /** Present when the plugin has a renderer entry and activated far enough to expose it. */
  readonly rendererUrl?: string;
  readonly css?: readonly string[];
  /** True for the plugins bundled with the app (not user-installed). */
  readonly builtin: boolean;
}
