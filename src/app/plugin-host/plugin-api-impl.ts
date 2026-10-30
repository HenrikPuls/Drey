import { Injectable, Injector, inject } from '@angular/core';
import type {
  DocumentChangeEvent,
  DreyPluginApi,
  InlineSegment,
  MenuContribution,
  PluginCommand,
  PluginDescriptorForRenderer,
  PluginDocKindContrib,
  PluginSettingsPageContrib,
  PluginWidgetContrib,
  RewriteRequest,
  Unsubscribe,
  TagEntry,
  TagSearchHit,
  LlmModelListing,
  LlmCapabilities,
} from '../../../shared/plugin-api/renderer';
import { DockService } from '../dock/dock.service';
import { WidgetRegistryService } from '../dock/widget-registry.service';
import { SettingsCategoryRegistry } from '../settings/settings-registry.service';
import { ConfirmationService } from '../llm/confirmation.service';
import { KeybindingService } from '../keybindings';
import { createIconElement } from '../icons/icon';
import { TagField } from '../tags/tag-field';
import { TagVocabularyService } from '../tags/tag-vocabulary.service';
import { EditTargetService } from '../services/edit-target.service';
import { EditorService } from '../services/editor.service';
import { ConfirmDialogService } from '../services/confirm-dialog.service';
import { FileDecorationService } from '../services/file-decoration.service';
import { FilesCommandsService } from '../services/files-commands.service';
import { FilesOperationsRegistryService } from '../services/files-operations-registry.service';
import { DiffDialogService } from '../diff-view';
import { LogService } from '../services/log.service';
import { OverlayGuardService } from '../services/overlay-guard.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../vault/vault.service';
import { WikilinkService } from '../editor/wikilinks/wikilink.service';
import { extractWikilinks } from '../editor/wikilinks/wikilink';
import { HOST_CODEMIRROR } from './runtime-exports';
import { highlightCode } from './code-highlight';
import { mountMarkdownView } from './markdown-view';
import { dreyHighlightStyle } from '../editor/editor-theme';
import type { HighlightStyle } from '@codemirror/language';
import { ThemeService } from '../services/theme.service';
import { EditorExtensionRegistry } from './editor-extension-registry.service';
import { DropDecoderRegistry } from './drop-decoder-registry.service';
import { FrontmatterViewRegistry } from './frontmatter-view-registry.service';
import { FileOpenerRegistry } from '../services/file-opener-registry.service';
import { DocKindRegistry } from './doc-kind-registry.service';
import { PluginSettingsHost } from './plugin-settings-host';
import {
  EditorContextMenuRegistry,
  MenuContributionsService,
  ToolbarContributionsService,
} from './menu-contributions.service';

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
 * whose base seams land with a later stage — the composer-contribution slot
 * is the last one standing (the editor-extension / doc-kind / menu
 * registries landed with stages 2, 3 and 8A) — throw a clear "not yet
 * available" error instead of silently doing nothing, so a plugin that
 * reaches for one fails loudly at its own call site.
 */
@Injectable({ providedIn: 'root' })
export class PluginApiFactory {
  private readonly editor = inject(EditorService);
  private readonly editTarget = inject(EditTargetService);
  private readonly keys = inject(KeybindingService);
  private readonly widgets = inject(WidgetRegistryService);
  private readonly settingsPages = inject(SettingsCategoryRegistry);
  private readonly confirm = inject(ConfirmationService);
  private readonly dialogs = inject(ConfirmDialogService);
  private readonly settings = inject(SettingsService);
  private readonly themeService = inject(ThemeService);
  private readonly overlayGuard = inject(OverlayGuardService);
  private readonly extensions = inject(EditorExtensionRegistry);
  private readonly dropDecoders = inject(DropDecoderRegistry);
  private readonly frontmatterViews = inject(FrontmatterViewRegistry);
  private readonly fileOpeners = inject(FileOpenerRegistry);
  private readonly docKinds = inject(DocKindRegistry);
  private readonly menuContributions = inject(MenuContributionsService);
  private readonly contextMenuItems = inject(EditorContextMenuRegistry);
  private readonly toolbarButtons = inject(ToolbarContributionsService);
  private readonly log = inject(LogService);
  private readonly decorations = inject(FileDecorationService);
  private readonly filesOperations = inject(FilesOperationsRegistryService);
  private readonly filesCommands = inject(FilesCommandsService);
  private readonly diffDialog = inject(DiffDialogService);
  /**
   * Resolves services at call time instead of at construction
   * (`TagVocabularyService` — its first vocabulary pull waits for the
   * first tag field — `WikilinkService`, `VaultService`).
   */
  private readonly appInjector = inject(Injector);

