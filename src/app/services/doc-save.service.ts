import { Injectable, inject, signal } from '@angular/core';
import { ActionOutcome, NoteSaveRequest } from '../../../shared/ipc-api';
import { isAutoSavePath } from '../../../shared/structural-folders';
import { ConflictService } from '../conflict';
import { VaultService } from '../vault';
import { DocDiskSyncService } from './doc-disk-sync.service';
import { OpenDoc, docKey, isDirty } from './open-doc';
import { OpenDocsStore } from './open-docs.store';

/**
 * Writes open documents: the vault save pipeline with its conflict guard,
 * the in-place write of an external file, the exit-time draft commit and
 * the "Save as…" copy. Which of these a save takes -- and the order saves
 * run in -- is `EditorService`'s routing; nothing here opens or closes a
 * tab.
 */
@Injectable({ providedIn: 'root' })
export class DocSaveService {
  private readonly store = inject(OpenDocsStore);
  private readonly vault = inject(VaultService);
  private readonly conflicts = inject(ConflictService);
  private readonly diskSync = inject(DocDiskSyncService);

  /**
   * Docs the assistant has edited since their last save (a live-edit lock
   * was taken, or a confirmed rewrite applied): that save tells the local
   * history so -- its version is always recorded, never throttled away
   * like the user's own saves (ADR-0060).
   */
  private readonly assistantEdited = new Set<string>();

  /**
   * `'edit'` outcomes from `on-save` Actions that still need confirmation
   * (ADR-0011). Set by a vault save; the plugin host consumes the queue
   * when it synthesizes the `pending-actions` document event, so the
   * assistant plugin (the queue's owner since ADR-0044 stage 7) routes them
   * through the shared confirmation dialog.
   */
  readonly pendingActions = signal<ActionOutcome[]>([]);

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  markAssistantEdited(key: string): void {
    this.assistantEdited.add(key);
  }

  /**
   * Saves a buffer through the vault pipeline (`note:save`): main checks
   * the file against the state this tab last saw (ADR-0060), bumps
   * `updated:` where the note has it and runs the save hooks. The returned
   * `content` is the note as written -- adopted as saved text, and as
   * buffer text when the buffer still holds what was sent, so the tab is
   * clean. No-op when nothing changed.
   */
  async saveToVault(
    doc: OpenDoc,
    options: { runOnSaveActions?: boolean; origin?: string } = {},
  ): Promise<void> {
    if (!this.api || !isDirty(doc)) {
      return;
    }

    const wasDraft = doc.existsOnDisk === false;
    // What this save is committing — a buffer edited while the save runs
    // (a checkbox ticked mid-save, typing) must not be clobbered by the
    // response.
    let sentBody = doc.bufferContent;

    this.store.isSaving.set(true);
    this.store.error.set(null);
    try {
      const request: NoteSaveRequest = {
        path: doc.path,
        vaultId: doc.vaultId ?? undefined,
        body: sentBody,
        eol: doc.eol,
        runOnSaveActions: options.runOnSaveActions,
      };
      const origin = options.origin ?? (this.assistantEdited.has(doc.key) ? 'assistant' : undefined);
      if (origin !== undefined) {
        request.origin = origin;
      }
      // The conflict guard (ADR-0060): say which state of the file this
      // tab edited. Auto-saved paths skip it -- a chat note follows the
      // disk by design.
      if (!isAutoSavePath(doc.path)) {
        request.baseModifiedMs = wasDraft ? 0 : doc.modifiedMs;
      }
      let result = await this.api.saveNote(request);
      if (result.conflict !== undefined) {
        const disk = result.conflict;
        // Same text as the tab last read: only the timestamp moved (a sync
        // client touching the file) -- nothing to ask about.
        if (disk.content !== doc.savedContent) {
          const merged = await this.conflicts.ask({
            path: doc.path,
            base: doc.savedContent,
            disk: disk.content,
            mine: sentBody,
            saving: true,
          });
          if (merged === null) {
            return;
          }
          if (merged === disk.content) {
            await this.diskSync.adoptDisk(doc.key);
            return;
          }
          if (merged !== sentBody) {
            // A merge replaces the buffer as it was; main records the disk
            // version when the forced write overwrites it.
            this.diskSync.captureHistory(doc, sentBody, 'conflict');
            this.store.patch(doc.key, { bufferContent: merged });
            sentBody = merged;
            request.body = merged;
          }
          request.origin = 'conflict';
        }
        result = await this.api.saveNote({ ...request, force: true });
      }
      this.assistantEdited.delete(doc.key);
      // Adopt the pipeline's rewrite (frontmatter bump) only when the
      // buffer still holds what was sent; otherwise keep the live buffer.
      const fresh = this.store.docFor(doc.key);
      const currentBuffer = fresh?.bufferContent ?? result.content;
      this.store.patch(doc.key, {
        savedContent: result.content,
        bufferContent: currentBuffer === sentBody ? result.content : currentBuffer,
        modifiedMs: result.modifiedMs,
        existsOnDisk: true,
        diskChanged: false,
      });
      // A first save of a draft (a daily note opened from the calendar, or
      // the quick-capture hotkey) creates a file the sidebar tree does not
      // know about yet -- no watcher, so pull the tree in.
      if (wasDraft) {
        void this.vault.refresh();
      }
      if (result.pendingActions && result.pendingActions.length > 0) {
        this.pendingActions.set(result.pendingActions);
      }
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.store.isSaving.set(false);
    }
  }

