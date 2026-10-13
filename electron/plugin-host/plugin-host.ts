/**
 * The main-process plugin host (ADR-0044): discovery → gated activation →
 * a per-plugin `MainPluginContext`, plus the method allowlist the fixed
 * `plugin:invoke` channel routes to, and the registries base seams fire
 * (save hooks, vault hooks, the section-search provider MCP reads).
 *
 * Trust model: a plugin's main entry runs in-process with full Node. The
 * host's job is not to contain it — it is to make activation *failures*
 * survivable (a throwing plugin quarantines as `failed`, the app
 * continues), to namespace what plugins can register, and to give every
 * plugin a lifecycle (activate/deactivate + will-quit).
 */
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { app, type BrowserWindow, type WebContents } from 'electron';
import {
  PLUGIN_IPC_CHANNELS,
  type MainPluginContext,
  type PluginDescriptorForRenderer,
  type PluginIpcEventPayload,
  type PluginIpcInvokePayload,
  type NoteSavedEvent,
  type SaveHook,
  type SaveHookResult,
  type SectionSearchProvider,
  type SectionSearchScope,
  type SemanticSearchProvider,
  type TaskQueryProvider,
  type TextMatchOptions,
  type Unsubscribe,
  type VaultChangeEvent,
  type LlmModelListing,
} from '../../shared/plugin-api';
import { PROVIDER_PRESETS } from '../../shared/app-config';
import type { AppConfigStore } from '../app-config';
import type { LlmClient, LlmDebugLog, LlmTaskRegistry, TagSuggester } from '../llm';
import { IPC_CHANNELS } from '../../shared/ipc-api';
import type { VaultTools } from '../mcp';
import type { AssistantToolbox } from '../mcp-client';
import type { VaultManager } from '../vault-manager';
import type { VaultChangeAnnouncer } from '../vault-change-announcer';
import { PluginConfigStore } from './plugin-config-store';
import {
  buildLlmContext,
  buildVaultContext,
  runVaultTool,
  type TrackDisposable,
} from './plugin-context';
import {
  discoverPlugins,
  pluginIdPattern,
  type DiscoveredPlugin,
} from './plugin-discovery';

interface ActivatedPlugin {
  readonly discovered: DiscoveredPlugin;
  /** Registered `ipc.handle` methods, replacing on re-register. */
  readonly methods: Map<string, (payload: unknown, sender: WebContents) => unknown>;
  /** Everything the context handed out as an Unsubscribe; `deactivate` drains these. */
  readonly disposables: Array<Unsubscribe>;
  readonly willQuitCallbacks: Array<() => void>;
  module: PluginMainModule | null;
}

