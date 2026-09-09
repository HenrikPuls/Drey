import { ipcMain } from 'electron';
import { IPC_CHANNELS, TagEntry, TagSearchHit, TagSearchQuery } from '../../shared/ipc-api';
import { ActionRunner } from '../llm';
import { TagIndex } from '../tags';
import { TaskIndex } from '../tasks';

export interface QueryHandlerDeps {
  tagIndex: TagIndex;
  taskIndex: TaskIndex;
  actionRunner: ActionRunner;
}

/**
 * Read-side index IPC: the tag vocabulary, tag search, the whole-vault task
 * list, and the two LLM-backed helpers that run over search hits
 * (`tag:summarise-results`) or entry text (`tag:suggest`).
 */
export function registerQueryHandlers({
  tagIndex,
  taskIndex,
  actionRunner,
}: QueryHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.tagList, (): TagEntry[] => tagIndex.getVocabulary());
  ipcMain.handle(IPC_CHANNELS.tagSearch, (_event, query: TagSearchQuery): TagSearchHit[] =>
    tagIndex.search(query),
  );
  ipcMain.handle(IPC_CHANNELS.taskList, () => taskIndex.all());
  ipcMain.handle(
    IPC_CHANNELS.tagSummariseResults,
    (_event, query: TagSearchQuery, taskId?: string): Promise<string> =>
      actionRunner.summariseSearchResults(formatHitsForSummary(tagIndex.search(query)), taskId),
  );
  ipcMain.handle(
    IPC_CHANNELS.tagSuggest,
    (_event, entryText: string, taskId?: string): Promise<string[]> =>
      actionRunner.suggestTags(
        entryText,
        tagIndex.getVocabulary().map((entry) => entry.tag),
        taskId,
      ),
  );
}

/**
 * Flattens search hits into the user message for the result summary: one
 * `## <heading> (<path>)` block per hit followed by its snippet, capped so
 * a very broad search does not blow the model's context.
 */
function formatHitsForSummary(hits: readonly TagSearchHit[]): string {
  const MAX_HITS = 40;
  const MAX_CHARS = 8000;
  const blocks = hits
    .slice(0, MAX_HITS)
    .map((hit) => `## ${hit.heading} (${hit.path})\n${hit.snippet}`);
  let out = blocks.join('\n\n');
  if (out.length > MAX_CHARS) {
    out = `${out.slice(0, MAX_CHARS)}\n…`;
  }
  return out;
}
