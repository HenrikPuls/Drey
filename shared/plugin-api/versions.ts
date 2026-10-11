/**
 * The plugin API version, and the statuses a plugin can be in.
 *
 * The gate is the **major**: a plugin whose `apiVersion` differs from
 * `PLUGIN_API_VERSION.major` is never imported — it shows up in Settings
 * as `incompatible` instead. Minors are additive; hosts accept older
 * minors, plugins may use `minor` to gate newer optional surfaces.
 */
export const PLUGIN_API_VERSION = { major: 1, minor: 20 } as const;

/**
 * Lifecycle status, reported to the renderer (`PluginDescriptorForRenderer`)
 * for the Settings → Plugins pane.
 */
export type PluginStatus = 'active' | 'incompatible' | 'failed' | 'disabled';
