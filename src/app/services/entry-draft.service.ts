import { Injectable, computed, inject, signal } from '@angular/core';
import {
  EMPTY_ENTRY_DRAFT,
  EntryDraft,
  composeEntry,
  hasEntryContent,
} from '../../../shared/entry-compose';
import { formatDate } from '../../../shared/timestamp';
import { EditorService } from './editor.service';

/** The three chip rows, in the order the drawer shows them. */
export type ChipField = 'tags' | 'people' | 'meetings';

/**
 * State and rules for the "Add entry" drawer. The component only renders
 * and forwards events (CLAUDE.md: no business logic in components).
 *
 * The one rule with teeth is the topic prompt: submitting with an empty
 * TOPIC does not append silently, it raises an inline confirmation, and
 * only the second, explicit press appends. A set topic appends straight
 * away. That is why `submit()` returns what happened rather than a boolean
 * -- the component has to know whether to show the bar.
 */
export type SubmitResult = 'appended' | 'needs-topic-confirmation' | 'empty';

@Injectable({ providedIn: 'root' })
export class EntryDraftService {
  private readonly editor = inject(EditorService);

  /** The drawer starts collapsed; the header toggle opens it. */
  readonly open = signal(false);
  readonly topic = signal('');
  readonly text = signal('');
  readonly tags = signal<string[]>([]);
  readonly people = signal<string[]>([]);
  readonly meetings = signal<string[]>([]);

  /** True while the "no topic given" confirmation bar is showing. */
  readonly confirmingNoTopic = signal(false);
  readonly appending = signal(false);

  readonly draft = computed<EntryDraft>(() => ({
    topic: this.topic(),
    text: this.text(),
    tags: this.tags(),
    people: this.people(),
    meetings: this.meetings(),
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
    if (value.trim() !== '') {
      this.confirmingNoTopic.set(false);
    }
  }

  setText(value: string): void {
    this.text.set(value);
  }

  /** Adds a chip, ignoring blanks and duplicates (case-insensitive). */
  addChip(field: ChipField, raw: string): void {
    const value = raw
      .trim()
      .replace(/^#/, '')
      .replace(/^\[\[|\]\]$/g, '')
      .trim();
    if (value === '') {
      return;
    }
    const target = this.chipSignal(field);
    if (target().some((item) => item.toLowerCase() === value.toLowerCase())) {
      return;
    }
    target.update((list) => [...list, value]);
  }

  removeChip(field: ChipField, value: string): void {
    this.chipSignal(field).update((list) => list.filter((item) => item !== value));
  }

  /** Throws away the draft (the "Discard" button). */
  discard(): void {
    this.topic.set(EMPTY_ENTRY_DRAFT.topic);
    this.text.set(EMPTY_ENTRY_DRAFT.text);
    this.tags.set([]);
    this.people.set([]);
    this.meetings.set([]);
    this.confirmingNoTopic.set(false);
  }

  /**
   * "Add to document". With a topic set it appends; without one it asks
   * first and appends on the second call (`force`).
   */
  async submit(force = false): Promise<SubmitResult> {
    if (!this.hasContent() || this.appending()) {
      return 'empty';
    }
    if (this.topic().trim() === '' && !force) {
      this.confirmingNoTopic.set(true);
      return 'needs-topic-confirmation';
    }
    await this.append();
    return 'appended';
  }

  /** Dismisses the inline confirmation without appending. */
  cancelNoTopic(): void {
    this.confirmingNoTopic.set(false);
  }

  /**
   * Hands the draft to the editor, which applies it to the live CodeMirror
   * document and saves (see `Editor.applyNewEntryRequest`). Going through
   * the request signal rather than rewriting the buffer here keeps the
   * insertion a normal editor edit -- undoable, caret placed after it --
   * and it is the same path the quick-capture hotkey already uses.
   *
   * Nothing is open? Today's daily note is opened first, exactly as the
   * old capture bar did.
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

  private chipSignal(field: ChipField) {
    return field === 'tags' ? this.tags : field === 'people' ? this.people : this.meetings;
  }
}
