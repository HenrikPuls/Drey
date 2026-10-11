/**
 * `shared/plugin-api` — the plugin SDK contract (ADR-0044), the plugin
 * analogue of `shared/ipc-api.ts`: a cross-layer contract outside the
 * feature-module rules.
 *
 * THIS BARREL IS DOM-FREE and is the import surface for the main process
 * (electron main + plugin `main` entries): manifest, version gate, the two
 * IPC payload shapes, and the main-process context.
 *
 * The renderer contribution surface (`DreyPluginApi`, DOM-typed) lives in
 * `plugin-api.ts` and is re-exported by `renderer.ts` — import THAT from
 * renderer-side code. `electron/tsconfig.json` excludes the DOM-typed
 * files from its no-DOM compile, so an accidental main-side import of
 * `renderer.ts` is a compile error, not silent leakage.
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
  TagEntry,
  TagPrefixStyle,
  TagSearchHit,
  TagSearchQuery,
  SemanticSectionHit,
  TextMatchOptions,
} from './search-types';

// The shared payload types the main-side surface references (`llm.chat`,
// `save.onNoteSaved`'s `pendingActions`), re-exported so a plugin main
// imports them from one place.
export type {
  ActionContext,
  ActionOutcome,
  ChatAttachment,
  ChatMessage,
  LlmDebugEntry,
  LlmModelListing,
} from '../llm';

export type {
  MainChatOptions,
  MainPluginContext,
  MainPluginModule,
  NoteSavedEvent,
  SaveHook,
  SaveHookResult,
  SectionSearchProvider,
  SectionSearchScope,
  SemanticSearchProvider,
  SdkTaskRecord,
  TaskQueryOptions,
  TaskQueryProvider,
  TaskQuerySort,
  TaskQueryStatus,
  Unsubscribe,
  VaultChangeEvent,
  VaultChangeEventKind,
  VaultOpOptions,
} from './main-plugin-api';
