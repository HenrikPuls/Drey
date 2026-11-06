import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AppBar } from '../app-bar/app-bar';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { Markdown } from '../markdown/markdown';
import type { MdMode } from '../markdown/mode';
import { NotesStore } from './notes.store';
import { folderOfPath } from './notes.model';

/**
 * One note (req-101, boards 10l, 10p, 10r): opens in **View** of the shared
 * Markdown surface; the pencil (or a Live / Source pick) starts editing in
 * Live Preview with **X** and **✓** as icons — X asks only when the text
 * changed, ✓ saves against the `mtime` that was read. Beneath the text: the
 * tags, the link to the ticket (when the note names one) and "Ask about
 * this note". A read-only device has no pencil. On the phone the labelled
 * back control returns to the list, on the iPad the note is the centre pane.
 */
@Component({
  selector: 'mc-note',
  imports: [AppBar, McI18nPipe, Markdown],
  templateUrl: './note.html',
  styleUrl: './note.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Note {
  protected readonly store = inject(NotesStore);
  private readonly i18n = inject(McI18n);

  /** The segmented control's order: View first, the two ways to write after it. */
  protected readonly modes: readonly MdMode[] = ['view', 'live', 'source'];
  protected readonly folder = computed(() => {
    const path = this.store.path();
    return path === null ? '' : folderOfPath(path);
  });
  protected readonly when = computed(() => {
    const conflict = this.store.conflict();
    return conflict === null ? '' : this.i18n.formatRelative(new Date(conflict.mtime));
  });

  protected modeLabel(mode: MdMode): string {
    return this.i18n.t(`notes.mode.${mode}`);
  }

  protected pick(mode: MdMode): void {
    this.store.pickMode(mode);
  }

  protected onText(text: string): void {
    this.store.setDraft(text);
  }
}