/** The narrowed shape of an activated plugin's default export. */
interface PluginMainModule {
  activate: (ctx: MainPluginContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}


export interface PluginHostDeps {
  readonly builtinRoot: string;
  readonly userRoot: string;
  readonly extraRoot: string | null;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly vaultManager: VaultManager;
  readonly appConfig: AppConfigStore;
  /** The provider router (ADR-0047) -- plugins always go through it. */
  readonly llm: LlmClient;
  readonly llmTasks: LlmTaskRegistry;
  /**
   * The base vault tool set (ADR-0021), wired into `ctx.llm.chat` when a
   * plugin asks for it (`vaultTools: true`) — the assistant plugin's Ask
   * loop runs `vault_search`/`vault_read`/`vault_write` in-process, exactly
   * as the pre-conversion ActionRunner did. The tools stay base; the plugin
   * never gets the instance itself.
   */
  readonly vaultTools: VaultTools;
  /**
   * The assistant's external tool set (ADR-0063): `web_fetch` + the
   * user's MCP servers, wired in when a plugin passes `externalTools`.
   */
  readonly assistantToolbox?: AssistantToolbox;
  /** The ADR-0011 diff as a plain question (`ctx.vault.confirmWrite`). */
  readonly confirmWrite?: (request: {
    path: string;
    before: string;
    after: string;
    mode: 'overwrite' | 'append';
    origin?: 'assistant';
  }) => Promise<boolean>;
  /** The vocabulary-based tag suggestion (the editor's "Suggest tags" row; also `ctx.llm.suggestTags`). */
  readonly tagSuggester: TagSuggester;
  readonly llmDebug: LlmDebugLog;
  /**
   * The external-change announcer, as a lazy closure — plugin vault
   * writes that must reach the tree/index/open tabs go through it (the
   * same round an MCP write uses). Lazy so construction order in app-services.ts
   * stays free; `null` only before the announcer exists (writes still
   * succeed, nothing is announced).
   */
  readonly vaultAnnouncer: () => VaultChangeAnnouncer | null;
  /**
   * Per-plugin activation telemetry (milestones 61 + 62): fired for every
   * discovered main entry that attempts activation, with the wall-clock
   * duration and its 1-based position among the attempted entries (the
   * splash's "Loading plugin X" progress math). Optional; main.ts wires
   * it to the log file and the splash.
   */
  readonly onPluginActivated?: (info: {
    id: string;
    name: string;
    ok: boolean;
    ms: number;
    index: number;
    total: number;
  }) => void;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export { vaultReadToolAllowed } from './plugin-context';

export class PluginHost {
  private readonly discovered = new Map<string, DiscoveredPlugin>();
  private readonly activated = new Map<string, ActivatedPlugin>();
  private readonly configStore: PluginConfigStore;
  private readonly mainWindowCreatedCallbacks: Array<(win: BrowserWindow) => void> = [];
  private readonly vaultChangeCallbacks: Array<(event: VaultChangeEvent) => void> = [];
  private readonly saveHooks: Array<SaveHook> = [];
  private searchProvider: SectionSearchProvider | null = null;
  private semanticSearchProvider: SemanticSearchProvider | null = null;
  private taskProvider: TaskQueryProvider | null = null;
  /**
   * The discovery+activation round, assigned synchronously by the first
   * `discoverAndActivate()` call. `activationDone()` hands it to IPC
   * handlers so the renderer — which now loads while activation is still
   * running (milestone 61) — can never observe a half-activated host.
   */
  private activationDonePromise: Promise<void> | null = null;
  /**
   * The window main.ts last announced (milestone 61): with the window
   * created before activation finishes, a plugin subscribing via
   * `ctx.app.onMainWindowCreated` during a LATE activate() would
   * otherwise never hear about the window that already exists.
   */
  private currentMainWindow: BrowserWindow | null = null;

  /**
   * Public registration facades — what `MainPluginContext` exposes to a
   * plugin and what the base adapters (and `NoteManager`, via the host
   * satisfying `NoteSaveHooks`) use from the outside.
   */
  readonly save: { onNoteSaved(hook: SaveHook): Unsubscribe };

  readonly search: {
    registerSectionSearch(provider: SectionSearchProvider): Unsubscribe;
    sectionSearchProvider(): SectionSearchProvider | null;
    registerSemanticSearch(provider: SemanticSearchProvider): Unsubscribe;
    notifyChanged(): void;
  };

  readonly tasks: { registerTaskQuery(provider: TaskQueryProvider): Unsubscribe };

  constructor(private readonly deps: PluginHostDeps) {
    this.configStore = new PluginConfigStore(deps.userRoot);
    this.save = {
      onNoteSaved: (hook) => {
        this.saveHooks.push(hook);
        return () => removeItem(this.saveHooks, hook);
      },
    };
    this.search = {
      registerSectionSearch: (provider) => {
        this.searchProvider = provider;
        // The provider set changed: base surfaces re-pull the vocabulary.
        this.emitSearchChanged();
        return () => {
          if (this.searchProvider === provider) {
            this.searchProvider = null;
            this.emitSearchChanged();
          }
        };
      },
      // The semantic twin (SDK 1.18): same single-slot discipline; no
      // vocabulary push — its consumers re-query, nothing is cached base-side.
      registerSemanticSearch: (provider) => {
        this.semanticSearchProvider = provider;
        return () => {
          if (this.semanticSearchProvider === provider) {
            this.semanticSearchProvider = null;
          }
        };
      },
      // The seam's read side (SDK 1.21): same getter the tasks seam has.
      sectionSearchProvider: () => this.searchProvider,
      notifyChanged: () => this.emitSearchChanged(),
    };
    this.tasks = {
      registerTaskQuery: (provider) => {
        this.taskProvider = provider;
        return () => {
          if (this.taskProvider === provider) {
            this.taskProvider = null;
          }
        };
      },
    };
  }

