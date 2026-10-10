/**
 * `src/app/plugin-host` — the renderer plugin host (ADR-0044).
 *
 * This barrel is the module's only public surface; internal files import
 * their siblings directly. The boundary is ESLint-enforced
 * (`eslint.config.mjs`).
 */
export { PluginHostService } from './plugin-host.service';
export { PluginWidgetHost } from './plugin-widget-host';
export { PluginSettingsHost } from './plugin-settings-host';
export { PluginDocHost } from './plugin-doc-host';
export { DocKindRegistry } from './doc-kind-registry.service';
export {
  PLUGIN_MODULE_LOADER,
  DynamicImportLoader,
  moduleDefault,
  type PluginModuleLoader,
} from './plugin-module-loader';
export { PluginApiFactory, type PluginApiContext } from './plugin-api-impl';
export { EditorExtensionRegistry } from './editor-extension-registry.service';
export { DropDecoderRegistry } from './drop-decoder-registry.service';
export {
  MenuContributionsService,
  EditorContextMenuRegistry,
  ToolbarContributionsService,
  type ContributableMenu,
} from './menu-contributions.service';
export { HOST_CODEMIRROR } from './runtime-exports';
