/**
 * The `note:save` pipeline (milestone 6). Replaces a raw `writeVaultFile`
 * for `.md` documents:
 *  - parse the frontmatter, merge inline body `#tag`s into `tags`, bump
 *    `updated:` (milestone 6a);
 *  - for every dated entry (`## HH:mm` block) that carries a known tag,
 *    append a dated copy of that entry to the tag's master document
 *    `## History` section -- the source note keeps its copy, nothing is
 *    moved (milestone 6b, [ADR-0007]).
 *
 * Kept thin on purpose -- every decision (`splitFrontmatter`,
 * `readFrontmatter`, `extractInlineTags`, `bumpUpdated`,
 * `writeFrontmatter`, `parseDatedEntries`, `appendHistoryEntry`) is a pure
 * `shared/` function that the renderer test suite covers; this class only
 * sequences filesystem calls.
 *
 * Spec deviation (recorded in `specs/frontmatter-schema.md` + `docs/11`):
 * `specs/frontmatter-schema.md` puts the body-`#tag` merge, `updated:`
 * bump, and routing on the file watcher. There is no watcher yet, so it
 * runs here on an explicit save. `daily/` and `templates/` files get
 * `updated:` bumped but their `tags` array is left alone (structural, not
 * topic notes); `templates/` is also excluded from routing.
 */
import { ActionOutcome, Frontmatter, NoteSaveRequest, NoteSaveResult } from '../shared/ipc-api';
import { dailyDateFromPath } from '../shared/daily';
import { parseDatedEntries } from '../shared/entries';
import {
  bumpUpdated,
  readFrontmatter,
  splitFrontmatter,
  writeFrontmatter,
} from '../shared/frontmatter';
import { appendHistoryEntry } from '../shared/history';
import { extractInlineTags } from '../shared/inline-tags';
import { formatDate, formatDateTime } from '../shared/timestamp';
import { ActionRunner } from './llm';
import { TagIndex } from './tag-index';
import { VaultManager } from './vault-manager';

/** `tags` is not merged for these -- they are structural folders, not topics. */
const NO_MERGE_PREFIXES = ['daily/', 'templates/'];
/** Never route entries out of a template file. */
const NO_ROUTE_PREFIX = 'templates/';

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

    // No frontmatter fence: write the bytes verbatim, nothing to merge or
    // bump (adding a fence unasked would be surprising) and no routing.
    if (!split.hadFence) {
      const modifiedMs = await this.vault.writeFile(relPath, toDisk(body));
      const onSave = await this.runOnSaveActions(request, body, modifiedMs);
      return {
        path: relPath,
        content: onSave.content,
        modifiedMs: onSave.modifiedMs,
        tags: [],
        unknownTags: [],
        appendedTo: [],
        pendingActions: onSave.pendingActions,
      };
    }

    const frontmatter = readFrontmatter(body);
    const isStructural = NO_MERGE_PREFIXES.some((prefix) => relPath.startsWith(prefix));

    const existingTags = dedupe(frontmatter?.tags ?? []);
    const mergedTags = isStructural
      ? existingTags
      : dedupe([...existingTags, ...extractInlineTags(body)]);

    const { updated, created } = bumpUpdated(frontmatter);
    const patch: Partial<Frontmatter> = { updated };
    if (!isStructural) {
      patch.tags = mergedTags;
    }
    if (!frontmatter?.created) {
      patch.created = created;
    }

    const newText = writeFrontmatter(body, patch);
    const modifiedMs = await this.vault.writeFile(relPath, toDisk(newText));

    const routed = await this.route(relPath, split.body, frontmatter);

    // Keep autocomplete / registry in step after a tag set change. No file
    // watcher yet, so this is a full rescan -- cheap for a personal vault,
    // noted as tech debt in docs/11. (A routing append only touches a
    // master's History body + `updated:`, so it needs no rebuild.)
    if (!isStructural && tagsChanged(existingTags, mergedTags)) {
      await this.index.rebuild();
    }

    const unknownTags = dedupe([...mergedTags, ...routed.seenTags]).filter(
      (tag) => !this.index.lookup(tag)?.hasMaster,
    );

    const onSave = await this.runOnSaveActions(request, newText, modifiedMs);

    return {
      path: relPath,
      content: onSave.content,
      modifiedMs: onSave.modifiedMs,
      tags: mergedTags,
      unknownTags,
      appendedTo: routed.appendedTo,
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
      }
    }
    return { content: current, modifiedMs: currentMs, pendingActions };
  }

  /**
   * Appends every dated entry that carries a known tag into that tag's
   * master-document History. Returns the master paths that actually
   * changed and every inline tag seen across the entries.
   */
  private async route(
    relPath: string,
    noteBody: string,
    frontmatter: Frontmatter | null,
  ): Promise<{ appendedTo: string[]; seenTags: string[] }> {
    const appendedTo: string[] = [];
    const seenTags: string[] = [];
    if (relPath.startsWith(NO_ROUTE_PREFIX)) {
      return { appendedTo, seenTags };
    }

    const noteDate = dailyDateFromPath(relPath) ?? frontmatter?.created ?? formatDate(new Date());

    for (const entry of parseDatedEntries(noteBody)) {
      const entryTags = extractInlineTags(entry.text);
      seenTags.push(...entryTags);
      if (entry.text.trim() === '') {
        continue;
      }

      const targets = new Set<string>();
      for (const tag of entryTags) {
        const known = this.index.lookup(tag);
        if (!known?.hasMaster || !known.masterPath) {
          continue;
        }
        if (known.masterPath === relPath || targets.has(known.masterPath)) {
          continue;
        }
        targets.add(known.masterPath);

        const changed = await this.appendToMaster(known.masterPath, {
          date: entry.date ?? noteDate,
          time: entry.time,
          sourcePath: relPath,
          entryText: entry.text,
        });
        if (changed && !appendedTo.includes(known.masterPath)) {
          appendedTo.push(known.masterPath);
        }
      }
    }

    return { appendedTo, seenTags };
  }

  private async appendToMaster(
    masterPath: string,
    append: { date: string; time: string; sourcePath: string; entryText: string },
  ): Promise<boolean> {
    let masterText: string;
    try {
      masterText = (await this.vault.readFile(masterPath)).content;
    } catch {
      return false;
    }

    const masterEol = masterText.includes('\r\n') ? '\r\n' : '\n';
    const lf = masterText.replace(/\r\n/g, '\n');
    const result = appendHistoryEntry(lf, append);
    if (!result.appended) {
      return false;
    }

    let out = result.text;
    if (readFrontmatter(out)) {
      out = writeFrontmatter(out, { updated: formatDateTime(new Date()) });
    }
    const onDisk = masterEol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
    await this.vault.writeFile(masterPath, onDisk);
    return true;
  }
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function tagsChanged(before: readonly string[], after: readonly string[]): boolean {
  return before.length !== after.length || after.some((tag, i) => tag !== before[i]);
}
