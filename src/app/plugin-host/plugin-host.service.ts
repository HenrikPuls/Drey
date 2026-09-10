import { Injectable, effect, inject, signal } from '@angular/core';
import type {
  DocumentChangeEvent,
  PluginDescriptorForRenderer,
  PluginRendererModule,
  Unsubscribe,
} from '../../../shared/plugin-api/renderer';
import { EditorService } from '../services/editor.service';
import { LayoutGestureService } from '../services/layout-gesture.service';
import { LogService } from '../services/log.service';
import { OverlayGuardService } from '../services/overlay-guard.service';
import { PluginApiFactory } from './plugin-api-impl';
import { PLUGIN_MODULE_LOADER, moduleDefault } from './plugin-module-loader';

/** How long buffer edits coalesce before a `buffer-changed` event fires. */
const BUFFER_DEBOUNCE_MS = 150;

interface ActivatedRendererPlugin {
  readonly descriptor: PluginDescriptorForRenderer;
  module: PluginRendererModule | null;
  readonly disposables: Unsubscribe[];
  readonly documentListeners: Set<(event: DocumentChangeEvent) => void>;
  readonly backendListeners: Map<string, Set<(data: unknown) => void>>;
  readonly visibilityListeners: Set<(hidden: boolean) => void>;
}

/**
 * The renderer plugin host (ADR-0044): loads each active plugin's renderer
 * entry (after the main process has already activated its main entry),
 * hands it a `DreyPluginApi`, and fans the host's pushes (plugin events,
 * document changes, native-surface visibility) out to it.
 *
 * `loadAll()` runs from `provideAppInitializer`, gating Angular bootstrap:
 * widget / settings-page registrations must be complete before
 * `DockService` builds its state, the menus derive their rows, or session
 * restore needs a plugin doc kind.
 *
 * Failure model: a plugin whose module fails to load or whose `activate`
 * throws is quarantined (`status: 'failed'` in the `plugins` signal, shown
 * in Settings) — the app and every other plugin continue.
 */
@Injectable({ providedIn: 'root' })
export class PluginHostService {
  private readonly loader = inject(PLUGIN_MODULE_LOADER);
  private readonly apiFactory = inject(PluginApiFactory);
  private readonly editor = inject(EditorService);
  private readonly overlay = inject(OverlayGuardService);
  private readonly layoutGesture = inject(LayoutGestureService);
  private readonly log = inject(LogService);

  /** Every discovered plugin with its status; the Settings plugin pane reads this. */
  readonly plugins = signal<readonly PluginDescriptorForRenderer[]>([]);
  /** True once `loadAll()` finished (successfully or not) — session restore waits for it. */
  readonly loaded = signal(false);

  private readonly activated = new Map<string, ActivatedRendererPlugin>();

  constructor() {
    // The single subscription to the fixed push channel, fanned out per plugin.
    window.dreyApi.onPluginEvent((payload) =>
      this.handlePluginEvent(payload.pluginId, payload.event, payload.data),
    );

    this.synthesizeDocumentEvents();
    this.synthesizeVisibilityEvents();
  }

  /** Loads + activates every enabled plugin's renderer entry. Runs once. */
  async loadAll(): Promise<void> {
    if (this.loaded()) {
      return;
    }
    let descriptors: PluginDescriptorForRenderer[];
    try {
      descriptors = await window.dreyApi.listPlugins();
    } catch (error) {
      this.log.record('error', `plugin host: listPlugins failed: ${String(error)}`);
      this.loaded.set(true);
      return;
    }
    this.plugins.set(descriptors);

    for (const descriptor of descriptors) {
      if (descriptor.status !== 'active' || descriptor.rendererUrl === undefined) {
        continue;
      }
      await this.activate(descriptor);
      this.injectStyles(descriptor);
    }
    this.loaded.set(true);
  }

  /** Renderer-side teardown (unsubscribes + module deactivate). Restart-to-apply covers main. */
  async deactivateAll(): Promise<void> {
    for (const [id, plugin] of this.activated) {
      for (const dispose of plugin.disposables.splice(0)) {
        this.guarded(dispose, `${id} disposable`);
      }
      if (plugin.module?.deactivate !== undefined) {
        try {
          await plugin.module.deactivate();
        } catch (error) {
          this.log.record('error', `plugin "${id}" deactivate failed: ${String(error)}`);
        }
      }
    }
    this.activated.clear();
  }

  // -- activation ----------------------------------------------------------

