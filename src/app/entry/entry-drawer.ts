import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { MarkdownSurface } from '../editor/markdown-surface/markdown-surface';
import { EntryDraftService } from './entry-draft.service';
import { EditorService } from '../services/editor.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { AutotagButton } from './autotag-button';

/**
 * The "Add entry" panel body: an optional TOPIC, a row of tag chips, then
 * the Markdown text. It replaced the old bottom chat bar's capture role,
 * and is now a dock panel (default home: the bottom dock) rather than a
 * fixed strip -- the `PanelFrame` chevron handles show/hide, so this
 * component no longer draws its own toggle.
 *
 * The text field is the shared `MarkdownSurface` with the inline
 * spellchecker mixed in -- one editor component everywhere (ADR-0009), one
 * squiggle implementation.
 */
@Component({
  selector: 'app-entry-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownSurface, AutotagButton],
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

  /**
   * `Ctrl`/`Cmd`-click on a Markdown link in the capture body. The drawer
   * has no "current note" to resolve a relative path against, so only web /
   * mail targets act -- they open in the OS browser (Req-5); anything else
   * is left alone.
   */
  protected readonly activateLink = (href: string): void => {
    const raw = href.trim();
    if (/^(https?:|mailto:)/i.test(raw)) {
      void window.dreyApi.openExternal(raw);
    }
  };

  protected readonly canSubmit = computed<boolean>(
    () => this.drawer.hasContent() && !this.drawer.appending(),
  );

  /** "N words · N chars" for the footer, from the body text. */
  protected readonly bodyCount = computed<string>(() => {
    const text = this.drawer.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return '';
    }
    return `${trimmed.split(/\s+/).length} words · ${text.length} chars`;
  });

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
