import { Injectable, signal } from '@angular/core';

/** One conflict awaiting an answer. */
export interface PendingConflict {
  /** Vault-relative path, shown in the dialog. */
  path: string;
  /** What the tab last read from disk -- steers which side a block starts on. */
  base: string;
  /** What is on disk now (`\n` form). */
  disk: string;
  /** The tab's buffer. */
  mine: string;
  /** `true` when asked from a save -- the result is then written at once. */
  saving: boolean;
  resolve: (result: string | null) => void;
}

/**
 * The save-conflict question (milestone 60, ADR-0060): a note was changed
 * on disk -- another device through the sync folder, another program --
 * while its tab holds unsaved edits. `EditorService` asks; `ConflictDialog`
 * shows both versions block by block and answers with the merged text
 * (which may be exactly one of the two), or `null` for "cancel". State
 * only: what happens with the text lives with the asker, which owns the
 * documents.
 *
 * One question at a time. Saves are serialized, so a second asker can only
 * be the meta bar's "Changed on disk" button while a save is already
 * asking -- that one is answered `null` and the button stays.
 */
@Injectable({ providedIn: 'root' })
export class ConflictService {
  readonly pending = signal<PendingConflict | null>(null);

  ask(conflict: Omit<PendingConflict, 'resolve'>): Promise<string | null> {
    if (this.pending() !== null) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.pending.set({
        ...conflict,
        resolve: (result) => {
          this.pending.set(null);
          resolve(result);
        },
      });
    });
  }

  /** The dialog's answer: the text to keep, or `null` to cancel. */
  answer(result: string | null): void {
    this.pending()?.resolve(result);
  }
}
