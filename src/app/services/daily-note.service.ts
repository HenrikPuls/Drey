import { Injectable, inject } from '@angular/core';
import { EditorService } from './editor.service';

/**
 * Bridges the quick-capture hotkey to the editor. The main process
 * ensures today's daily note exists (from `templates/daily.md`) and
 * pushes its vault-relative path; this service opens it and asks the
 * editor to start a fresh `## HH:mm` entry.
 *
 * All of the (small amount of) logic lives here, not in a component
 * (CLAUDE.md, "no business logic inside components").
 */
@Injectable({ providedIn: 'root' })
export class DailyNoteService {
  private readonly editor = inject(EditorService);
  private unsubscribe: (() => void) | null = null;

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** Wire the main-process signal. Called once from `App`; idempotent. */
  start(): void {
    if (this.unsubscribe || !this.api) {
      return;
    }
    this.unsubscribe = this.api.onOpenDailyNote((relativePath) => {
      void this.open(relativePath);
    });
  }

  private async open(relativePath: string): Promise<void> {
    await this.editor.openFile(relativePath);
    // openFile can decline (a dirty other buffer, cancelled confirm). Only
    // start a new entry once the daily note is actually the open file --
    // otherwise the `## HH:mm` heading would land in the wrong document.
    if (this.editor.openPath() === relativePath) {
      this.editor.requestNewDailyEntry();
    }
  }
}
