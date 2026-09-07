import { Injectable, computed, inject, signal } from '@angular/core';
import {
  EMPTY_ENTRY_DRAFT,
  EntryDraft,
  composeEntry,
  hasEntryContent,
} from '../../../shared/entry-compose';
import { formatDate } from '../../../shared/timestamp';
import { EditorService } from './editor.service';

/** What `submit()` did, so the component knows whether to clear the text field. */
export type SubmitResult = 'appended' | 'empty';

/**
 * State and rules for the "Add entry" drawer. The component only renders
 * and forwards events (CLAUDE.md: no business logic in components).
 *
 * TOPIC is optional -- an empty topic just produces a bare `## HH:mm`
 * heading, no prompt.
 */
@Injectable({ providedIn: 'root' })
export class EntryDraftService {
  private readonly editor = inject(EditorService);

  /** The drawer starts collapsed; the header toggle opens it. */
  readonly open = signal(false);
  readonly topic = signal('');
  readonly text = signal('');
  readonly tags = signal<string[]>([]);

  readonly appending = signal(false);

  readonly draft = computed<EntryDraft>(() => ({
    topic: this.topic(),
    text: this.text(),
    tags: this.tags(),
  }));

  /** Anything to append at all -- drives the primary button. */
  readonly hasContent = computed<boolean>(() => hasEntryContent(this.draft()));

  /** What the entry will look like in the document. Shown as a preview. */
  readonly preview = computed<string>(() => composeEntry(this.draft()));

  toggle(): void {
    this.open.update((open) => !open);
  }

  setTopic(value: string): void {
    this.topic.set(value);
  }

  setText(value: string): void {
    this.text.set(value);
  }

  /** Adds a tag chip, ignoring blanks and duplicates (case-insensitive). */
  addChip(raw: string): void {
    const value = raw.trim().replace(/^#/, '').trim();
    if (value === '') {
      return;
    }
    if (this.tags().some((item) => item.toLowerCase() === value.toLowerCase())) {
      return;
    }
    this.tags.update((list) => [...list, value]);
  }

  removeChip(value: string): void {
    this.tags.update((list) => list.filter((item) => item !== value));
  }

  /** Throws away the draft (the "Discard" button). */
  discard(): void {
    this.topic.set(EMPTY_ENTRY_DRAFT.topic);
    this.text.set(EMPTY_ENTRY_DRAFT.text);
    this.tags.set([]);
  }

  /** "Add to document" -- appends the entry, or reports the draft was empty. */
  async submit(): Promise<SubmitResult> {
    if (!this.hasContent() || this.appending()) {
      return 'empty';
    }
    await this.append();
    return 'appended';
  }

  /**
   * Hands the draft to the editor, which applies it to the live CodeMirror
   * document and saves (see `Editor.applyNewEntryRequest`). Going through
   * the request signal rather than rewriting the buffer here keeps the
   * insertion a normal editor edit -- undoable, caret placed after it --
   * and it is the same path the quick-capture hotkey already uses.
   *
   * Nothing is open? Today's daily note is opened first.
   */
  private async append(): Promise<void> {
    this.appending.set(true);
    try {
      if (this.editor.openPath() === null) {
        await this.editor.openDailyNote(formatDate(new Date()));
        if (this.editor.openPath() === null) {
          return; // no vault -- keep the draft rather than dropping it
        }
      }
      this.editor.requestEntryFromDraft(this.draft());
      this.discard();
    } finally {
      this.appending.set(false);
    }
  }
}