  /**
   * Writes an external document back to the path it was opened from. The
   * buffer is held in `\n`; the file's own line ending is restored on the
   * way out. What is committed is the buffer as of the call -- typing during
   * the write keeps the tab dirty.
   */
  async saveExternal(doc: OpenDoc): Promise<void> {
    if (!this.api || !isDirty(doc)) {
      return;
    }
    const sentBody = doc.bufferContent;
    this.store.isSaving.set(true);
    this.store.error.set(null);
    try {
      const onDisk = doc.eol === '\r\n' ? sentBody.replace(/\n/g, '\r\n') : sentBody;
      const modifiedMs = await this.api.writeExternalFile(doc.path, onDisk);
      this.store.patch(doc.key, { savedContent: sentBody, modifiedMs });
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.store.isSaving.set(false);
    }
  }

  /**
   * Commits an untitled ("scratch") buffer into the ACTIVE vault's hidden
   * `.drafts/` folder as the next `unnamed-N.md`, with no dialog (bug-5).
   * The tab is re-keyed to the real file (the pane placement moves with it
   * -- from the vault-less scratch namespace into the vault's) and marked
   * clean/on-disk, so the session snapshot then restores the real file on
   * the next start. An empty buffer saves nothing -- there is nothing worth
   * keeping. Errors land in `error` and the tab stays a scratch one.
   */
  async saveDraft(key: string): Promise<void> {
    const doc = this.store.docFor(key);
    if (!this.api?.saveDraftNote || !doc || doc.kind !== 'text' || doc.bufferContent.trim() === '') {
      return;
    }
    this.store.isSaving.set(true);
    this.store.error.set(null);
    try {
      const result = await this.api.saveDraftNote({ body: doc.bufferContent, eol: doc.eol });
      // The draft materializes in the ACTIVE vault; re-key the tab there.
      const nextKey = docKey(this.vault.activeVaultId(), result.path);
      this.store.retarget(doc.key, nextKey);
      this.store.patch(nextKey, {
        savedContent: result.content,
        bufferContent: result.content,
        modifiedMs: result.modifiedMs,
        existsOnDisk: true,
        askOnSave: false,
      });
      // No vault.refresh(): `.drafts/` is a dot-folder, the file tree (and
      // the plugins' indexes) never list it.
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.store.isSaving.set(false);
    }
  }

  /**
   * "Save as…": writes the buffer to `target` in `vaultId`; the tab itself
   * is untouched (the caller swaps it for the new file). False when the
   * write failed -- the reason is in `error`.
   */
  async writeCopy(doc: OpenDoc, target: string, vaultId: string | null): Promise<boolean> {
    if (!this.api) {
      return false;
    }
    this.store.isSaving.set(true);
    try {
      await this.api.saveNote({
        path: target,
        vaultId: vaultId ?? undefined,
        body: doc.bufferContent,
        eol: doc.eol,
      });
      return true;
    } catch (err) {
      this.store.fail(err);
      return false;
    } finally {
      this.store.isSaving.set(false);
    }
  }
}
