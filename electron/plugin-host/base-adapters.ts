/**
 * TEMPORARY base adapter (ADR-0044 stages 2/5): the on-save Actions still
 * live in the base app until the assistant plugin exists (stage 7); they
 * participate in the save-hook registry like any plugin would, so the
 * conversion is a deletion, not a rewire. (The tag and task indexes
 * already converted -- their hooks live in the Tags and Tasks plugins.)
 *
 * Behaviour is what `NoteManager` used to do inline for Actions: gated on
 * the LLM master switch, non-confirm edits written back before the next
 * trigger runs.
 */
import type { ActionOutcome } from '../../shared/llm';
import type {
  NoteSavedEvent,
  SaveHookResult,
  Unsubscribe,
} from '../../shared/plugin-api';
import type { ActionRunner } from '../llm';
import type { VaultManager } from '../vault-manager';
import type { PluginHost } from './plugin-host';

/** Registers the on-save Actions as a save hook. */
export function registerBaseSaveHooks(
  host: PluginHost,
  deps: {
    readonly vault: VaultManager;
    readonly actions: ActionRunner;
  },
): Unsubscribe {
  const hook = async (event: NoteSavedEvent): Promise<SaveHookResult | void> => {
    if (!deps.actions.isLlmEnabled()) {
      return undefined;
    }
    const pendingActions: ActionOutcome[] = [];
    let current = event.content;
    let currentMs = event.modifiedMs;
    for (const action of deps.actions.actionsForEvent('on-save')) {
      const outcome = await deps.actions.run(action.triggerId, {
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
        currentMs = await deps.vault.writeFile(event.path, toDisk(current, event.eol));
      }
    }
    return current !== event.content
      ? { content: current, modifiedMs: currentMs, ...(pendingActions.length > 0 ? { pendingActions } : {}) }
      : { ...(pendingActions.length > 0 ? { pendingActions } : {}) };
  };
  return host.save.onNoteSaved(hook);
}

function toDisk(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}