  /**
   * Pushes `search:changed` to the main window (base renderer surfaces
   * re-pull vocabulary + prefix styles). A no-op before the window exists
   * — the renderer pulls once on boot anyway.
   */
  private emitSearchChanged(): void {
    this.deps.getMainWindow()?.webContents.send(IPC_CHANNELS.searchChanged);
  }

  /**
   * Resolves once `discoverAndActivate()` has finished. Handlers that
   * expose plugin-owned state to the renderer (`plugins:list`,
   * `plugin:invoke`, `search:vocabulary`, `vault:refresh`) await this so
   * the window-first startup order (milestone 61) cannot serve an empty
   * plugin list or drop a boot refresh round onto unregistered hooks.
   */
  async activationDone(): Promise<void> {
    if (this.activationDonePromise !== null) {
      await this.activationDonePromise;
    }
  }

  /** Scans the roots, then imports + activates every main entry that may load. */
  async discoverAndActivate(): Promise<void> {
    // Assigned synchronously: main.ts calls this before creating the
    // window, so every gated IPC handler finds the promise in place.
    if (this.activationDonePromise === null) {
      this.activationDonePromise = this.runDiscoveryAndActivation();
    }
    await this.activationDonePromise;
  }

  private async runDiscoveryAndActivation(): Promise<void> {
    const found = await discoverPlugins({
      builtinRoot: this.deps.builtinRoot,
      userRoot: this.deps.userRoot,
      extraRoot: this.deps.extraRoot,
      pluginsConfig: this.deps.appConfig.get().plugins,
      log: (message) => this.deps.log(message, 'info'),
    });
    this.discovered.clear();
    for (const plugin of found) {
      this.discovered.set(plugin.manifest.id, plugin);
    }

    const attempted: DiscoveredPlugin[] = [];
    for (const plugin of found) {
      if (plugin.status !== 'active' || plugin.manifest.main === undefined) {
        continue;
      }
      attempted.push(plugin);
    }
    for (const [index, plugin] of attempted.entries()) {
      const started = performance.now();
      const ok = await this.activate(plugin);
      this.deps.onPluginActivated?.({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        ok,
        ms: performance.now() - started,
        index: index + 1,
        total: attempted.length,
      });
    }
  }

  /** The discovery report for the renderer (Settings → Plugins + the loader). */
  listForRenderer(): PluginDescriptorForRenderer[] {
    return [...this.discovered.values()].map((plugin) => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      ...(plugin.manifest.description !== undefined ? { description: plugin.manifest.description } : {}),
      ...(plugin.manifest.author !== undefined ? { author: plugin.manifest.author } : {}),
      permissions: [...(plugin.manifest.permissions ?? [])],
      status: plugin.status,
      ...(plugin.error !== undefined ? { error: plugin.error } : {}),
      manifest: plugin.manifest,
      ...(plugin.manifest.renderer !== undefined && plugin.status === 'active'
        ? { rendererUrl: `plugin://${plugin.manifest.id}/${plugin.manifest.renderer}` }
        : {}),
      ...(plugin.manifest.css !== undefined ? { css: [...plugin.manifest.css] } : {}),
      builtin: plugin.builtin,
    }));
  }

  /** Absolute root dir for a plugin id, or null — the `plugin://` handler resolves through this. */
  rendererRootFor(pluginId: string): string | null {
    if (!pluginIdPattern.test(pluginId)) {
      return null;
    }
    const plugin = this.discovered.get(pluginId);
    return plugin === undefined ? null : plugin.rootDir;
  }