  /**
   * DockService, resolved on FIRST USE, not at construction: the factory is
   * built during the app initializer (bootstrap gating, ADR-0044), and an
   * eager inject here would construct `DockService` BEFORE the plugin
   * widgets have registered — its constructor then folds the persisted
   * layout onto an incomplete registry, dropping every plugin panel's
   * stored slot/collapse state (absorbRegistry re-adds the widgets at
   * defaults and persists the clobber). First use is a plugin's
   * `revealWidget()`, long after bootstrap, when the registry is complete.
   */
  private readonly injector = inject(Injector);
  private dockRef: DockService | null = null;
  private get dock(): DockService {
    return (this.dockRef ??= this.injector.get(DockService));
  }

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
    // A deactivated or quarantined plugin leaves no decorations or Files
    // seam registrations behind.
    disposables.push(() => this.decorations.clear(pluginId));
    disposables.push(() => this.filesOperations.clear(pluginId));
    disposables.push(() => this.filesCommands.clear(pluginId));
    const invokeBackend = (method: string, payload?: unknown): Promise<unknown> =>
      window.dreyApi.invokePlugin(pluginId, method, payload).catch((error: unknown) => {
        // Electron wraps a handler throw into "Error invoking remote method
        // '<channel>': Error: <original>" — plugins surface err.message to
        // users, so unwrap the wrapper before it reaches them.
        if (error instanceof Error) {
          const cleaned = error.message.replace(
            /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
            '',
          );
          if (cleaned !== error.message) {
            throw new Error(cleaned);
          }
        }
        throw error;
      });

