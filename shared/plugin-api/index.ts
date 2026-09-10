/**
 * `shared/plugin-api` — the plugin SDK contract (ADR-0044), the plugin
 * analogue of `shared/ipc-api.ts`: a cross-layer contract outside the
 * feature-module rules. Both plugin hosts (electron + renderer) and every
 * plugin import from here.
 *
 * Import from `shared/plugin-api`, never from a file inside it.
 *
 * NOTE for main-process code: `plugin-api.ts` is DOM-typed (the renderer
 * contribution surface) and is excluded from electron/tsconfig.json — the
 * main side imports `manifest` / `versions` / `plugin-ipc` /
 * `main-plugin-api` shapes only.
 */
export type { PluginStatus } from './versions';
export { PLUGIN_API_VERSION } from './versions';

export type { ManifestValidation, PluginManifest, PluginPermission } from './manifest';
export { PLUGIN_ID_PATTERN, validateManifest } from './manifest';

export type {
  PluginDescriptorForRenderer,
  PluginIpcEventPayload,
  PluginIpcInvokePayload,
} from './plugin-ipc';
export { PLUGIN_IPC_CHANNELS } from './plugin-ipc';

export type {
  MainChatOptions,
  MainPluginContext,
  MainPluginModule,
  NoteSavedEvent,
  SaveHook,
  SaveHookResult,
  SectionSearchProvider,
  Unsubscribe,
  VaultChangeEvent,
  VaultChangeEventKind,
} from './main-plugin-api';

export type {
  ActiveDocument,
  CodeMirrorModules,
  DocumentChangeEvent,
  DropDecoderContrib,
  DreyPluginApi,
  EditorExtensionSlot,
  EditorSurfaceContext,
  MenuContribution,
  OpenDocumentInfo,
  PluginChatOptions,
  PluginCommand,
  PluginDocKindContrib,
  PluginDockSide,
  PluginRendererModule,
  PluginSelection,
  PluginSettingsPageContrib,
  PluginWidgetContrib,
  RewriteRequest,
} from './plugin-api';
