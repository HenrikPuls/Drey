/**
 * TEMPORARY base adapters (ADR-0044 stage 2): the tag/task index maintenance
 * and the on-save Actions still live in the base app until their plugins
 * exist (stages 5-7). Until then they participate in the plugin seams like
 * any plugin would — registered here as hooks/provider — so that the
 * pipeline itself is already feature-agnostic and each later conversion is
 * a deletion, not a rewire.
 *
 * Behaviour here is byte-for-byte what `NoteManager` used to do inline:
 * index re-indexing skipped under `templates/`, on-save Actions gated on
 * the LLM master switch and `runOnSaveActions`, non-confirm edits written
 * back (and re-indexed) before the next trigger runs.
 */
import type { ActionOutcome } from '../../shared/llm';
import type {
  NoteSavedEvent,
  SaveHookResult,
  SectionSearchProvider,
  Unsubscribe,
} from '../../shared/plugin-api';
import type { TagSearchHit, TagSearchQuery } from '../../shared/tags';
import type { ActionRunner } from '../llm';
import type { TagIndex } from '../tags';
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
    readonly tagIndex: TagIndex;
    readonly taskIndex: TaskIndex;
    readonly actions: ActionRunner;
  },
): Unsubscribe {
  const hook = async (event: NoteSavedEvent): Promise<SaveHookResult | void> => {
    // Index maintenance (the tags/tasks plugins will bring their own).
    if (!event.path.startsWith(NO_INDEX_PREFIX)) {
      deps.tagIndex.reindexFile(event.path, event.content);
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
          deps.tagIndex.reindexFile(event.path, current);
        }
      }
    }
    return current !== event.content
      ? { content: current, modifiedMs: currentMs, ...(pendingActions.length > 0 ? { pendingActions } : {}) }
      : { ...(pendingActions.length > 0 ? { pendingActions } : {}) };
  };
  return host.save.onNoteSaved(hook);
}

/** Registers the tag index as the section-search provider MCP reads. */
export function registerBaseSearchProvider(host: PluginHost, tagIndex: TagIndex): Unsubscribe {
  const provider: SectionSearchProvider & {
    /** Kept for `VaultTools`' post-write re-index until the tags plugin owns it. */
    reindexFile(path: string, content: string): void;
  } = {
    search: (query: TagSearchQuery): Promise<readonly TagSearchHit[]> =>
      Promise.resolve(tagIndex.search(query)),
    vocabulary: () => tagIndex.getVocabulary(),
    reindexFile: (path: string, content: string) => tagIndex.reindexFile(path, content),
  };
  return host.search.registerSectionSearch(provider);
}

function toDisk(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}
