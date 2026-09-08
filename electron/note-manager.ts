/**
 * The `note:save` pipeline. For a `.md` document it replaces a raw
 * `writeVaultFile` with:
 *  - a `updated:` bump (and `created:` fill) when the file has a
 *    frontmatter fence -- otherwise the bytes are written verbatim;
 *  - the `on-save` Action hook (`docs/09_architecture_decisions/0011-*.md`);
 *  - an incremental re-index of the file in `TagIndex` (no file watcher).
 *
 * No `#tag` -> frontmatter merge and no routing any more -- tags are free
 * inline labels the tag search reads from the body directly (see the plan,
 * "Tag-Index + Tag-Suche"). Every decision (`splitFrontmatter`,
 * `readFrontmatter`, `bumpUpdated`, `writeFrontmatter`) is a pure
 * `shared/frontmatter` function; this class only sequences filesystem calls.
 */
import { ActionOutcome, Frontmatter, NoteSaveRequest, NoteSaveResult } from '../shared/ipc-api';
import {
  bumpUpdated,
  readFrontmatter,
  splitFrontmatter,
  writeFrontmatter,
} from '../shared/frontmatter';
import { ActionRunner } from './llm';
import { TagIndex } from './tags';
import { VaultManager } from './vault-manager';

/** Structural notes: still get `updated:` bumped, but are not tag-indexed. */
const NO_INDEX_PREFIX = 'templates/';

export class NoteManager {
  constructor(
    private readonly vault: VaultManager,
    private readonly index: TagIndex,
    private readonly actions: ActionRunner,
  ) {}

  async saveNote(request: NoteSaveRequest): Promise<NoteSaveResult> {
    const { path: relPath, body, eol } = request;
    const toDisk = (text: string): string => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

    const split = splitFrontmatter(body);

    // No frontmatter fence: write the bytes verbatim (adding one unasked
    // would be surprising). With a fence: bump `updated:`, fill `created:`.
    let written = body;
    if (split.hadFence) {
      const frontmatter = readFrontmatter(body);
      const { updated, created } = bumpUpdated(frontmatter);
      const patch: Partial<Frontmatter> = { updated };
      if (!frontmatter?.created) {
        patch.created = created;
      }
      written = writeFrontmatter(body, patch);
    }

    const modifiedMs = await this.vault.writeFile(relPath, toDisk(written));
    if (!relPath.startsWith(NO_INDEX_PREFIX)) {
      this.index.reindexFile(relPath, written);
    }

    const onSave = await this.runOnSaveActions(request, written, modifiedMs);
    return {
      path: relPath,
      content: onSave.content,
      modifiedMs: onSave.modifiedMs,
      pendingActions: onSave.pendingActions,
    };
  }

  /**
   * Runs the enabled `on-save` Actions against the just-written file
   * (`docs/09_architecture_decisions/0011-*.md`). A trigger that still
   * needs confirmation contributes its `'edit'` outcome to `pendingActions`
   * for the renderer's confirmation dialog; a trigger with confirmation
   * switched off is applied here and now (the file is written again, and
   * the next action in the chain sees the updated text). `'noop'` /
   * `'error'` outcomes are dropped -- an unreachable LLM must not fail a
   * save. Skipped entirely when LLM features are off, or when the save is
   * itself applying an action result (`runOnSaveActions === false`).
   */
  private async runOnSaveActions(
    request: NoteSaveRequest,
    content: string,
    modifiedMs: number,
  ): Promise<{ content: string; modifiedMs: number; pendingActions: ActionOutcome[] }> {
    const pendingActions: ActionOutcome[] = [];
    if (request.runOnSaveActions === false || !this.actions.isLlmEnabled()) {
      return { content, modifiedMs, pendingActions };
    }

    const toDisk = (text: string): string =>
      request.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;

    let current = content;
    let currentMs = modifiedMs;
    for (const action of this.actions.actionsForEvent('on-save')) {
      const outcome = await this.actions.run(action.triggerId, {
        path: request.path,
        body: current,
      });
      if (outcome.kind !== 'edit') {
        continue;
      }
      if (action.confirm) {
        pendingActions.push({ ...outcome, before: current });
      } else {
        current = outcome.after;
        currentMs = await this.vault.writeFile(request.path, toDisk(current));
        // Keep the index in step after a non-confirm on-save edit.
        if (!request.path.startsWith(NO_INDEX_PREFIX)) {
          this.index.reindexFile(request.path, current);
        }
      }
    }
    return { content: current, modifiedMs: currentMs, pendingActions };
  }
}
