/**
 * TEMPORARY base adapters (ADR-0044 stages 2/5): the task index maintenance
 * and the on-save Actions still live in the base app until their plugins
 * exist (stages 6-7); they participate in the save-hook registry like any
 * plugin would, so each later conversion is a deletion, not a rewire.
 * (The tag index already converted — its hooks/provider live in the Tags
 * plugin.)
 *
 * Behaviour is what `NoteManager` used to do inline: task re-indexing
 * skipped under `templates/`, on-save Actions gated on the LLM master
 * switch and `runOnSaveActions`, non-confirm edits written back before
 * the next trigger runs.
 */
import type { ActionOutcome } from '../../shared/llm';
import type {
  NoteSavedEvent,
  SaveHookResult,
  Unsubscribe,
} from '../../shared/plugin-api';
import type { ActionRunner } from '../llm';
import type { TaskIndex } from '../tasks';
import type { VaultManager } from '../vault-manager';
import type { PluginHost } from './plugin-host';

/** Structural notes: still get `updated:` bumped, but are not tag-indexed. */
const NO_INDEX_PREFIX = 'templates/';

/** Registers the legacy index re-indexing + on-save Actions as a save hook. */
export function registerBaseSaveHooks(
  host: PluginHost,
  deps: {
    readonly vault: VaultManager;
    readonly taskIndex: TaskIndex;
    readonly actions: ActionRunner;
  },
): Unsubscribe {
  const hook = async (event: NoteSavedEvent): Promise<SaveHookResult | void> => {
    // Task index maintenance (the tasks plugin will bring its own).
    if (!event.path.startsWith(NO_INDEX_PREFIX)) {
      deps.taskIndex.reindexFile(event.path, event.content);
    }

    // The on-save Actions (the assistant plugin will bring its own hook).
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
        if (!event.path.startsWith(NO_INDEX_PREFIX)) {
        }
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
