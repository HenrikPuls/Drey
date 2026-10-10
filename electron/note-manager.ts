/**
 * The `note:save` pipeline. For a `.md` document it replaces a raw
 * `writeVaultFile` with:
 *  - a `updated:` bump when the note's frontmatter already has that key
 *    -- otherwise the bytes are written verbatim (nothing is ever added);
 *  - the plugin save hooks (`docs/09_architecture_decisions/0044-*.md`),
 *    which return optional content rewrites + pending confirmations.
 *
 * No `#tag` -> frontmatter merge and no routing any more -- tags are free
 * inline labels the tag search reads from the body directly (see the plan,
 * "Tag-Index + Tag-Suche"). The frontmatter decision (`touchUpdated`) is a
 * pure `shared/frontmatter` function; this class only sequences filesystem calls
 * and knows nothing about indexes or Actions -- those are hooks now
 * (registered by the base adapters until their plugins exist).
 */
import type { NoteSavedEvent, SaveHookResult, Unsubscribe } from '../shared/plugin-api';
import type { VaultManager } from './vault-manager';
import { NoteSaveRequest, NoteSaveResult } from '../shared/ipc-api';
import { touchUpdated } from '../shared/frontmatter';

/**
 * The save-hook seam (ADR-0044 rule 4): what the pipeline offers, and what
 * `PluginHost` implements. A hook may rewrite the final content (the
 * pipeline adopts it, exactly as the renderer adopts `NoteSaveResult`)
 * and/or queue confirmations for the renderer's dialog.
 */

export interface NoteSaveHooks {
  onNoteSaved(hook: (event: NoteSavedEvent) => Promise<SaveHookResult | void>): Unsubscribe;
  emitNoteSaved(event: NoteSavedEvent): Promise<SaveHookResult[]>;
}

/** Same slack the own-write ledger allows between two reads of one mtime. */
const MTIME_TOLERANCE_MS = 2;

export class NoteManager {
  constructor(
    private readonly vault: VaultManager,
    private readonly hooks: NoteSaveHooks,
  ) {}

  async saveNote(request: NoteSaveRequest): Promise<NoteSaveResult> {
    const { path: relPath, body, eol } = request;
    // Resolve once: the vault this note lives in (default: the active
    // vault), used for the write AND the save-hook event's identity.
    const vaultId = this.vault.resolveVaultId(request.vaultId);
    const toDisk = (text: string): string => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

    // The conflict guard (ADR-0060): the tab says which state of the file
    // it edited; a different one on disk means somebody else wrote in
    // between, and overwriting it is the user's call, not ours.
    if (request.baseModifiedMs !== undefined && request.force !== true) {
      const disk = await this.vault.readFile(relPath, vaultId).catch(() => null);
      if (disk !== null && Math.abs(disk.modifiedMs - request.baseModifiedMs) > MTIME_TOLERANCE_MS) {
        return {
          path: relPath,
          content: body,
          modifiedMs: request.baseModifiedMs,
          conflict: { content: disk.content.replace(/\r\n/g, '\n'), modifiedMs: disk.modifiedMs },
        };
      }
    }

    // `updated:` is bumped only where the note already has it; nothing is
    // ever added, and a note without the key is written verbatim.
    const written = touchUpdated(body);

    const origin = request.origin ?? 'save';
    const modifiedMs = await this.vault.writeFile(relPath, toDisk(written), vaultId, {
      origin,
      throttled: origin === 'save',
    });

    // Save hooks fire unless this save IS the application of a confirmed
    // rewrite (`runOnSaveActions: false` semantics -- a hook must not
    // re-trigger on the change it proposed). A hook's content rewrite is
    // adopted as the save result; its pending confirmations are handed to
    // the renderer untouched.
    let content = written;
    let currentMs = modifiedMs;
    let pendingActions: NoteSaveResult['pendingActions'];
    if (request.runOnSaveActions !== false) {
      const results = await this.hooks.emitNoteSaved({
        vaultId,
        path: relPath,
        content: written,
        modifiedMs,
        eol,
        applyingAction: false,
      });
      for (const result of results) {
        if (result.content !== undefined) {
          content = result.content;
          // The hook wrote the file itself; adopt its write time when it
          // reported one (the legacy on-save Actions path does).
          if (result.modifiedMs !== undefined) {
            currentMs = result.modifiedMs;
          }
        }
        if (result.pendingActions !== undefined && result.pendingActions.length > 0) {
          pendingActions = [...(pendingActions ?? []), ...result.pendingActions];
        }
      }
    }
    return {
      path: relPath,
      content,
      modifiedMs: currentMs,
      ...(pendingActions !== undefined ? { pendingActions } : {}),
    };
  }
}