  private async activate(descriptor: PluginDescriptorForRenderer): Promise<void> {
    const plugin: ActivatedRendererPlugin = {
      descriptor,
      module: null,
      disposables: [],
      documentListeners: new Set(),
      backendListeners: new Map(),
      visibilityListeners: new Set(),
    };
    this.activated.set(descriptor.id, plugin);

    const { api, disposables } = this.apiFactory.create(descriptor, {
      addDocumentListener: (listener) => {
        plugin.documentListeners.add(listener);
        return () => plugin.documentListeners.delete(listener);
      },
      addBackendListener: (event, listener) => {
        const listeners = plugin.backendListeners.get(event) ?? new Set();
        listeners.add(listener);
        plugin.backendListeners.set(event, listeners);
        return () => listeners.delete(listener);
      },
      addVisibilityListener: (listener) => {
        plugin.visibilityListeners.add(listener);
        return () => plugin.visibilityListeners.delete(listener);
      },
    });
    plugin.disposables.push(...disposables);

    try {
      const imported = await this.loader.load(descriptor.rendererUrl!);
      const module = moduleDefault(imported) as Partial<PluginRendererModule> | null;
      if (module === null || typeof module !== 'object' || typeof module.activate !== 'function') {
        throw new Error('renderer entry has no default-exported activate()');
      }
      plugin.module = module as PluginRendererModule;
      await plugin.module.activate(api);
    } catch (error) {
      // Quarantine: run whatever it registered, then flip the status so
      // Settings shows why. Everything else keeps running.
      for (const dispose of plugin.disposables.splice(0)) {
        this.guarded(dispose, `${descriptor.id} disposable`);
      }
      this.activated.delete(descriptor.id);
      this.plugins.update((list) =>
        list.map((p) => (p.id === descriptor.id ? { ...p, status: 'failed' as const, error: String(error) } : p)),
      );
      this.log.record('error', `plugin "${descriptor.id}" renderer activation failed: ${String(error)}`);
    }
  }

  private injectStyles(descriptor: PluginDescriptorForRenderer): void {
    for (const css of descriptor.css ?? []) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `plugin://${descriptor.id}/${css}`;
      link.dataset['dreyPlugin'] = descriptor.id;
      document.head.appendChild(link);
    }
  }

  // -- event fan-out -------------------------------------------------------

  /** Routes one `plugin:event` push to the owning plugin's listeners. */
  private handlePluginEvent(pluginId: string, event: string, data: unknown): void {
    const listeners = this.activated.get(pluginId)?.backendListeners.get(event);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners]) {
      this.guarded(() => listener(data), `${pluginId} event "${event}" listener`);
    }
  }

  // -- synthesized host events ----------------------------------------------

  /**
   * Document events from the `EditorService` signal graph. One effect per
   * event kind; each fires only when its own value changed.
   * `buffer-changed` is debounced per path — per-keystroke plugin callbacks
   * would make every plugin a perf hazard (ADR-0044). `pending-actions` is
   * deliberately NOT synthesized yet: the queue is drained by
   * `ActionsService`, and a second consumer would steal from it (stage 7
   * owns that handover).
   */
  private synthesizeDocumentEvents(): void {
    let lastPath = this.editor.activePath();
    let lastDirty: boolean | null = null;
    let lastPathsKey = this.pathKey();
    const bufferTimers = new Map<string, number>();

    effect(() => {
      const path = this.editor.activePath();
      if (path !== lastPath) {
        lastPath = path;
        this.emitDocumentEvent({ type: 'active-changed', path });
      }
      const pathsKey = this.pathKey();
      if (pathsKey !== lastPathsKey) {
        lastPathsKey = pathsKey;
        this.emitDocumentEvent({ type: 'docs-changed' });
      }
    });

    effect(() => {
      const path = this.editor.activePath();
      const content = this.editor.bufferContent();
      if (path === null) {
        return;
      }
      window.clearTimeout(bufferTimers.get(path));
      bufferTimers.set(
        path,
        window.setTimeout(() => {
          bufferTimers.delete(path);
          this.emitDocumentEvent({ type: 'buffer-changed', path, content });
        }, BUFFER_DEBOUNCE_MS),
      );
    });

    effect(() => {
      const path = this.editor.activePath();
      const dirty = this.editor.isDirty();
      if (path !== null && dirty !== lastDirty) {
        lastDirty = dirty;
        this.emitDocumentEvent({ type: 'dirty-changed', path, dirty });
      }
    });
  }

  private pathKey(): string {
    return this.editor
      .openDocs()
      .map((d) => d.path)
      .join('\n');
  }

  /** "Native surfaces must hide" — an overlay up or a layout gesture in flight. */
  private synthesizeVisibilityEvents(): void {
    let last: boolean | null = null;
    effect(() => {
      const hidden = this.overlay.suppressed() || this.layoutGesture.active();
      if (hidden !== last) {
        last = hidden;
        for (const plugin of this.activated.values()) {
          for (const listener of [...plugin.visibilityListeners]) {
            this.guarded(() => listener(hidden), 'visibility listener');
          }
        }
      }
    });
  }

  private emitDocumentEvent(event: DocumentChangeEvent): void {
    for (const plugin of this.activated.values()) {
      for (const listener of [...plugin.documentListeners]) {
        this.guarded(() => listener(event), 'document listener');
      }
    }
  }

  private guarded(fn: () => void, what: string): void {
    try {
      fn();
    } catch (error) {
      this.log.record('error', `plugin ${what} failed: ${String(error)}`);
    }
  }
}
