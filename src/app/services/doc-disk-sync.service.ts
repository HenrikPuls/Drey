import { Injectable, inject } from '@angular/core';
import { isChatNotePath } from '../../../shared/structural-folders';
import { ConflictService } from '../conflict';
import { refreshChangedAssets } from '../editor/vault-image';
import { OpenDoc, isDirty, splitEol } from './open-doc';
import { OpenDocsStore } from './open-docs.store';

/**
 * Keeps open tabs in step with files that changed underneath them
 * (ADR-0045, ADR-0060): the renderer half of the external-change round,
 * the "Changed on disk" settlement, and the history records of text only a
 * tab still holds.
 */
@Injectable({ providedIn: 'root' })
export class DocDiskSyncService {
  private readonly store = inject(OpenDocsStore);
  private readonly conflicts = inject(ConflictService);

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  constructor() {
    // External-change auto-reload (ADR-0045): the `vault:changed` push
    // carries the changed `.md` paths (scoped to one vault since ADR-0051);
    // clean tabs among them re-read from disk here. Lives for the app's
    // lifetime -- no teardown.
    if (typeof window !== 'undefined' && typeof window.dreyApi?.onVaultChanged === 'function') {
      window.dreyApi.onVaultChanged((push) => {
        if (push.paths !== undefined && typeof document !== 'undefined') {
          refreshChangedAssets(push.vaultId, push.paths, document);
        }
        void this.reloadFromVaultChange(push.vaultId, push.paths);
      });
    }
  }

  /**
   * Re-reads every open **clean** text tab whose file is in `paths` from
   * disk -- the renderer half of the watcher round (ADR-0045, req-14).
   * `vaultId` scopes the round to one vault's tabs (ADR-0051); when absent
   * the paths are matched against every vault's tabs (a push from an older
   * main). A dirty tab keeps its buffer and is marked `diskChanged`
   * instead -- the conflict is the user's to settle (ADR-0060). A file
   * that no longer exists flips its tab to draft semantics
   * (`existsOnDisk: false`) -- the tab stays open and the next edit + save
   * resurrects the file. `paths === undefined` (a full refresh -- huge
   * batch or manual refresh) never touches tabs.
   */
  async reloadFromVaultChange(
    vaultId: string | undefined,
    paths: readonly string[] | undefined,
  ): Promise<void> {
    if (!paths || paths.length === 0 || typeof this.api?.readVaultFile !== 'function') {
      return;
    }
    const changed = new Set(paths);
    // Chat notes follow the disk EVEN when the tab is dirty: the chat
    // engine appends every turn to the file (the note is the source of
    // truth, ADR-0048), so the tab is a view of it, not an independent
    // buffer. Only typing inside the auto-save window can be lost —
    // sub-second, and the conversation content always wins. Every other
    // dirty tab keeps its buffer and is only MARKED (`diskChanged`): which
    // version survives is the user's call (ADR-0060).
    const targets = this.store
      .docs()
      .filter(
        (d) =>
          d.kind === 'text' &&
          d.existsOnDisk &&
          d.external !== true &&
          (vaultId === undefined || d.vaultId === vaultId) &&
          changed.has(d.path),
      );
    for (const doc of targets) {
      const follows = !isDirty(doc) || isChatNotePath(doc.path);
      try {
        const { content, modifiedMs } = await this.api.readVaultFile(doc.path, doc.vaultId ?? undefined);
        const { text, eol } = splitEol(content);
        if (!follows) {
          if (text !== doc.savedContent) {
            this.store.patch(doc.key, { diskChanged: true });
          }
          continue;
        }
        if (text !== doc.savedContent) {
          // The tab is the last place that still knows the previous text.
          this.captureHistory(doc, doc.savedContent, 'external');
        }
        this.store.patch(doc.key, {
          savedContent: text,
          bufferContent: text,
          eol,
          modifiedMs,
          existsOnDisk: true,
          diskChanged: false,
        });
      } catch {
        if (follows) {
          this.store.patch(doc.key, { existsOnDisk: false });
        }
      }
    }
  }

  /**
   * The meta bar's "Changed on disk" button: settles a marked tab without
   * saving, through the same merge dialog. A result that is exactly the
   * disk version reloads the tab (the buffer goes into the history); any
   * other result becomes the buffer on top of the disk state, both
   * versions recorded, and the next save writes it.
   */
  async resolveDiskChange(key: string): Promise<void> {
    const doc = this.store.docFor(key);
    if (!this.api || doc === null || doc.kind !== 'text') {
      return;
    }
    let disk: { content: string; modifiedMs: number };
    try {
      disk = await this.api.readVaultFile(doc.path, doc.vaultId ?? undefined);
    } catch {
      // Gone again: nothing to compare with; a save recreates the file.
      this.store.patch(key, { diskChanged: false });
      return;
    }
    const normalized = splitEol(disk.content).text;
    let buffer = doc.bufferContent;
    if (normalized !== doc.savedContent) {
      const merged = await this.conflicts.ask({
        path: doc.path,
        base: doc.savedContent,
        disk: normalized,
        mine: buffer,
        saving: false,
      });
      if (merged === null) {
        return;
      }
      if (merged === normalized) {
        await this.adoptDisk(key);
        return;
      }
      // The next save overwrites the disk version; a plain save's history
      // record is throttled, so keep it now. A merge also replaces the
      // buffer as it was.
      this.captureHistory(doc, normalized, 'conflict');
      if (merged !== buffer) {
        this.captureHistory(doc, buffer, 'conflict');
        buffer = merged;
      }
    }
    // The tab now knowingly sits on top of the disk state.
    this.store.patch(key, {
      savedContent: normalized,
      bufferContent: buffer,
      modifiedMs: disk.modifiedMs,
      diskChanged: false,
    });
  }

  /** Replaces a tab's buffer with the file on disk; the buffer goes into the history first. */
  async adoptDisk(key: string): Promise<void> {
    const doc = this.store.docFor(key);
    if (!this.api || doc === null) {
      return;
    }
    this.captureHistory(doc, doc.bufferContent, 'conflict');
    try {
      const { content, modifiedMs } = await this.api.readVaultFile(doc.path, doc.vaultId ?? undefined);
      const { text, eol } = splitEol(content);
      this.store.patch(key, {
        savedContent: text,
        bufferContent: text,
        eol,
        modifiedMs,
        existsOnDisk: true,
        diskChanged: false,
      });
    } catch (err) {
      this.store.fail(err);
    }
  }

  /** Best-effort history record of text only this tab still holds (ADR-0060). */
  captureHistory(doc: OpenDoc, content: string, origin: string): void {
    if (doc.vaultId === null || typeof this.api?.captureNoteHistory !== 'function') {
      return;
    }
    void this.api.captureNoteHistory(doc.path, content, origin, doc.vaultId).catch(() => undefined);
  }
}