    const toOpenDoc = (doc: {
      vaultId: string | null;
      path: string;
      name: string;
      kind: string;
      savedContent: string;
      bufferContent: string;
    }) => ({
      vaultId: doc.vaultId,
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
          const doc = this.editor.resolveDoc(path);
          return doc === null ? null : toOpenDoc(doc);
        },
        list: () => this.editor.openDocs().map(toOpenDoc),
        open: (path, line, opts) => {
          if (line === undefined) {
            return this.editor.openFile(path, opts?.vaultId);
          }
          return this.editor.openFileAt(path, line, opts?.vaultId);
        },
        openScratch: (path, content) => this.editor.openScratch(path, content),
        addDoc: (kind, key, name) => {
          // A clear failure at the plugin's own call site beats a tab that
          // renders the "kind not available" empty state (ADR-0044).
          if (this.docKinds.get(kind) === undefined) {
            throw new Error(`documents.addDoc: doc kind "${kind}" is not registered`);
          }
          this.editor.addPluginDoc(kind, key, name);
        },
        registerFileOpener: (opener) => track(this.fileOpeners.register(opener)),
        rename: (path, name) => this.editor.renameDoc(path, name),
        insertAtCursor: (text) => {
          if (text === '' || this.editor.activePath() === null || this.editor.activeKind() !== 'text') {
            return false;
          }
          this.editor.requestInsertText(text);
          return true;
        },
        setBuffer: (path, content) => {
          const doc = this.editor.resolveDoc(path);
          if (doc !== null && doc.kind === 'text') {
            this.editor.updateBuffer(doc.key, content);
            return true;
          }
          return false;
        },
        setEditLock: (path, locked) => {
          const doc = this.editor.resolveDoc(path);
          if (doc !== null && doc.kind === 'text') {
            this.editor.setEditLock(doc.key, locked);
            return true;
          }
          return false;
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
            // The trigger binding enables the dialog's "don't ask again for
            // this action" checkbox (ADR-0011); null hides it.
            triggerId: request.triggerId ?? null,
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
        listVaults: () => window.dreyApi.listVaults(),
        readFile: (path, opts) => window.dreyApi.readVaultFile(path, opts?.vaultId),
        writeFile: (path, content, opts) =>
          window.dreyApi.writeVaultFile(
            path,
            content,
            opts?.vaultId,
            opts?.announce === true ? { announce: true } : undefined,
          ),
        readBinary: (path, opts) => window.dreyApi.readVaultBinary(path, opts?.vaultId),
        writeBinary: (path, bytes, opts) =>
          window.dreyApi.writeVaultBinary(
            path,
            bytes,
            opts?.vaultId,
            opts?.announce === true ? { announce: true } : undefined,
          ),
        saveAsset: (bytes, ext, noteRelPath, opts) =>
          invokeBackend('drey.vault.saveAsset', {
            bytes,
            ext,
            noteRelPath,
            ...(opts?.vaultId !== undefined ? { vaultId: opts.vaultId } : {}),
          }) as Promise<string>,
        listFiles: (opts) => window.dreyApi.listVaultFiles(opts?.vaultId),
        onChanged: (listener) =>
          track(
            window.dreyApi.onVaultChanged(() => {
              // The plugins will react -- refresh the dock's plugin statuses.
              this.widgets.bumpStatusTick();
              listener();
            }),
          ),
      },
      files: {
        registerOperations: (handler) => track(this.filesOperations.register(pluginId, handler)),
        registerContextMenuItems: (items) =>
          track(this.filesCommands.register(pluginId, items)),
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
        run: (id, payload) => this.keys.run(id, payload),
      },
      ui: {
        registerWidget: (widget: PluginWidgetContrib) => track(this.widgets.registerPluginWidget(widget)),
        registerSettingsPage: (page: PluginSettingsPageContrib) =>
          track(this.settingsPages.registerPluginPage(page, PluginSettingsHost)),
        registerDocKind: (kind: PluginDocKindContrib) => track(this.docKinds.register(kind)),
        registerMenuContributions: (items: readonly MenuContribution[]) =>
          track(this.menuContributions.register(pluginId, items)),
        // The "Add entry" drawer it mounted into is gone (milestone 43,
        // ADR-0057); the call is accepted and ignored so plugins keep loading.
        registerComposerContribution: (_mount: (el: HTMLElement) => () => void) => () => undefined,
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
          let closed = false;
          const teardown = (): void => {
            if (closed) {
              return;
            }
            closed = true;
            backdrop.remove();
            release();
          };
          try {
            mount(box);
          } catch (error) {
            this.log.record('error', `plugin "${pluginId}" modal mount failed: ${String(error)}`);
          }
          document.body.appendChild(backdrop);
          // Backdrop click dismisses; the returned close() lets the plugin
          // close it programmatically (picker Enter/Esc). The guard matters:
          // the box is a CHILD of the backdrop, so without the target check
          // every mousedown inside the modal (labels, padding, row gaps)
          // would bubble up and tear the overlay down mid-press — and
          // because that happens before the browser synthesizes `click`,
          // row clicks would be swallowed too (removed subtree = no click).
          backdrop.addEventListener('mousedown', (event) => {
            if (event.target !== backdrop) {
              return;
            }
            teardown();
          });
          track(teardown);
          return teardown;
        },
        showMessage: (message, title) => this.dialogs.message({ message, title }),
        createTagField: (opts) => {
          // Same component the base entry drawer mounts (milestone 33):
          // vocabulary + prefix colors come from the base tag vocabulary
          // service, so plugin panels and base surfaces always agree.
          const field = new TagField(this.appInjector.get(TagVocabularyService), {
            values: opts.values ?? [],
            onChange: opts.onChange,
            ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
            ...(opts.ariaLabel !== undefined ? { ariaLabel: opts.ariaLabel } : {}),
            ...(opts.completions !== undefined ? { completions: opts.completions } : {}),
            ...(opts.freeText !== undefined ? { freeText: opts.freeText } : {}),
          });
          return field;
        },
        createMarkdownView: (opts) => mountMarkdownView(this.appInjector, opts),
        highlightCode: async (code, lang) =>
          highlightCode(code, lang, await this.codeHighlightStyle()),
        icon: (name, size) => createIconElement(name, size),
        setFileDecorations: (vaultId, decorations) =>
          this.decorations.set(pluginId, vaultId, decorations),
        showDiff: (request) => this.diffDialog.show(request),
      },
      editor: {
        cm: HOST_CODEMIRROR,
        registerExtension: (slot, factory) =>
          track(this.extensions.register(pluginId, slot, factory)),
        registerDropDecoder: (decoder) => track(this.dropDecoders.register(decoder)),
        registerContextMenuItems: (items) => track(this.contextMenuItems.register(items)),
        registerToolbarButtons: (buttons) => track(this.toolbarButtons.register(buttons)),
        registerFrontmatterView: (view) => track(this.frontmatterViews.register(pluginId, view)),
      },
      search: {
        // Routed through the host's reserved methods so the surface reads
        // whichever plugin registered the section-search provider. `scope`
        // (ADR-0051) defaults to the active vault main-side.
        vocabulary: () => invokeBackend('drey.search.vocabulary') as Promise<readonly TagEntry[]>,
        searchSections: (query, scope) =>
          invokeBackend('drey.search.sections', {
            query,
            ...(scope !== undefined ? { scope } : {}),
          }) as Promise<readonly TagSearchHit[]>,
      },
      links: {
        // Base-owned grammar + resolver (SDK 1.11): plugins render
        // wikilinks without carrying a copy of either. The services are
        // resolved lazily — WikilinkService → VaultService/EditorService
        // sits outside this factory's constructor closure (same pattern
        // as createTagField).
        parseInline: (text) => {
          const segments: InlineSegment[] = [];
          let cursor = 0;
          for (const link of extractWikilinks(text)) {
            if (link.index > cursor) {
              segments.push({ kind: 'text', text: text.slice(cursor, link.index) });
            }
            segments.push({
              kind: 'wikilink',
              target: link.target,
              anchor: link.anchor,
              alias: link.alias,
            });
            cursor = link.index + link.length;
          }
          if (cursor < text.length) {
            segments.push({ kind: 'text', text: text.slice(cursor) });
          }
          return segments;
        },
        resolve: (target, fromVaultId) => {
          const links = this.appInjector.get(WikilinkService);
          const from = fromVaultId ?? this.appInjector.get(VaultService).activeVaultId();
          if (from === null) {
            return null;
          }
          const path = links.resolve(target, from, null);
          return path === null ? null : { vaultId: from, path };
        },
        open: (target, anchor, fromVaultId) => {
          const links = this.appInjector.get(WikilinkService);
          // Editor semantics (SDK 1.11): unresolved → create-and-open in
          // the context vault. `fromPath` stays null — a chat has no
          // linking note, so sibling preference cannot apply.
          return links.open(target, anchor ?? null, fromVaultId ?? this.appInjector.get(VaultService).activeVaultId(), null);
        },
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
            vaultTools: options?.vaultTools,
          })) as string,
        listModels: () =>
          invokeBackend('drey.llm.listModels') as Promise<LlmModelListing>,
        capabilities: () => invokeBackend('drey.llm.capabilities') as Promise<LlmCapabilities>,
        cancelTask: (taskId) => window.dreyApi.cancelLlmTask(taskId),
        onDebugEntry: (listener) => track(window.dreyApi.onLlmDebugEntry(listener)),
        onDelta: (listener) => track(window.dreyApi.onLlmDelta(listener)),
        onCapabilitiesChanged: (listener) =>
          track(window.dreyApi.onLlmCapabilitiesChanged(listener)),
      },
      env: {
        onNativeSurfaceVisibility: (listener) => track(context.addVisibilityListener(listener)),
        appVersion: async () => (await window.dreyApi.getAppInfo()).appVersion,
      },
    };

    return { api, disposables };
  }

  /** The focused editor surface's selection, or null when there is none. */
  /** The highlight style of the active theme: Cyberpunk's own, the Drey token style otherwise. */
  private async codeHighlightStyle(): Promise<HighlightStyle> {
    if (this.themeService.theme().id === 'cyberpunk') {
      return (await import('../editor/themes/cyberpunk-look')).cyberpunkHighlightStyle;
    }
    return dreyHighlightStyle;
  }

  private selection(): { from: number; to: number; text: string } | null {
    const view = this.editTarget.view;
    if (view === null) {
      return null;
    }
    const range = view.state.selection.main;
    return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) };
  }
}
