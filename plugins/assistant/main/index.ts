import type {
  ActionContext,
  ActionOutcome,
  MainPluginContext,
  MainPluginModule,
  NoteSavedEvent,
  SaveHookResult,
} from '../../../shared/plugin-api';
import type { ChatThread } from '../shared/chat-thread';
import {
  emptyThread,
  parseChatThread,
  serializeChatThread,
  sidecarPathFor,
} from '../shared/chat-thread.js';
import { parseAskPayload } from '../shared/ask.js';
import { ActionEngine, type ChatFn } from './action-engine';

/**
 * The Assistant plugin's main entry (ADR-0044 stage 7): the on-save Actions
 * save hook (the last base adapter — `base-adapters.ts` was this logic and
 * nothing else), the action engine behind the panel's methods, and the
 * per-note sidecar thread store (`.{name}.chat.json`, ADR-0012).
 *
 * Behaviour is exactly what the base did: the hook runs every enabled
 * `on-save` trigger against the just-written note, adopts non-confirm edits
 * by writing them straight back (before the next trigger runs, so triggers
 * chain), and returns the confirm-edits as `pendingActions` for the
 * renderer's confirmation dialog. The save pipeline applies `content` and
 * hands `pendingActions` to the plugin renderer through the host's
 * `pending-actions` document event.
 */
const plugin: MainPluginModule = {
  activate(ctx: MainPluginContext) {
    const engine = new ActionEngine(
      () => ctx.appConfig.get(),
      // The facade now returns `LlmChatResult` (ADR-0047); the engine's
      // `ChatFn` contract stays plain-string, so unwrap here.
      ((messages, options) =>
        ctx.llm
          .chat(messages, {
            taskId: options?.taskId,
            ...(options?.vaultTools !== undefined ? { vaultTools: options.vaultTools } : {}),
          })
          .then((result) => result.text)) satisfies ChatFn,
    );

    // -- the on-save Actions save hook -------------------------------------
    ctx.save.onNoteSaved(async (event) => runOnSaveActions(ctx, engine, event));

    // -- the panel's methods ------------------------------------------------
    ctx.ipc.handle('run', (payload) => {
      const { triggerId, context, taskId } = shape(payload) as {
        triggerId?: unknown;
        context?: unknown;
        taskId?: unknown;
      };
      if (typeof triggerId !== 'string' || typeof context !== 'object' || context === null) {
        throw new Error('malformed run payload');
      }
      return engine.run(
        triggerId,
        context as ActionContext,
        typeof taskId === 'string' ? taskId : undefined,
      );
    });

    ctx.ipc.handle('ask', (payload) => {
      // Validation lives in the shared contract (`shared/ask.ts`) so the
      // renderer's tests cover it; the bug-10 visible-failure rule and its
      // messages came with it.
      const { request, taskId, history } = parseAskPayload(payload);
      return engine.ask(request, taskId, history);
    });

    ctx.ipc.handle('summarize', (payload) => {
      const { context, taskId } = shape(payload) as { context?: unknown; taskId?: unknown };
      if (typeof context !== 'object' || context === null) {
        throw new Error('malformed summarize payload');
      }
      return engine.summarize(
        context as ActionContext,
        typeof taskId === 'string' ? taskId : undefined,
      );
    });

    // -- the sidecar thread store (ADR-0012) ---------------------------------
    ctx.ipc.handle('thread:read', (payload) => {
      const { path } = shape(payload) as { path?: unknown };
      if (typeof path !== 'string') {
        throw new Error('malformed thread:read payload');
      }
      return readThread(ctx, path);
    });

    ctx.ipc.handle('thread:write', async (payload) => {
      const { thread } = shape(payload) as { thread?: unknown };
      if (typeof thread !== 'object' || thread === null || typeof thread !== 'object') {
        throw new Error('malformed thread:write payload');
      }
      const typed = thread as ChatThread;
      await ctx.vault.write(sidecarPathFor(typed.notePath), serializeChatThread(typed));
    });
  },
};

/**
 * The on-save Actions (was `registerBaseSaveHooks` in the base app, before
 * that inline in `NoteManager`): gated on the LLM master switch,
 * non-confirm edits written back before the next trigger runs.
 */
async function runOnSaveActions(
  ctx: MainPluginContext,
  engine: ActionEngine,
  event: NoteSavedEvent,
): Promise<SaveHookResult | void> {
  if (!ctx.llm.enabled()) {
    return undefined;
  }
  const pendingActions: ActionOutcome[] = [];
  let current = event.content;
  let currentMs = event.modifiedMs;
  for (const action of engine.actionsForEvent('on-save')) {
    const outcome = await engine.run(action.triggerId, {
      path: event.path,
      body: current,
    });
    if (outcome.kind !== 'edit') {
      continue;
    }
    if (action.confirm) {
      pendingActions.push({ ...outcome, before: current });
    } else {
      current = outcome.after;
      currentMs = await ctx.vault.write(event.path, toDisk(current, event.eol));
    }
  }
  return current !== event.content
    ? {
        content: current,
        modifiedMs: currentMs,
        ...(pendingActions.length > 0 ? { pendingActions } : {}),
      }
    : { ...(pendingActions.length > 0 ? { pendingActions } : {}) };
}

/** The sidecar thread for `notePath`, or an empty one when none exists yet. */
async function readThread(ctx: MainPluginContext, notePath: string): Promise<ChatThread> {
  try {
    const content = await ctx.vault.read(sidecarPathFor(notePath));
    return parseChatThread(content, notePath);
  } catch {
    // No sidecar yet (the common case) or an unreadable one -- either
    // way the panel opens on an empty thread rather than an error.
    return emptyThread(notePath);
  }
}

function toDisk(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

function shape(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

export default plugin;
