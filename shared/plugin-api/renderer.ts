/**
 * `shared/plugin-api/renderer` — the RENDERER-side import surface of the
 * plugin SDK (ADR-0044): everything a plugin's `renderer` entry (or the
 * renderer plugin host) needs, including the DOM-typed contribution
 * surface from `plugin-api.ts`.
 *
 * Main-process code must not import this file — see the note in `index.ts`.
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

export type { Unsubscribe } from './main-plugin-api';

// The shared payload types the plugin surface references, re-exported so a
// plugin imports them from one place.
export type {
  ActionContext,
  ActionOutcome,
  AskOutcome,
  ChatMessage,
  LlmDebugEntry,
} from '../llm';
export type { TagEntry, VaultFileEntry } from '../ipc-api';
export type { TagSearchHit, TagSearchQuery } from '../tags';

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
  PluginStatusContext,
  PluginWidgetContrib,
  RewriteRequest,
} from './plugin-api';
