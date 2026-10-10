import { Injectable, computed, inject, signal } from '@angular/core';
import { NoteHistoryEntry } from '../../../shared/ipc-api';
import { isAutoSavePath } from '../../../shared/structural-folders';
import { NOTE_FILE } from '../../../shared/wikilinks';
import { EditorService } from '../services/editor.service';

/** The document whose history is open. */
export interface HistoryTarget {
  key: string;
  path: string;
  vaultId: string;
}

const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  save: 'Before a save',
  assistant: 'Before an assistant edit',
  mcp: 'Before an MCP write',
  links: 'Before a link update',
  conflict: 'Not kept in a conflict',
  external: 'Before an external change',
  restore: 'Before a restore',
  app: 'Before an edit from a panel',
};

/** What a version's `origin` means, in the list's words. */
export function historyOriginLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? `Before a change by ${origin}`;
}

/**
 * The note-history dialog's state (milestone 60, ADR-0060): the earlier
 * versions main recorded for one open note, the selected one's text, and
 * the restore. Main records (`NoteHistoryStore`, fed by every vault
 * write); this side only reads -- plus one write, the buffer a restore is
 * about to replace.
 *
 * A restore puts the version into the EDITOR, not onto the disk: it is one
 * undo step, and nothing is written until the user saves.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly editor = inject(EditorService);

  readonly target = signal<HistoryTarget | null>(null);
  readonly entries = signal<NoteHistoryEntry[]>([]);
  readonly selectedId = signal<string | null>(null);
  /** The selected version's text (`\n` form); `null` while loading or when it expired. */
  readonly selectedContent = signal<string | null>(null);
  readonly loading = signal(false);

  /** The open note's buffer -- what a version is compared against. */
  readonly current = computed<string>(() => {
    const target = this.target();
    return target === null ? '' : (this.editor.docFor(target.key)?.bufferContent ?? '');
  });

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** Whether `key` is a document that has a history at all: a note in a vault. */
  canShow(key: string | null): boolean {
    const doc = key === null ? null : this.editor.docFor(key);
    return (
      doc !== null &&
      doc.kind === 'text' &&
      doc.vaultId !== null &&
      doc.external !== true &&
      doc.askOnSave !== true &&
      NOTE_FILE.test(doc.path) &&
      !isAutoSavePath(doc.path)
    );
  }

  /** Opens the dialog for `key` (default: the focused pane's document). */
  async show(key?: string): Promise<void> {
    const docKey = key ?? this.editor.activePath();
    const doc = docKey === null ? null : this.editor.docFor(docKey);
    if (doc === null || doc.vaultId === null || !this.canShow(doc.key) || !this.api?.listNoteHistory) {
      return;
    }
    this.entries.set([]);
    this.selectedId.set(null);
    this.selectedContent.set(null);
    this.target.set({ key: doc.key, path: doc.path, vaultId: doc.vaultId });
    this.loading.set(true);
    try {
      const entries = await this.api.listNoteHistory(doc.path, doc.vaultId);
      if (this.target()?.key !== doc.key) {
        return;
      }
      this.entries.set(entries);
      if (entries.length > 0) {
        await this.select(entries[0].id);
      }
    } finally {
      this.loading.set(false);
    }
  }

  async select(entryId: string): Promise<void> {
    const target = this.target();
    if (target === null || !this.api?.readNoteHistory) {
      return;
    }
    this.selectedId.set(entryId);
    this.selectedContent.set(null);
    const content = await this.api.readNoteHistory(target.path, entryId, target.vaultId);
    if (this.selectedId() === entryId) {
      this.selectedContent.set(content === null ? null : content.replace(/\r\n/g, '\n'));
    }
  }

  /** Puts the selected version into the editor and closes the dialog. */
  restore(): void {
    const target = this.target();
    const content = this.selectedContent();
    const doc = target === null ? null : this.editor.docFor(target.key);
    if (target === null || content === null || doc === null || content === doc.bufferContent) {
      return;
    }
    // Unsaved text is on no disk yet -- keep it findable beyond Ctrl+Z.
    if (doc.bufferContent !== doc.savedContent) {
      void this.api
        ?.captureNoteHistory(target.path, doc.bufferContent, 'restore', target.vaultId)
        .catch(() => undefined);
    }
    this.editor.updateBuffer(target.key, content);
    this.close();
  }

  close(): void {
    this.target.set(null);
    this.entries.set([]);
    this.selectedId.set(null);
    this.selectedContent.set(null);
  }
}
