import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { MarkdownSurface } from '../editor/markdown-surface/markdown-surface';
import { ChipField, EntryDraftService } from '../services/entry-draft.service';
import { EditorService } from '../services/editor.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { Icon } from '../icons/icon';

/**
 * The "Add entry" drawer at the bottom of the main area: TOPIC first and
 * prominent, then the Tags / People / Meetings chip rows, then the Markdown
 * text. It replaced the old bottom chat bar's capture role.
 *
 * Ordering is not cosmetic. The topic is what the entry is filed under and
 * what the inline spellcheck keys off (`spellcheckApplies`), so it is asked
 * for before the prose rather than after it.
 *
 * The text field is the shared `MarkdownSurface` with the inline
 * spellchecker mixed in -- one editor component everywhere (ADR-0009), one
 * squiggle implementation.
 */
@Component({
  selector: 'app-entry-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MarkdownSurface],
  templateUrl: './entry-drawer.html',
  styleUrl: './entry-drawer.css',
})
export class EntryDrawer {
  protected readonly drawer = inject(EntryDraftService);
  protected readonly editor = inject(EditorService);
  private readonly spellcheck = inject(SpellcheckService);
  private readonly surface = viewChild(MarkdownSurface);

  /**
   * The source handed to the surface. Ungated: checking starts with the
   * first word typed, the same as any editor the user has ever used --
   * an earlier draft only checked "anchored" entries, which meant the
   * squiggles appeared late and looked broken.
   */
  protected readonly spellcheckSource = this.spellcheck.makeSource();

  protected readonly canSubmit = computed<boolean>(
    () => this.drawer.hasContent() && !this.drawer.appending(),
  );

  constructor() {
    // The checker only re-runs on a text change, so toggling spelling (or
    // switching dictionary) in Settings would otherwise leave the current
    // text judged by the old setting until the next keystroke.
    effect(() => {
      this.spellcheck.enabled();
      this.spellcheck.language();
      this.surface()?.recheckSpelling();
    });
  }

  protected readonly chipRows: ReadonlyArray<{ field: ChipField; label: string; add: string }> = [
    { field: 'tags', label: 'TAGS', add: '+ tag' },
    { field: 'people', label: 'PEOPLE', add: '+ person' },
    { field: 'meetings', label: 'MEETINGS', add: '+ meeting' },
  ];

  protected chips(field: ChipField): readonly string[] {
    return field === 'tags'
      ? this.drawer.tags()
      : field === 'people'
        ? this.drawer.people()
        : this.drawer.meetings();
  }

  /** Enter (or comma) commits a chip; Backspace on an empty field removes the last. */
  protected onChipKeydown(event: KeyboardEvent, field: ChipField): void {
    const input = event.target as HTMLInputElement;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      this.drawer.addChip(field, input.value);
      input.value = '';
      return;
    }
    if (event.key === 'Backspace' && input.value === '') {
      const list = this.chips(field);
      if (list.length > 0) {
        this.drawer.removeChip(field, list[list.length - 1]);
      }
    }
  }

  /** A half-typed chip should not be lost when focus moves on. */
  protected onChipBlur(event: FocusEvent, field: ChipField): void {
    const input = event.target as HTMLInputElement;
    if (input.value.trim() !== '') {
      this.drawer.addChip(field, input.value);
      input.value = '';
    }
  }

  protected async submit(force = false): Promise<void> {
    if ((await this.drawer.submit(force)) === 'appended') {
      this.surface()?.setContent('');
    }
  }

  protected discard(): void {
    this.drawer.discard();
    this.surface()?.setContent('');
  }
}
