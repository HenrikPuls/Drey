import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AppBar } from '../app-bar/app-bar';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { NotesStore } from './notes.store';
import { hitSnippetOf, parentFolderOf, type NoteEntry, type NoteSearchHit } from './notes.model';

/**
 * The Notes list (req-101, boards 10k and 10n's left pane): the search field
 * over the whole vault, the recent notes, then the folders and notes of the
 * open folder — the active vault's name is the header's line. On the phone
 * it is the Notes screen ("Menu" back, the shell's), on the iPad the left
 * pane beside the open note. Everything is read through `NotesStore`.
 */
@Component({
  selector: 'mc-notes',
  imports: [AppBar, McI18nPipe],
  templateUrl: './notes.html',
  styleUrl: './notes.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Notes {
  protected readonly store = inject(NotesStore);
  private readonly i18n = inject(McI18n);

  /** The new-note field is open; its refusal text sits under it. */
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

  constructor() {
    void this.store.loadHome();
  }

  protected onQuery(event: Event): void {
    this.store.setQuery((event.target as HTMLInputElement).value);
  }

  protected age(entry: NoteEntry): string {
    return this.i18n.formatRelative(new Date(entry.mtime));
  }

  protected snippet(hit: NoteSearchHit): string {
    return hitSnippetOf(hit);
  }

  protected folderLabel(): string {
    const folder = this.store.folder();
    return folder.slice(folder.lastIndexOf('/') + 1);
  }

  protected parentPath(): string {
    return parentFolderOf(this.store.folder());
  }

  protected openNote(path: string): void {
    void this.store.open(path);
  }

  protected toggleCreate(): void {
    this.creating.update((open) => !open);
    this.createError.set(null);
  }

  protected async onCreate(event: Event, field: HTMLInputElement): Promise<void> {
    event.preventDefault();
    const error = await this.store.create(field.value);
    this.createError.set(error);
    if (error === null) {
      this.creating.set(false);
    }
  }
}
