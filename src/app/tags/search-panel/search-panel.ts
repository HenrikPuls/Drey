import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { EditorService } from '../../services/editor.service';
import { Icon } from '../../icons/icon';
import { TagService } from '../../services/tag.service';
import { TagSearchService } from '../tag-search.service';

/**
 * The collapsible "Search" section in the sidebar: a tag-chip input plus a
 * free-text field, a results list on heading/section granularity, and (from
 * 11.6) a "Summarise" button. A result click opens the file at the hit's
 * line via `EditorService.openFileAt`.
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

  protected readonly expanded = signal(false);

  protected toggle(): void {
    this.expanded.update((v) => !v);
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
}
