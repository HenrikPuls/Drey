import { Injectable, inject } from '@angular/core';
import type {
  AskOutcome,
  DocumentChangeEvent,
  DreyPluginApi,
  MenuContribution,
  PluginCommand,
  PluginDescriptorForRenderer,
  PluginDocKindContrib,
  PluginSettingsPageContrib,
  PluginWidgetContrib,
  RewriteRequest,
  Unsubscribe,
} from '../../../shared/plugin-api/renderer';
import { DockService } from '../dock/dock.service';
import { WidgetRegistryService } from '../dock/widget-registry.service';
import { SettingsCategoryRegistry } from '../settings/settings-registry.service';
import { ConfirmationService } from '../llm/confirmation.service';
import { KeybindingService } from '../keybindings';
import { EditTargetService } from '../services/edit-target.service';
import { EditorService } from '../services/editor.service';
import { LogService } from '../services/log.service';
import { OverlayGuardService } from '../services/overlay-guard.service';
import { SettingsService } from '../services/settings.service';

/** Listener channels the host service backs with its own `effect()`s. */
export interface PluginApiContext {
  addDocumentListener(listener: (event: DocumentChangeEvent) => void): Unsubscribe;
  addBackendListener(event: string, listener: (data: unknown) => void): Unsubscribe;
  addVisibilityListener(listener: (hidden: boolean) => void): Unsubscribe;
}

/**
 * Builds one plugin's `DreyPluginApi` (ADR-0044). Everything a plugin can
 * reach is funnelled through the base services here — a plugin never gets a
 * service reference, only this async/callback surface.
 *
 * Stage-1 note (honest scaffolding, per the conversion plan): the surfaces
 * whose base seams land with a later stage — the editor-extension /
 * doc-kind / menu / composer registries (stages 2, 3 and 8) — throw a clear
 * "not yet available" error instead of silently doing nothing, so a plugin
 * that reaches for one fails loudly at its own call site.
 */
@Injectable({ providedIn: 'root' })
export class PluginApiFactory {
  private readonly editor = inject(EditorService);
  private readonly editTarget = inject(EditTargetService);
  private readonly keys = inject(KeybindingService);
  private readonly widgets = inject(WidgetRegistryService);
  private readonly settingsPages = inject(SettingsCategoryRegistry);
  private readonly dock = inject(DockService);
  private readonly confirm = inject(ConfirmationService);
  private readonly settings = inject(SettingsService);
  private readonly overlayGuard = inject(OverlayGuardService);
  private readonly log = inject(LogService);

