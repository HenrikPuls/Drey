/**
 * The Assistant's conversation target controller (E13-5): which target the
 * panel talks to (its own model or one a plugin registered through
 * `conversations.registerTargets`), the thread of that target, and the
 * active view's default. The Assistant knows nothing about what a target
 * is -- it only holds the threads the targets hand back.
 */
import type {
  ConversationCard,
  ConversationTarget,
  ConversationThread,
  ConversationThreadMeta,
  DreyPluginApi,
} from '../../../shared/plugin-api/renderer';
import type { VaultScope } from '../shared/vault-context.js';
import { MODEL_TARGET, resolveViewDefault, segmentsOf, type TargetSegment } from './targets-model.js';

export interface TargetController {
  segments(): readonly TargetSegment[];
  /** `model` or a registered target's id. */
  activeId(): string;
  /** The active target; null for the model. */
  active(): ConversationTarget | null;
  select(id: string): void;
  /** The active target's thread (with the owner's pending words appended); null for the model or while loading. */
  thread(): ConversationThread | null;
  /** True while the active target works on a message. */
  busy(): boolean;
  /** An open answer card (the last message's `choices`), or null. */
  choices(): ConversationCard | null;
  /** `vault`: the Vault chip as it stands; a scope other than `off` gathers note sections for this message. */
  send(text: string, vault?: { readonly scope: VaultScope; readonly vaultIds: readonly string[]; readonly files?: readonly string[] }): Promise<boolean>;
  act(cardId: string, actionId: string): Promise<void>;
  newThread(): Promise<void>;
  history(): Promise<readonly ConversationThreadMeta[]>;
  openThread(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

/** How much of one attached file a target gets. */
const ATTACHED_MAX_CHARS = 6_000;

export function createTargetController(api: DreyPluginApi): TargetController {
  let active = MODEL_TARGET;
  /** The view whose default has been applied; `undefined` = none yet (apply on the next chance). */
  let appliedView: string | null | undefined = undefined;
  const threads = new Map<string, ConversationThread>();
  const loading = new Set<string>();
  const working = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const targets = (): readonly ConversationTarget[] => api.conversations.targets();
  const byId = (id: string): ConversationTarget | null => targets().find((target) => target.id === id) ?? null;

  const apply = (id: string, thread: ConversationThread): void => {
    threads.set(id, thread);
    notify();
  };

  const load = (id: string): void => {
    const target = byId(id);
    if (target === null || threads.has(id) || loading.has(id)) {
      return;
    }
    loading.add(id);
    void target
      .thread()
      .then((thread) => apply(id, thread))
      .catch(() => apply(id, { id: null, title: 'New chat', messages: [] }))
      .finally(() => {
        loading.delete(id);
        notify();
      });
  };

  const select = (id: string): void => {
    if (id !== MODEL_TARGET && byId(id) === null) {
      return;
    }
    active = id;
    load(id);
    notify();
  };

  const applyViewDefault = (): void => {
    const view = api.conversations.viewTarget();
    if (appliedView === view) {
      return;
    }
    const resolved = resolveViewDefault(view, targets().map((target) => target.id));
    if (resolved.kind === 'wait') {
      return;
    }
    appliedView = view;
    select(resolved.id);
  };

  /** A target may say its thread changed on its own (SDK 1.43): read it again. */
  const watched = new Map<string, () => void>();
  const watchThreads = (): void => {
    const live = new Set<string>();
    for (const target of targets()) {
      live.add(target.id);
      if (target.onThreadChange === undefined || watched.has(target.id)) {
        continue;
      }
      const id = target.id;
      watched.set(
        id,
        target.onThreadChange(() => {
          // Never replace the thread under a send that is still on its way.
          if (working.has(id) || !threads.has(id)) {
            return;
          }
          const current = byId(id);
          if (current !== null) {
            void current
              .thread()
              .then((thread) => {
                if (!working.has(id)) {
                  apply(id, thread);
                }
              })
              .catch(() => undefined);
          }
        }),
      );
    }
    for (const [id, off] of [...watched]) {
      if (!live.has(id)) {
        off();
        watched.delete(id);
      }
    }
  };

  const unsubTargets = api.conversations.onTargetsChange(() => {
    watchThreads();
    if (active !== MODEL_TARGET && byId(active) === null) {
      active = MODEL_TARGET;
    }
    applyViewDefault();
    notify();
  });
  const unsubView = api.conversations.onViewTargetChange(() => {
    appliedView = undefined;
    applyViewDefault();
  });
  watchThreads();
  applyViewDefault();

  const run = async (id: string, action: (target: ConversationTarget) => Promise<ConversationThread>): Promise<void> => {
    const target = byId(id);
    if (target === null) {
      return;
    }
    try {
      apply(id, await action(target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = threads.get(id) ?? { id: null, title: 'New chat', messages: [] };
      apply(id, {
        ...current,
        messages: [
          ...current.messages,
          { id: 'error', role: 'agent', text: '', error: { title: 'The target could not answer', lines: [message] } },
        ],
      });
    }
  };

  return {
    segments: () => segmentsOf(targets()),
    activeId: () => active,
    active: () => (active === MODEL_TARGET ? null : byId(active)),
    select,
    thread: () => {
      const thread = threads.get(active);
      if (thread === undefined) {
        return null;
      }
      const pending = working.get(active);
      return pending === undefined || pending === ''
        ? thread
        : { ...thread, messages: [...thread.messages, { id: 'pending', role: 'user', text: pending }] };
    },
    busy: () => working.has(active),
    choices: () => {
      const thread = threads.get(active);
      const last = thread?.messages[thread.messages.length - 1];
      return last?.cards?.find((card) => card.kind === 'choices') ?? null;
    },
    send: async (text, vault) => {
      const id = active;
      if (id === MODEL_TARGET || working.has(id)) {
        return false;
      }
      working.set(id, text);
      notify();
      // The Vault chip: note sections that contain words of the message ride along as reference.
      let context = '';
      if (vault !== undefined && vault.scope !== 'off') {
        try {
          const found = (await api.backend.invoke('vault:context', {
            question: text,
            scope: vault.scope,
            vaultIds: vault.vaultIds,
          })) as { block?: unknown };
          context = typeof found.block === 'string' ? found.block : '';
        } catch {
          context = '';
        }
      }
      // Attached files ride along as reference too (bounded, read from the active vault).
      for (const path of vault?.files ?? []) {
        try {
          const { content } = await api.vault.readFile(path);
          context += `${context === '' ? '' : '\n\n'}ATTACHED FILE ${path} — read-only reference.\n${content.slice(0, ATTACHED_MAX_CHARS)}`;
        } catch {
          // an unreadable file is simply not attached
        }
      }
      await run(id, (target) => target.send(text, context === '' ? undefined : { context }));
      working.delete(id);
      notify();
      return true;
    },
    act: async (cardId, actionId) => {
      const id = active;
      if (id === MODEL_TARGET || working.has(id)) {
        return;
      }
      working.set(id, '');
      notify();
      await run(id, (target) => target.act(cardId, actionId));
      working.delete(id);
      notify();
    },
    newThread: async () => {
      const id = active;
      if (id !== MODEL_TARGET) {
        await run(id, (target) => target.newThread());
      }
    },
    history: async () => {
      const target = active === MODEL_TARGET ? null : byId(active);
      return target?.history === undefined ? [] : target.history();
    },
    openThread: async (threadId) => {
      const id = active;
      const target = byId(id);
      if (target?.open !== undefined) {
        const open = target.open.bind(target);
        await run(id, () => open(threadId));
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => {
      unsubTargets();
      unsubView();
      for (const off of watched.values()) {
        off();
      }
      watched.clear();
      listeners.clear();
    },
  };
}
