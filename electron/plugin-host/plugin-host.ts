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
  type Unsubscribe,
  type VaultChangeEvent,
} from '../../shared/plugin-api';
import type { AppConfigStore } from '../app-config';
import type { ActionRunner, LlmDebugLog, LlmTaskRegistry, LmStudioClient } from '../llm';
import type { VaultManager } from '../vault-manager';
import { PluginConfigStore } from './plugin-config-store';
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
  readonly lmStudio: LmStudioClient;
  readonly llmTasks: LlmTaskRegistry;
  readonly actionRunner: ActionRunner;
  readonly llmDebug: LlmDebugLog;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export class PluginHost {
  private readonly discovered = new Map<string, DiscoveredPlugin>();
  private readonly activated = new Map<string, ActivatedPlugin>();
  private readonly configStore: PluginConfigStore;
  private readonly mainWindowCreatedCallbacks: Array<(win: BrowserWindow) => void> = [];
  private readonly vaultChangeCallbacks: Array<(event: VaultChangeEvent) => void> = [];
  private readonly saveHooks: Array<SaveHook> = [];
  private searchProvider: SectionSearchProvider | null = null;

  /**
   * Public registration facades — what `MainPluginContext` exposes to a
   * plugin and what the base adapters (and `NoteManager`, via the host
   * satisfying `NoteSaveHooks`) use from the outside.
   */
  readonly save: { onNoteSaved(hook: SaveHook): Unsubscribe };

  readonly search: { registerSectionSearch(provider: SectionSearchProvider): Unsubscribe };

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
        return () => {
          if (this.searchProvider === provider) {
            this.searchProvider = null;
          }
        };
      },
    };
  }

  /** Scans the roots, then imports + activates every main entry that may load. */
  async discoverAndActivate(): Promise<void> {
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

    for (const plugin of found) {
      if (plugin.status !== 'active' || plugin.manifest.main === undefined) {
        continue;
      }
      await this.activate(plugin);
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
      case 'drey.llm.chat':
        return this.deps.llmTasks.run(
          typeof shape['taskId'] === 'string' ? shape['taskId'] : undefined,
          (signal) =>
            this.deps.lmStudio.chat(
              (shape['messages'] as never[]) ?? [],
              {
                ...(typeof shape['temperature'] === 'number'
                  ? { temperature: shape['temperature'] }
                  : {}),
                signal,
              },
            ),
        );
      case 'drey.llm.ask':
        return this.deps.actionRunner.ask(
          shape['context'] as never,
          String(shape['question'] ?? ''),
          typeof shape['taskId'] === 'string' ? shape['taskId'] : undefined,
        );
      default:
        throw new Error(`unknown host method "${method}"`);
    }
  }

  /** Pushes one plugin event to the renderer's single fan-out channel. */
  emitEvent(pluginId: string, event: string, data?: unknown): void {
    const payload: PluginIpcEventPayload = { pluginId, event, data };
    this.deps.getMainWindow()?.webContents.send(PLUGIN_IPC_CHANNELS.pluginEvent, payload);
  }

  /** Main.ts notifies on window creation (plugins activate before the window exists). */
  notifyMainWindowCreated(win: BrowserWindow): void {
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

  private async activate(discovered: DiscoveredPlugin): Promise<void> {
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
    } catch (error) {
      this.activated.delete(id);
      this.discovered.set(id, {
        ...discovered,
        status: 'failed',
        error: String(error instanceof Error ? error.message : error),
      });
      this.deps.log(`plugin "${id}" failed to activate: ${String(error)}`, 'error');
    }
  }

  private buildContext(plugin: ActivatedPlugin): MainPluginContext {
    const id = plugin.discovered.manifest.id;
    const track = <T>(unsubscribe: T): T => {
      if (typeof unsubscribe === 'function') {
        plugin.disposables.push(unsubscribe as Unsubscribe);
      }
      return unsubscribe;
    };
    const { vaultManager, appConfig, lmStudio, llmTasks, actionRunner, llmDebug } = this.deps;

    return {
      pluginId: id,
      manifest: plugin.discovered.manifest,
      app: {
        onMainWindowCreated: (cb) => {
          this.mainWindowCreatedCallbacks.push(cb);
          return track(() => removeItem(this.mainWindowCreatedCallbacks, cb));
        },
        getMainWindow: () => this.deps.getMainWindow(),
        onWillQuit: (cb) => {
          plugin.willQuitCallbacks.push(cb);
          return track(() => removeItem(plugin.willQuitCallbacks, cb));
        },
        appVersion: app.getVersion(),
      },
      vault: {
        read: (p) => vaultManager.readFile(p).then((f) => f.content),
        write: (p, content) => vaultManager.writeFile(p, content),
        list: () => vaultManager.listFiles(),
        resolveAssetPath: (p) => vaultManager.resolveAssetPath(p),
        onChanged: (cb) => {
          this.vaultChangeCallbacks.push(cb);
          return track(() => removeItem(this.vaultChangeCallbacks, cb));
        },
        pickSavePath: (suggestedName) => vaultManager.pickSavePath(suggestedName),
      },
      appConfig: { get: () => appConfig.get() },
      config: {
        get: <T>(key: string) => this.configStore.get<T>(id, key),
        set: <T>(key: string, value: T) => this.configStore.set(id, key, value),
      },
      save: {
        onNoteSaved: (hook) => track(this.save.onNoteSaved(hook)),
      },
      search: {
        registerSectionSearch: (provider) => track(this.search.registerSectionSearch(provider)),
      },
      llm: {
        enabled: () => actionRunner.isLlmEnabled(),
        chat: (messages, options) =>
          llmTasks.run(options?.taskId, (signal) =>
            lmStudio.chat([...messages], { temperature: options?.temperature, signal }),
          ),
        actionsForEvent: (event) =>
          actionRunner.actionsForEvent(event).map((a) => ({
            triggerId: a.triggerId,
            confirm: a.confirm,
          })),
        runAction: (triggerId, context, taskId) => actionRunner.run(triggerId, context, taskId),
        suggestTags: (entryText, vocabulary, taskId) =>
          actionRunner.suggestTags(entryText, [...vocabulary], taskId),
        onDebugEntry: (cb) => track(llmDebug.onEntry(cb)),
      },
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
