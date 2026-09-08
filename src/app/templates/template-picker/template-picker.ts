import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TemplateEntry, TemplateLibraryService } from '../template-library.service';

/**
 * The `Mod+T` template picker: an overlay listing every template by name.
 * With an empty filter the last few used templates sit on top; typing
 * filters the full list by name or path. Arrow keys move the selection,
 * Enter inserts, Esc closes.
 */
@Component({
  selector: 'app-template-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './template-picker.html',
  styleUrl: './template-picker.css',
})
export class TemplatePicker {
  protected readonly library = inject(TemplateLibraryService);

  protected readonly filter = signal('');
  protected readonly activeIndex = signal(0);

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  /** How many leading `visible()` rows are the "recent" group (0 while filtering). */
  protected readonly recentCount = computed(() =>
    this.filter().trim() === '' ? this.library.recent().length : 0,
  );

  /** The rows shown right now: recent group first, then the rest / the filtered matches. */
  protected readonly visible = computed<TemplateEntry[]>(() => {
    const query = this.filter().trim().toLowerCase();
    const all = this.library.all();
    if (query === '') {
      const recent = this.library.recent();
      const recentPaths = new Set(recent.map((t) => t.relativePath));
      return [...recent, ...all.filter((t) => !recentPaths.has(t.relativePath))];
    }
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(query) || t.relativePath.toLowerCase().includes(query),
    );
  });

  constructor() {
    effect(() => {
      if (this.library.pickerOpen()) {
        this.filter.set('');
        this.activeIndex.set(0);
        setTimeout(() => this.input()?.nativeElement.focus(), 0);
      }
    });
    // Keep the highlighted row in range as the list shrinks under the filter.
    effect(() => {
      const max = Math.max(0, this.visible().length - 1);
      if (this.activeIndex() > max) {
        this.activeIndex.set(max);
      }
    });
  }

  protected onFilter(value: string): void {
    this.filter.set(value);
    this.activeIndex.set(0);
  }

  protected move(delta: number): void {
    const len = this.visible().length;
    if (len === 0) {
      return;
    }
    this.activeIndex.update((i) => (i + delta + len) % len);
  }

  protected choose(entry: TemplateEntry): void {
    void this.library.insert(entry.relativePath);
    this.library.closePicker();
  }

  protected confirmActive(): void {
    const entry = this.visible()[this.activeIndex()];
    if (entry) {
      this.choose(entry);
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.library.pickerOpen()) {
      this.library.closePicker();
    }
  }
}