  /**
   * Discovery lookup for the installer (ADR-0068): the builtin flag and
   * root dir of a discovered id, or null. Built-ins win collisions, so an
   * install with a built-in id must be refused rather than shadowed.
   */
  pluginById(pluginId: string): { builtin: boolean; rootDir: string } | null {
    const plugin = this.discovered.get(pluginId);
    return plugin === undefined ? null : { builtin: plugin.builtin, rootDir: plugin.rootDir };
  }

  /** Routes one `plugin:invoke` request. Unknown plugin/method rejects. */
  async handleInvoke(payload: PluginIpcInvokePayload, sender: WebContents): Promise<unknown> {
    if (!pluginIdPattern.test(payload.pluginId)) {
      throw new Error(`invalid plugin id`);
    }
    // Host-reserved methods (`drey.*`): plugin config + the LLM facade.
    // A plugin cannot register these names — the prefix is rejected in
    // `ctx.ipc.handle` — so the namespace stays closed.
    if (payload.method.startsWith('drey.')) {
      return this.handleInternal(payload.pluginId, payload.method, payload.payload);
    }
    const plugin = this.activated.get(payload.pluginId);
    if (plugin === undefined) {
      throw new Error(`plugin "${payload.pluginId}" has no active main entry`);
    }
    const handler = plugin.methods.get(payload.method);
    if (handler === undefined) {
      throw new Error(`plugin "${payload.pluginId}" does not handle "${payload.method}"`);
    }
    return handler(payload.payload, sender);
  }

