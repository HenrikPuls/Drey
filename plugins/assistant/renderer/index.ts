import type {
  ActionOutcome,
  DreyPluginApi,
  MenuContribution,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import type { AppConfig } from '../../../shared/app-config';
import type { AssistantOutcome } from '../shared/ask';
import type { ChatNoteView, ChatSummary } from '../shared/chat-note';
import { resolveActions } from '../../../shared/llm/actions';
import { mountPanel, type PanelHandle } from './panel.js';
import { createRunningTasks } from './running-tasks.js';
import { createAssistantState, type AssistantPorts } from './state.js';
import {
  actionsSettingsPage,
  retrievalSettingsPage,
  SELECTION_BUTTON_SETTING,
} from './settings-pages.js';
import { promptEntriesFrom, promptsDirFor } from './prompts.js';
import { createSelectionButton } from './selection-button.js';
import { closeSelectionPopover, openSelectionPopover } from './selection-popover.js';
import { createVaultFileCache } from './vault-files.js';

/**
 * The Assistant plugin's renderer (ADR-0044 stage 7): the assistant dock
 * panel (cards + composer), the Actions Settings page, the manual Actions
 * as `⋯`-menu rows, and the pending-actions drain — on-save Action
 * outcomes arrive as a `pending-actions` document event and go through the
 * shared confirmation dialog. Since milestone 74 also the assistant button
 * at an editor selection and its popover. The panel reuses the built-in widget id
 * `assistant` so every persisted dock layout and the `widgets.disabled`
 * list survive the conversion (ADR-0044 rule 5).
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    // The live app config, cached for the manual-action rows.
    let appConfigCache: AppConfig | undefined;
    const refreshConfig = async (): Promise<void> => {
      appConfigCache = await api.appConfig.get();
      refreshActionRows();
    };

    // -- ports + state ---------------------------------------------------------
    const tasks = createRunningTasks((taskId) => api.llm.cancelTask(taskId));

    const ports: AssistantPorts = {
      // -- chat notes (ADR-0048) ----------------------------------------------
      listChats: () => api.backend.invoke('chat:list') as Promise<ChatSummary[]>,
      readChat: (path) => api.backend.invoke('chat:read', { path }) as Promise<ChatNoteView>,
      ask: (request, taskId) =>
        api.backend.invoke('ask', { ...request, taskId }) as Promise<{
          chatPath: string;
          outcome: AssistantOutcome;
          contextCount: number;
          contextError?: string;
        }>,
      appendEdit: (path, applied, after) =>
        api.backend.invoke('chat:appendEdit', { path, applied, after }) as Promise<void>,
      truncate: (path, turnIndex) =>
        api.backend.invoke('chat:truncate', { path, turnIndex }) as Promise<void>,
      attachExternal: (referenceNote) =>
        api.backend.invoke('chat:attachExternal', { referenceNote }) as Promise<{
          staged: { path: string; kind: 'file' | 'image' }[];
          skipped: string[];
        }>,
      onDelta: (listener) =>
        api.backend.on('chat:delta', (data) => {
          const shape = (data ?? {}) as { taskId?: unknown; text?: unknown };
          if (typeof shape.taskId === 'string' && typeof shape.text === 'string') {
            listener({ taskId: shape.taskId, text: shape.text });
          }
        }),
      onToolEvent: (listener) =>
        api.backend.on('chat:toolEvent', (data) => {
          const shape = (data ?? {}) as Record<string, unknown>;
          if (
            typeof shape['taskId'] === 'string' &&
            (shape['phase'] === 'start' || shape['phase'] === 'end') &&
            typeof shape['id'] === 'string' &&
            typeof shape['name'] === 'string'
          ) {
            listener({
              taskId: shape['taskId'],
              phase: shape['phase'],
              id: shape['id'],
              name: shape['name'],
              argsJson: typeof shape['argsJson'] === 'string' ? shape['argsJson'] : '{}',
              ...(typeof shape['ok'] === 'boolean' ? { ok: shape['ok'] } : {}),
            });
          }
        }),

      // -- shared -----------------------------------------------------------------
      readVaultFile: async (path) => {
        const open = api.documents.get(path);
        if (open !== null && open.kind === 'text') {
          return open.buffer;
        }
        try {
          return (await api.vault.readFile(path)).content;
        } catch {
          return null; // Gone from the vault (or unreadable).
        }
      },
      scratchBody: (docPath) => {
        const open = api.documents.get(docPath);
        return open !== null && open.kind === 'text' ? open.buffer : null;
      },
      // The snapshot lives in the hidden `.drafts/` scratch area (invisible
      // to the file tree and indexes), name derived from the tab so each
      // scratch source owns one file that later sends overwrite.
      writeScratchSnapshot: async (docPath, body) => {
        const open = api.documents.get(docPath);
        const base = docPath.split(/[\\/]/).pop() ?? 'untitled';
        const safe = (base.replace(/[^A-Za-z0-9._-]/g, '_') || 'untitled').replace(
          /\.md$/i,
          '',
        );
        const path = `.drafts/assistant/${open?.vaultId ?? 'scratch'}-${safe}.md`;
        await api.vault.writeFile(path, body);
        return path;
      },
      cancel: (taskId) => tasks.cancel(taskId),
      activeDoc: () => {
        const active = api.documents.active();
        return active !== null && active.kind === 'text'
          ? { path: active.path, body: active.buffer, vaultId: active.vaultId }
          : null;
      },
      llmEnabled: () => api.llm.enabled(),
      requestRewrite: (request) => api.documents.requestRewrite(request),
      setEditLock: (path, locked) => {
        api.documents.setEditLock(path, locked);
      },
      // The live daily root (chat decoupling, 57c); the normalized config
      // always carries the default when the field is absent.
      dailyDir: async () => {
        const config = await api.appConfig.get();
        return config.daily.dir;
      },
      listVaults: async () => {
        const list = await api.vault.listVaults();
        return list.map((vault) => ({
          id: vault.id,
          name: vault.name,
          active: vault.active === true,
        }));
      },
    };

    const state = createAssistantState(ports, tasks);
    // Vault writes elsewhere (or our own chat-note appends) stale the
    // picker cache; the lazy cache reloads on the next open. The same
    // round covers registry mutations (add/remove), so the Vault chip's
    // custom selection gets pruned when its vaults disappear.
    api.vault.onChanged(() => {
      state.invalidateChats();
      void state.refreshVaults();
    });

    // -- active-document tracking (chips) + the chat-note hydration rule:
    // the ONLY implicit switch is a focused chat-note tab (its Markdown
    // hydrates the panel); every other focus keeps the current chat, and
    // the very first follow loads the newest conversation (app start) ------
    /** The last doc key followActiveDoc was called with; undefined = never. */
    let lastFollowKey: string | null | undefined = undefined;
    const trackActive = (): void => {
      const active = api.documents.active();
      if (active !== null && active.kind === 'text') {
        void state.openNote(active.path);
      } else {
        state.closeNote();
      }
      const key =
        active !== null && active.kind === 'text' && active.vaultId !== null
          ? `${active.vaultId}::${active.path}`
          : null;
      if (key !== lastFollowKey) {
        lastFollowKey = key;
        void state.followActiveDoc(key);
      }
    };
    trackActive();

    // -- pending-actions drain (the on-save confirmations) ----------------------
    const drainPending = async (actions: readonly ActionOutcome[]): Promise<void> => {
      for (const outcome of actions) {
        if (outcome.kind === 'edit') {
          await api.documents.requestRewrite({
            path: outcome.path,
            before: outcome.before,
            after: outcome.after,
            title: outcome.name,
            summary: outcome.summary,
            previewStyle: outcome.previewStyle,
            triggerId: outcome.triggerId,
          });
        } else {
          state.reportActionOutcome(outcome);
        }
      }
    };

    api.documents.onChange((event) => {
      if (event.type === 'active-changed' || event.type === 'docs-changed') {
        trackActive();
        return;
      }
      if (event.type === 'pending-actions') {
        void drainPending(event.actions);
      }
    });

    // -- manual Actions as ⋯-menu rows (re-registered when actions change) ------
    let busy = false;
    let menuUnsubscribe: (() => void) | null = null;

    const refreshActionRows = (): void => {
      menuUnsubscribe?.();
      menuUnsubscribe = null;
      if (appConfigCache === undefined) {
        return;
      }
      const manual = resolveActions(appConfigCache).filter(
        (action) => action.enabled && action.event === 'manual',
      );
      if (manual.length === 0) {
        return;
      }
      const rows: MenuContribution[] = manual.map((action) => ({
        menu: 'editor-more' as const,
        label: action.name,
        run: () => {
          void runManualAction(action.triggerId);
        },
      }));
      menuUnsubscribe = api.ui.registerMenuContributions(rows);
    };

    const runManualAction = async (triggerId: string): Promise<void> => {
      const active = api.documents.active();
      if (busy || active === null || active.kind !== 'text') {
        return;
      }
      busy = true;
      try {
        const range = api.documents.selection();
        const outcome = (await api.backend.invoke('run', {
          triggerId,
          context: {
            path: active.path,
            body: active.buffer,
            ...(range !== null && range.from !== range.to ? { selection: range.text } : {}),
          },
        })) as ActionOutcome;
        if (outcome.kind === 'edit') {
          await api.documents.requestRewrite({
            path: outcome.path,
            before: outcome.before,
            after: outcome.after,
            title: outcome.name,
            summary: outcome.summary,
            previewStyle: outcome.previewStyle,
            triggerId,
          });
        } else {
          state.reportActionOutcome(outcome);
        }
      } catch (err) {
        state.reportActionOutcome({
          kind: 'error',
          triggerId,
          name: 'Action',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        busy = false;
      }
    };

    // -- the assistant button at a selection (milestone 74) ---------------------
    // On unless switched off; the stored value lands a moment after start.
    let selectionButtonOn = true;
    void api.settings.get<boolean>(SELECTION_BUTTON_SETTING).then((value) => {
      selectionButtonOn = value !== false;
    });
    const promptFiles = createVaultFileCache(api, '.md');

    const openForSelection = (): void => {
      const view = selectionButton.lastView();
      const active = api.documents.active();
      if (view === null || active === null || active.kind !== 'text') {
        return;
      }
      const range = view.state.selection.main;
      if (range.empty) {
        return;
      }
      const selection = view.state.sliceDoc(range.from, range.to);
      const coords = view.coordsAtPos(range.head);
      const actions =
        appConfigCache === undefined
          ? []
          : resolveActions(appConfigCache)
              .filter((action) => action.enabled && action.event === 'manual')
              .map((action) => ({ triggerId: action.triggerId, name: action.name }));
      const prompts = (async () =>
        promptEntriesFrom(
          await promptFiles.ensureLoaded(),
          (path) => api.vault.readFile(path).then((file) => file.content),
          promptsDirFor(appConfigCache?.templates.dir),
        ))();
      openSelectionPopover({
        anchor: coords ?? { left: 100, top: 100, bottom: 100 },
        prompts,
        actions,
        onAsk: (question) => {
          api.ui.revealWidget('assistant');
          void state.ask(question, { selection });
        },
        // The Action reads the selection itself (the editor keeps it while
        // the popover has the focus).
        onAction: (triggerId) => {
          void runManualAction(triggerId);
        },
        onDismiss: () => {
          view.focus();
        },
      });
    };

    const selectionButton = createSelectionButton(api.editor.cm, {
      enabled: () => selectionButtonOn && api.llm.enabled(),
      icon: () => api.ui.icon('sparkles', 14),
      open: () => {
        openForSelection();
      },
    });
    api.editor.registerExtension('document', () => selectionButton.extension());
    api.commands.register({
      id: 'assistant.askSelection',
      label: 'Assistant: ask about the selection',
      keybinding: 'Mod+Shift+A',
      run: () => {
        openForSelection();
      },
    });
    api.documents.onChange((event) => {
      if (event.type === 'active-changed') {
        closeSelectionPopover();
      }
    });

    // -- the dock panel (id continuity: built-in id `assistant`) -----------------
    let panel: PanelHandle | null = null;
    api.ui.registerWidget({
      id: 'assistant',
      title: 'Assistant',
      icon: 'sparkles',
      defaultDock: 'right',
      defaultOpen: true,
      defaultFlex: 100,
      flush: true,
      // Deliberately NO `status()` (frame-header value): the chat title it
      // showed recomputed only on shell change detection — stale and wrong
      // after a switch — and said nothing the picker below doesn't.
      mount: (body) => {
        panel = mountPanel(body, api, state, tasks);
        return () => {
          panel?.cleanup();
          panel = null;
        };
      },
    });

    // -- the Actions Settings page ------------------------------------------------
    // Patches the live config; a patch may change the manual-action rows,
    // so the page announces itself.
    const onConfigPatched = (): void => {
      void refreshConfig();
    };
    api.ui.registerSettingsPage(
      actionsSettingsPage(api, onConfigPatched, (on) => {
        selectionButtonOn = on;
      }),
    );
    // The semantic retrieval page is plugin-config driven (not appConfig),
    // so it does not need the patch announcement.
    api.ui.registerSettingsPage(retrievalSettingsPage(api));

    void refreshConfig();
  },
};

export default plugin;