  create(
    plugin: PluginDescriptorForRenderer,
    context: PluginApiContext,
  ): { api: DreyPluginApi; disposables: Unsubscribe[] } {
    const disposables: Unsubscribe[] = [];
    const track = (unsubscribe: unknown): Unsubscribe => {
      if (typeof unsubscribe === 'function') {
        disposables.push(unsubscribe as Unsubscribe);
      }
      return unsubscribe as Unsubscribe;
    };
    const pluginId = plugin.id;
    const invokeBackend = (method: string, payload?: unknown): Promise<unknown> =>
      window.dreyApi.invokePlugin(pluginId, method, payload);

    const notYet = (what: string): never => {
      throw new Error(`${what} is not available in this build (planned stage not reached yet)`);
    };

    const toOpenDoc = (doc: {
      path: string;
      name: string;
      kind: string;
      savedContent: string;
      bufferContent: string;
    }) => ({
      path: doc.path,
      name: doc.name,
      kind: doc.kind,
      dirty: doc.savedContent !== doc.bufferContent,
      buffer: doc.bufferContent,
      saved: doc.savedContent,
    });

    const api: DreyPluginApi = {
      pluginId,
      manifest: plugin.manifest,
      documents: {
        active: () => {
          const path = this.editor.activePath();
          const doc = path === null ? null : this.editor.docFor(path);
          if (doc === null) {
            return null;
          }
          return { ...toOpenDoc(doc), selection: this.selection() };
        },
        get: (path) => {
          const doc = this.editor.docFor(path);
          return doc === null ? null : toOpenDoc(doc);
        },
        list: () => this.editor.openDocs().map(toOpenDoc),
        open: (path, line) => {
          if (line === undefined) {
            return this.editor.openFile(path);
          }
          return this.editor.openFileAt(path, line);
        },
        openScratch: (path, content) => this.editor.openScratch(path, content),
        insertAtCursor: (text) => {
          if (text === '' || this.editor.activePath() === null || this.editor.activeKind() !== 'text') {
            return false;
          }
          this.editor.requestInsertText(text);
          return true;
        },
        setBuffer: (path, content) => {
          const exists = this.editor.openDocs().some((d) => d.path === path && d.kind === 'text');
          if (exists) {
            this.editor.updateBuffer(path, content);
          }
          return exists;
        },
        save: (path, options) =>
          this.editor.save({
            ...(path !== undefined ? { path } : {}),
            ...(options?.runOnSaveActions !== undefined
              ? { runOnSaveActions: options.runOnSaveActions }
              : {}),
          }),
        requestRewrite: async (request: RewriteRequest) => {
          const confirmed = await this.confirm.request({
            title: request.title,
            ...(request.summary !== undefined ? { summary: request.summary } : {}),
            previewStyle: request.previewStyle,
            before: request.before,
            after: request.after,
            triggerId: null,
          });
          if (!confirmed) {
            return false;
          }
          await this.editor.applyRewrite(request.path, request.after);
          return true;
        },
        selection: () => this.selection(),
        onChange: (listener) => track(context.addDocumentListener(listener)),
      },
      vault: {
        readFile: (path) => window.dreyApi.readVaultFile(path),
        writeFile: (path, content) => window.dreyApi.writeVaultFile(path, content),
        listFiles: () => window.dreyApi.listVaultFiles(),
        onChanged: (listener) => track(window.dreyApi.onVaultChanged(listener)),
      },
      commands: {
        register: (command: PluginCommand) => {
          this.keys.register(command);
          return track(() => {
            // The keybinding registry has no removal; disabling replaces the
            // command with an inert one so the id can't be invoked.
            this.keys.register({ id: command.id, label: command.label, run: () => {} });
          });
        },
        run: (id) => this.keys.run(id),
      },
      ui: {
        registerWidget: (widget: PluginWidgetContrib) => track(this.widgets.registerPluginWidget(widget)),
        registerSettingsPage: (page: PluginSettingsPageContrib) =>
          track(this.settingsPages.registerPluginPage(page)),
        registerDocKind: (_kind: PluginDocKindContrib) => notYet('ui.registerDocKind'),
        registerMenuContributions: (_items: readonly MenuContribution[]) =>
          notYet('ui.registerMenuContributions'),
        registerComposerContribution: (_mount: (el: HTMLElement) => () => void) =>
          notYet('ui.registerComposerContribution'),
        revealWidget: (id) => this.dock.openAndExpand(id),
        showModal: (mount) => {
          // Minimal v1: a centred overlay above everything, holding an
          // OverlayGuard so native surfaces yield while it is open.
          const release = this.overlayGuard.acquire();
          const backdrop = document.createElement('div');
          backdrop.className = 'plugin-modal-backdrop';
          const box = document.createElement('div');
          box.className = 'plugin-modal';
          backdrop.appendChild(box);
          let dispose: (() => void) | undefined;
          try {
            dispose = mount(box) ?? undefined;
          } catch (error) {
            this.log.record('error', `plugin "${pluginId}" modal mount failed: ${String(error)}`);
          }
          document.body.appendChild(backdrop);
          const teardown = (): void => {
            try {
              dispose?.();
            } catch (error) {
              this.log.record('error', `plugin "${pluginId}" modal dispose failed: ${String(error)}`);
            }
            backdrop.remove();
            release();
          };
          // A plugin modal has no close affordance of its own: backdrop
          // click dismisses, and `track` also cleans it up on deactivate.
          backdrop.addEventListener('mousedown', teardown);
          track(teardown);
        },
      },
      editor: {
        get cm(): never {
          return notYet('editor.cm');
        },
        registerExtension: () => notYet('editor.registerExtension'),
        registerDropDecoder: () => notYet('editor.registerDropDecoder'),
        registerContextMenuItems: () => notYet('editor.registerContextMenuItems'),
      },
      search: {
        vocabulary: () => window.dreyApi.listTags(),
        searchSections: (query) => window.dreyApi.searchTags(query),
      },
      settings: {
        get: async <T>(key: string) => (await invokeBackend('drey.config.get', { key })) as
          | T
          | undefined,
        set: async <T>(key: string, value: T) => {
          await invokeBackend('drey.config.set', { key, value });
        },
      },
      appConfig: {
        get: () => window.dreyApi.getConfig(),
        patch: async (partial) => {
          const current = await window.dreyApi.getConfig();
          await window.dreyApi.setConfig({ ...current, ...partial });
        },
      },
      backend: {
        invoke: (method, payload) => invokeBackend(method, payload),
        on: (event, listener) => track(context.addBackendListener(event, listener)),
      },
      llm: {
        // Always present; `enabled()` reads the live persisted config. The
        // main-side facade rejects anyway when the switch is off, so a
        // plugin never needs a null-check to bind to the surface.
        enabled: () => this.settings.config()?.llm.enabled ?? false,
        chat: async (messages, options) =>
          (await invokeBackend('drey.llm.chat', {
            messages,
            temperature: options?.temperature,
            taskId: options?.taskId,
          })) as string,
        ask: async (context, question, taskId) =>
          (await invokeBackend('drey.llm.ask', { context, question, taskId })) as AskOutcome,
        runAction: async (triggerId, context, taskId) =>
          await window.dreyApi.runAction(triggerId, context, taskId),
        cancelTask: (taskId) => window.dreyApi.cancelLlmTask(taskId),
        onDebugEntry: (listener) => track(window.dreyApi.onLlmDebugEntry(listener)),
      },
      env: {
        onNativeSurfaceVisibility: (listener) => track(context.addVisibilityListener(listener)),
        appVersion: async () => (await window.dreyApi.getAppInfo()).appVersion,
      },
    };

    return { api, disposables };
  }

  /** The focused editor surface's selection, or null when there is none. */
  private selection(): { from: number; to: number; text: string } | null {
    const view = this.editTarget.view;
    if (view === null) {
      return null;
    }
    const range = view.state.selection.main;
    return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) };
  }
}