  /** The host-reserved `drey.*` method dispatch (config + LLM facade). */
  private async handleInternal(
    pluginId: string,
    method: string,
    payload: unknown,
  ): Promise<unknown> {
    const shape = (payload ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'drey.config.get':
        return this.configStore.get(pluginId, String(shape['key'] ?? ''));
      case 'drey.config.set':
        await this.configStore.set(pluginId, String(shape['key'] ?? ''), shape['value']);
        return undefined;
      case 'drey.llm.chat': {
        // `vaultTools: true` opts the ONE call into the ADR-0021 vault tool
        // loop (the model may call vault_search/read/write before its final
        // answer; a vault_write still goes through the confirmation bridge).
        // The renderer bridge stays string-returning: the serialized
        // `LlmChatResult` is unwrapped here, streaming reaches the renderer
        // through the `llm:delta` push, not this return value.
        const withTools = shape['vaultTools'] === true && this.deps.vaultTools !== undefined;
        const taskId = typeof shape['taskId'] === 'string' ? shape['taskId'] : undefined;
        const result = await this.deps.llmTasks.run(taskId, (signal) =>
          this.deps.llm.chat((shape['messages'] as never[]) ?? [], {
            ...(typeof shape['temperature'] === 'number'
              ? { temperature: shape['temperature'] }
              : {}),
            ...(withTools
              ? {
                  tools: this.deps.vaultTools.toolSpecs(),
                  onToolCall: (name, argsJson) =>
                    runVaultTool(
                      this.deps.vaultTools,
                      name,
                      argsJson,
                      this.deps.appConfig.get().tools.vault.write === 'confirm',
                    ),
                }
              : {}),
            ...(taskId !== undefined
              ? {
                  onDelta: (text: string) =>
                    this.deps.getMainWindow()?.webContents.send(IPC_CHANNELS.llmDelta, {
                      taskId,
                      text,
                    }),
                }
              : {}),
            signal,
          }),
        );
        return result.text;
      }
      case 'drey.llm.listModels': {
        // Model-picker data for the ACTIVE provider (ADR-0047): label +
        // listing capability from the static preset, the list itself from
        // the router (saved config — no override). Never rejects; a failed
        // listing lands in `error` so the picker can fall back to
        // hand-entry.
        const llmConfig = this.deps.appConfig.get().llm;
        const preset = PROVIDER_PRESETS[llmConfig.provider];
        let models: string[] = [];
        let error: string | null = null;
        try {
          models = await this.deps.llm.listModels();
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        return {
          providerLabel: preset.label,
          modelListing: preset.capabilities.modelListing,
          models,
          error,
        } satisfies LlmModelListing;
      }
      case 'drey.llm.capabilities':
        // The active provider's capability descriptor — a plugin gates its
        // UI on it (e.g. the image-attach chip) instead of hardcoding
        // provider ids.
        return this.deps.llm.capabilities();
      case 'drey.vault.saveAsset': {
        // Binary staging for a plugin (composer image paste/drop): same
        // `attachments/`-beside-the-note convention as the editor's
        // ADR-0024 path. Bytes arrive structured-cloned (a Uint8Array).
        const bytes = shape['bytes'];
        if (!(bytes instanceof Uint8Array)) {
          throw new Error('saveAsset expects image bytes (Uint8Array)');
        }
        const ext = typeof shape['ext'] === 'string' ? shape['ext'] : '';
        const noteRelPath = typeof shape['noteRelPath'] === 'string' ? shape['noteRelPath'] : '';
        const vaultId = typeof shape['vaultId'] === 'string' ? shape['vaultId'] : undefined;
        return this.deps.vaultManager.saveAsset(bytes, ext, noteRelPath, vaultId);
      }
      case 'drey.search.sections': {
        const provider = this.searchProvider;
        if (provider === null) {
          throw new Error('no section-search provider is registered');
        }
        const query = (shape['query'] ?? {}) as {
          tags?: string[];
          text?: string;
          match?: TextMatchOptions;
        };
        const scope = this.parseSearchScope(shape['scope']);
        // `match` (SDK 1.9) is shaped defensively like tags/text: unknown
        // fields keep the historical substring behavior.
        const match = query.match;
        return provider.search(
          {
            tags: Array.isArray(query.tags) ? query.tags : [],
            text: typeof query.text === 'string' ? query.text : '',
            ...(match !== null && typeof match === 'object'
              ? {
                  match: {
                    ...(match.caseSensitive === true ? { caseSensitive: true } : {}),
                    ...(match.wholeWord === true ? { wholeWord: true } : {}),
                    ...(match.regex === true ? { regex: true } : {}),
                  },
                }
              : {}),
          },
          scope,
        );
      }
      case 'drey.search.vocabulary': {
        const provider = this.searchProvider;
        if (provider === null) {
          throw new Error('no section-search provider is registered');
        }
        return provider.vocabulary();
      }
      case 'drey.search.semantic': {
        const provider = this.semanticSearchProvider;
        if (provider === null) {
          throw new Error('no semantic-search provider is registered');
        }
        const question = shape['question'];
        if (typeof question !== 'string' || question.trim() === '') {
          throw new Error('semantic search expects a non-empty question');
        }
        const limitRaw = shape['limit'];
        const limit =
          limitRaw === undefined || limitRaw === null
            ? undefined
            : Math.min(Math.max(Math.round(Number(limitRaw)) || 1, 1), 20);
        return provider.search(question, this.parseSearchScope(shape['scope']), limit);
      }
      default:
        throw new Error(`unknown host method "${method}"`);
    }
  }

  /** Validates the serialized `SectionSearchScope` of `drey.search.sections`. */
  private parseSearchScope(raw: unknown): SectionSearchScope | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    const shape = raw as Record<string, unknown>;
    if (shape['kind'] === 'all') {
      return { kind: 'all' };
    }
    if (shape['kind'] === 'vault' && typeof shape['vaultId'] === 'string') {
      return { kind: 'vault', vaultId: shape['vaultId'] };
    }
    throw new Error('invalid search scope');
  }

  /** Pushes one plugin event to the renderer's single fan-out channel. */
  emitEvent(pluginId: string, event: string, data?: unknown): void {
    const payload: PluginIpcEventPayload = { pluginId, event, data };
    this.deps.getMainWindow()?.webContents.send(PLUGIN_IPC_CHANNELS.pluginEvent, payload);
  }

