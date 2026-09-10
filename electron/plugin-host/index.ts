/**
 * `electron/plugin-host` — the main-process plugin host (ADR-0044).
 *
 * This barrel is the module's only public surface; internal files import
 * their siblings directly. The boundary is ESLint-enforced
 * (`eslint.config.mjs`).
 */
export { PluginHost, type PluginHostDeps } from './plugin-host';
export {
  discoverPlugins,
  isSafeEntryPath,
  pluginIdPattern,
  type DiscoveredPlugin,
  type DiscoveryInput,
} from './plugin-discovery';
export { PluginConfigStore } from './plugin-config-store';
