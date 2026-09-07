import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { MarkdownSurface } from '../editor/markdown-surface/markdown-surface';
import { EntryDraftService } from '../services/entry-draft.service';
import { EditorService } from '../services/editor.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { AutotagButton } from '../tags';
import { Icon } from '../icons/icon';

/**
 * The "Add entry" drawer at the bottom of the main area: an optional TOPIC,
 * a row of tag chips, then the Markdown text. It replaced the old bottom
 * chat bar's capture role.
 *
 * The text field is the shared `MarkdownSurface` with the inline
 * spellchecker mixed in -- one editor component everywhere (ADR-0009), one
 * squiggle implementation.
 */
@Component({
  selector: 'app-entry-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MarkdownSurface, AutotagButton],
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

  /** Enter (or comma) commits a tag chip; Backspace on an empty field removes the last. */
  protected onChipKeydown(event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      this.drawer.addChip(input.value);
      input.value = '';
      return;
    }
    if (event.key === 'Backspace' && input.value === '') {
      const list = this.drawer.tags();
      if (list.length > 0) {
        this.drawer.removeChip(list[list.length - 1]);
      }
    }
  }

  /** A half-typed chip should not be lost when focus moves on. */
  protected onChipBlur(event: FocusEvent): void {
    const input = event.target as HTMLInputElement;
    if (input.value.trim() !== '') {
      this.drawer.addChip(input.value);
      input.value = '';
    }
  }

  protected async submit(): Promise<void> {
    if ((await this.drawer.submit()) === 'appended') {
      this.surface()?.setContent('');
    }
  }

  protected discard(): void {
    this.drawer.discard();
    this.surface()?.setContent('');
  }
}