  /**
   * Main.ts notifies on window creation. With the window-first startup
   * order (milestone 61) this can fire while activation is still
   * running — the window is also remembered so a plugin activating later
   * gets it replayed by its `ctx.app.onMainWindowCreated` subscription.
   */
  notifyMainWindowCreated(win: BrowserWindow): void {
    this.currentMainWindow = win;
    for (const cb of this.mainWindowCreatedCallbacks) {
      this.runGuarded(() => cb(win), 'onMainWindowCreated');
    }
  }

  /** Stage-2 seam: the note save pipeline fires this after writing a note. */
  async emitNoteSaved(event: Parameters<SaveHook>[0]): Promise<SaveHookResult[]> {
    if (event.applyingAction) {
      return []; // The save applies a confirmed rewrite — hooks must not re-fire (recursion).
    }
    const results: SaveHookResult[] = [];
    for (const hook of [...this.saveHooks]) {
      try {
        const result = await hook(event);
        if (result !== undefined) {
          results.push(result);
        }
      } catch (error) {
        this.deps.log(`plugin save hook failed: ${String(error)}`, 'error');
      }
    }
    return results;
  }

  /** Stage-2 seam: vault lifecycle (open/refresh/write/delete/rename) fan-out. */
  emitVaultChange(event: VaultChangeEvent): void {
    for (const cb of [...this.vaultChangeCallbacks]) {
      this.runGuarded(() => cb(event), 'onVaultChanged');
    }
  }

  /** What MCP's `vault_search` reads; null = the tool degrades with a clear error. */
  getSectionSearchProvider(): SectionSearchProvider | null {
    return this.searchProvider;
  }

  /** What the semantic surfaces read (SDK 1.18); null = they degrade. */
  getSemanticSearchProvider(): SemanticSearchProvider | null {
    return this.semanticSearchProvider;
  }

  /** What the assistant's `tasks_list` tool and MCP `tasks_list` read; null = degrade. */
  getTaskQueryProvider(): TaskQueryProvider | null {
    return this.taskProvider;
  }

  async runWillQuitHooks(): Promise<void> {
    for (const plugin of this.activated.values()) {
      for (const cb of plugin.willQuitCallbacks) {
        this.runGuarded(cb, 'onWillQuit');
      }
    }
  }

  /** Renderer-side disposal mirror: drain unsubscribes + module deactivate. */
  async deactivateAll(): Promise<void> {
    for (const [id, plugin] of this.activated) {
      const module = plugin.module;
      if (module?.deactivate !== undefined) {
        try {
          await module.deactivate();
        } catch (error) {
          this.deps.log(`plugin "${id}" deactivate failed: ${String(error)}`, 'error');
        }
      }
      for (const dispose of plugin.disposables) {
        this.runGuarded(dispose, 'disposable');
      }
    }
    this.activated.clear();
  }

  // -- activation ----------------------------------------------------------

  private async activate(discovered: DiscoveredPlugin): Promise<boolean> {
    const id = discovered.manifest.id;
    const plugin: ActivatedPlugin = {
      discovered,
      methods: new Map(),
      disposables: [],
      willQuitCallbacks: [],
      module: null,
    };
    this.activated.set(id, plugin);
    const context = this.buildContext(plugin);

    try {
      const entryPath = path.join(discovered.rootDir, discovered.manifest.main!);
      // `import()` of a CJS file: Node's interop puts `module.exports` under
      // `default`, and tsc's `export default x` puts `x` under
      // `exports.default` — so the plugin module is two `default`s deep for
      // a CJS entry, one deep for a true ESM one.
      const imported: unknown = await import(pathToFileURL(entryPath).toString());
      const module = unwrapDefault(unwrapDefault(imported));
      if (
        module === null ||
        typeof module !== 'object' ||
        typeof (module as { activate?: unknown }).activate !== 'function'
      ) {
        throw new Error('main entry has no default-exported activate()');
      }
      plugin.module = module as PluginMainModule;
      await plugin.module.activate(context);
      this.deps.log(`plugin "${id}" activated (main)`, 'info');
      return true;
    } catch (error) {
      this.activated.delete(id);
      this.discovered.set(id, {
        ...discovered,
        status: 'failed',
        error: String(error instanceof Error ? error.message : error),
      });
      this.deps.log(`plugin "${id}" failed to activate: ${String(error)}`, 'error');
      return false;
    }
  }

