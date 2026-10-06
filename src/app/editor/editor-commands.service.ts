import { Injectable, signal } from '@angular/core';
import { formatTime } from '../../../shared/timestamp';

/**
 * One ask for a new `## HH:mm` entry at the end of the active document.
 * `id` deduplicates (the handling component remembers the last id it acted
 * on). `text` carries a bare body; the quick-capture hotkey sends none.
 */
export interface NewEntryRequest {
  readonly id: number;
  readonly text?: string;
}

/**
 * The deferred "do this in the editor" command bus, split out of
 * `EditorService`. Callers (the quick-capture flow, the
 * assistant's insert-into-note arrow) bump an id-counter signal rather than
 * pushing a payload the service acts on; the `Editor` component computes the
 * real CodeMirror change against live state when it handles the request,
 * which sidesteps effect-ordering with the doc-reload a just-opened file
 * triggers. `EditorService` re-exposes every member here so its public
 * surface is unchanged.
 */
@Injectable({ providedIn: 'root' })
export class EditorCommandsService {
  /** @see EditorService.newEntryRequest */
  readonly newEntryRequest = signal<NewEntryRequest>({ id: 0 });

  /** @see EditorService.insertRequest */
  readonly insertRequest = signal<{ id: number; text: string }>({ id: 0, text: '' });

  requestNewDailyEntry(text?: string): void {
    this.newEntryRequest.update((r) => ({ id: r.id + 1, text }));
  }

  requestInsertText(text: string): void {
    this.insertRequest.update((r) => ({ id: r.id + 1, text }));
  }

  /**
   * One-time claims for the three per-id requests above. Consumption is
   * claimed GLOBALLY, not per component instance: a fresh `Editor` mounts
   * for every file opened into an empty pane, and a per-instance "already
   * handled" memory would let every later mount re-apply the last request —
   * a stale `## HH:mm` entry (or assistant insert) landing in files nobody
   * captured into. Returns true exactly once per id; id 0 ("nothing
   * pending") is never claimable.
   */
  private claimedEntryId = 0;
  private claimedInsertId = 0;
  private claimedRevealId = 0;

  /** @see newEntryRequest */
  claimNewEntryRequest(id: number): boolean {
    if (id === 0 || id <= this.claimedEntryId) {
      return false;
    }
    this.claimedEntryId = id;
    return true;
  }

  /** @see insertRequest */
  claimInsertRequest(id: number): boolean {
    if (id === 0 || id <= this.claimedInsertId) {
      return false;
    }
    this.claimedInsertId = id;
    return true;
  }

  /** @see EditorService.revealRequest */
  claimRevealRequest(id: number): boolean {
    if (id === 0 || id <= this.claimedRevealId) {
      return false;
    }
    this.claimedRevealId = id;
    return true;
  }

  /**
   * Pure: given the editor's current text, the insertion needed to start
   * a new daily entry heading (`## HH:mm`), or `null` when the text
   * already ends with an empty entry heading -- pressing the hotkey twice
   * without typing shouldn't stack blank sections. The `Editor` component
   * applies the result to CodeMirror and leaves the buffer dirty (the
   * user saves with Ctrl+S like any edit).
   */
  newDailyEntryEdit(
    currentText: string,
    now: Date = new Date(),
  ): { insert: string; at: number } | null {
    if (/(^|\n)##[ \t]+\d{1,2}:\d{2}[ \t]*\n?\s*$/.test(currentText)) {
      return null;
    }

    // Land the new heading after exactly one blank line.
    let gap = '';
    if (currentText.length > 0 && !currentText.endsWith('\n\n')) {
      gap = currentText.endsWith('\n') ? '\n' : '\n\n';
    }
    return { insert: `${gap}## ${formatTime(now)}\n`, at: currentText.length };
  }
}
