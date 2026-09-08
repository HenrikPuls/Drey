import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { formatSearchResultsDoc } from '../../../../shared/tags';
import { EditorService } from '../../services/editor.service';
import { Icon } from '../../icons/icon';
import { TagService } from '../../services/tag.service';
import { TagSearchService } from '../tag-search.service';

/**
 * The "Search" panel: a tag-chip input plus a free-text field, a
 * section-granularity results list (click opens the file at the hit's
 * line), and an "Export" button that dumps the hits into an unsaved
 * `search-results.md` tab. The LLM digest is parked
 * (`TagSearchService.summarise` still exists, just not wired here).
 *
 * `embedded` = it lives inside a `PanelFrame` (the dock), which supplies
 * the collapse chevron + "SEARCH" title -- so the component's own head is
 * dropped and the body always shows.
 */
@Component({
  selector: 'app-search-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './search-panel.html',
  styleUrl: './search-panel.css',
})
export class SearchPanel {
  protected readonly search = inject(TagSearchService);
  protected readonly tags = inject(TagService);
  private readonly editor = inject(EditorService);

  /** True when hosted in the dock panel frame -- hide the own head, always show the body. */
  readonly embedded = input(false);

  /** Panel open state lives on the service (pill click / keybinding drive it). */
  protected readonly expanded = this.search.panelOpen;

  protected showBody(): boolean {
    return this.embedded() || this.expanded();
  }

  private readonly tagInput = viewChild<ElementRef<HTMLInputElement>>('tagInput');

  constructor() {
    // The service bumps `focusRequest` when something (Mod+Shift+F, a pill
    // click) opened the panel and wants the cursor in the tag field. The
    // input only exists once the @if branch has rendered.
    effect(() => {
      this.search.focusRequest();
      if (this.search.panelOpen()) {
        setTimeout(() => this.tagInput()?.nativeElement.focus(), 0);
      }
    });
  }

  protected toggle(): void {
    this.search.togglePanel();
  }

  protected onTagKeydown(event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (input.value.trim() !== '') {
        this.search.addTag(input.value);
        input.value = '';
      } else {
        void this.search.run();
      }
      return;
    }
    if (event.key === 'Backspace' && input.value === '') {
      const list = this.search.queryTags();
      if (list.length > 0) {
        this.search.removeTag(list[list.length - 1]);
      }
    }
  }

  protected onTagBlur(event: FocusEvent): void {
    const input = event.target as HTMLInputElement;
    if (input.value.trim() !== '') {
      this.search.addTag(input.value);
      input.value = '';
    }
  }

  protected open(path: string, line: number): void {
    void this.editor.openFileAt(path, line);
  }

  /** Dump the current hits into an unsaved `search-results.md` tab. */
  protected exportDoc(): void {
    const doc = formatSearchResultsDoc(
      { tags: this.search.queryTags(), text: this.search.queryText() },
      this.search.hits(),
    );
    this.editor.openScratch('search-results.md', doc);
  }
}