  /**
   * One plugin's `MainPluginContext`. `vault` and `llm` are built in
   * `plugin-context.ts`; the rest is a view on this host's registries.
   */
  private buildContext(plugin: ActivatedPlugin): MainPluginContext {
    const id = plugin.discovered.manifest.id;
    const track: TrackDisposable = (unsubscribe) => {
      if (typeof unsubscribe === 'function') {
        plugin.disposables.push(unsubscribe as Unsubscribe);
      }
      return unsubscribe;
    };

    return {
      pluginId: id,
      manifest: plugin.discovered.manifest,
      app: this.buildAppContext(plugin, track),
      vault: buildVaultContext(id, this.deps, (cb) => {
        this.vaultChangeCallbacks.push(cb);
        return track(() => removeItem(this.vaultChangeCallbacks, cb));
      }),
      appConfig: { get: () => this.deps.appConfig.get() },
      config: {
        get: <T>(key: string) => this.configStore.get<T>(id, key),
        set: <T>(key: string, value: T) => this.configStore.set(id, key, value),
      },
      save: {
        onNoteSaved: (hook) => track(this.save.onNoteSaved(hook)),
      },
      search: {
        registerSectionSearch: (provider) => track(this.search.registerSectionSearch(provider)),
        sectionSearchProvider: () => this.search.sectionSearchProvider(),
        registerSemanticSearch: (provider) =>
          track(this.search.registerSemanticSearch(provider)),
        notifyChanged: () => this.search.notifyChanged(),
      },
      tasks: {
        registerTaskQuery: (provider) => track(this.tasks.registerTaskQuery(provider)),
        queryProvider: () => this.taskProvider,
      },
      llm: buildLlmContext(this.deps, track),
      ipc: {
        handle: (method, fn) => {
          if (method.startsWith('drey.')) {
            throw new Error('the "drey." method prefix is reserved by the host');
          }
          plugin.methods.set(method, fn);
        },
        emit: (event, data) => this.emitEvent(id, event, data),
      },
      log: (message, level) => this.deps.log(`plugin "${id}": ${message}`, level ?? 'info'),
    };
  }

  /** `ctx.app`: the window and the quit hook. */
  private buildAppContext(plugin: ActivatedPlugin, track: TrackDisposable): MainPluginContext['app'] {
    return {
      onMainWindowCreated: (cb) => {
        this.mainWindowCreatedCallbacks.push(cb);
        // Window-first startup (milestone 61): a plugin subscribing
        // after the window exists gets it replayed (microtask, so the
        // subscribe call returns first) — identical behaviour to a
        // plugin that activated before the window was created.
        const existing = this.currentMainWindow;
        if (existing !== null && !existing.isDestroyed()) {
          queueMicrotask(() => {
            if (!existing.isDestroyed()) {
              this.runGuarded(() => cb(existing), 'onMainWindowCreated');
            }
          });
        }
        return track(() => removeItem(this.mainWindowCreatedCallbacks, cb));
      },
      getMainWindow: () => this.deps.getMainWindow(),
      onWillQuit: (cb) => {
        plugin.willQuitCallbacks.push(cb);
        return track(() => removeItem(plugin.willQuitCallbacks, cb));
      },
      appVersion: app.getVersion(),
    };
  }

  private runGuarded(fn: () => void, what: string): void {
    try {
      fn();
    } catch (error) {
      this.deps.log(`plugin ${what} callback failed: ${String(error)}`, 'error');
    }
  }
}

function removeItem<T>(list: T[], item: T): void {
  const index = list.indexOf(item);
  if (index !== -1) {
    list.splice(index, 1);
  }
}

/** One level of `export default` interop: `{ default: x }` -> `x`. */
function unwrapDefault(value: unknown): unknown {
  const candidate = value as { default?: unknown } | null;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'default' in candidate &&
    candidate.default !== undefined
  ) {
    return candidate.default;
  }
  return value;
}
