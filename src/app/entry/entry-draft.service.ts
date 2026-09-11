import { Injectable, computed, inject, signal } from '@angular/core';
import {
  EMPTY_ENTRY_DRAFT,
  EntryDraft,
  composeEntry,
  hasEntryContent,
} from '../../../shared/entry-compose';
import { formatDate } from '../../../shared/timestamp';
/** The tag-name grammar (local copy: the tags feature is a plugin now). */
const TAG_NAME_SOURCE = String.raw`\p{L}[\p{L}\p{N}_-]*(?:/[\p{L}\p{N}_-]+)*`;
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';

/**
 * `#` + the canonical tag-name grammar (shared/tags), global. The drawer
 * lifts these into chips as the user types; unlike the main index it does
 * not skip code spans, which is fine for a short capture field.
 */
const TAG_IN_TEXT = new RegExp(`#(${TAG_NAME_SOURCE})`, 'gu');

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
  private readonly settings = inject(SettingsService);

  /** The drawer starts collapsed; the header toggle opens it. */
  readonly open = signal(false);
  readonly topic = signal('');
  readonly text = signal('');
  readonly tags = signal<string[]>([]);

  /** Lowercase names of tags the user added by hand, so re-recognition keeps them. */
  private readonly manualTags = new Set<string>();

  readonly appending = signal(false);

  readonly draft = computed<EntryDraft>(() => ({
    topic: this.topic(),
    text: this.text(),
    tags: this.tags(),
  }));

  /** Anything to append at all -- drives the primary button. */
  readonly hasContent = computed<boolean>(() => hasEntryContent(this.draft()));

  /** What the entry will look like in the document, using the active template. */
  readonly preview = computed<string>(() =>
    composeEntry(this.draft(), this.settings.activeEntryPattern()),
  );

  toggle(): void {
    this.open.update((open) => !open);
  }

  setTopic(value: string): void {
    this.topic.set(value);
  }

  /**
   * Sets the text content and automatically extracts #tags from it.
   * If a tag from the text is not already in the tags list, it will be added.
   * Also removes tags that are no longer in the text but were not manually added.
   */
  setText(value: string): void {
    this.text.set(value);
    this.extractTagsFromText(value);
    this.syncTagsWithText(value);
  }

  /** Adds a tag chip, ignoring blanks and duplicates (case-insensitive). */
  addChip(raw: string): void {
    const value = raw.trim().replace(/^#/, '').trim();
    if (value === '') {
      return;
    }
    if (this.tags().some((item) => item.toLowerCase() === value.toLowerCase())) {
      this.manualTags.add(value.toLowerCase());
      return;
    }
    this.tags.update((list) => [...list, value]);
    this.manualTags.add(value.toLowerCase());
  }

  /**
   * Removes a tag chip and also removes the corresponding #tag from the text
   * if it exists.
   */
  removeChip(value: string): void {
    this.tags.update((list) => list.filter((item) => item !== value));
    this.manualTags.delete(value.toLowerCase());
    // Remove the tag from the text if it exists
    const text = this.text();
    const tagPattern = new RegExp(`#\\s*${value}\\s*(?=\\s|$)`, 'g');
    const newText = text.replace(tagPattern, '');
    if (newText !== text) {
      this.text.set(newText);
    }
  }

  /** Throws away the draft (the "Discard" button). */
  discard(): void {
    this.topic.set(EMPTY_ENTRY_DRAFT.topic);
    this.text.set(EMPTY_ENTRY_DRAFT.text);
    this.tags.set([]);
    this.manualTags.clear();
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
      this.editor.requestEntryFromDraft(this.draft(), this.settings.activeEntryPattern());
      this.discard();
    } finally {
      this.appending.set(false);
    }
  }

  /**
   * Extracts tags from the text and adds them to the tags list if they're not already present.
   * This is called whenever the text content changes.
   */
  private extractTagsFromText(text: string): void {
    const matches = [...text.matchAll(TAG_IN_TEXT)];

    const newTags = matches
      .map((match) => match[1])
      .filter(
        (tag) =>
          !this.tags().some((existingTag) => existingTag.toLowerCase() === tag.toLowerCase()),
      );

    if (newTags.length > 0) {
      this.tags.update((list) => [...list, ...newTags]);
    }
  }

  /**
   * Synchronizes tags with the text content.
   * Removes tags that are no longer in the text but were not manually added.
   */
  private syncTagsWithText(text: string): void {
    const matches = [...text.matchAll(TAG_IN_TEXT)];
    const textTags = matches.map((match) => match[1].toLowerCase());

    this.tags.update((list) => {
      return list.filter((item) => {
        // Manually added tags stay; otherwise only the ones currently in the text.
        return this.isManual(item) || textTags.includes(item.toLowerCase());
      });
    });
  }

  private isManual(item: string): boolean {
    return this.manualTags.has(item.toLowerCase());
  }
}
