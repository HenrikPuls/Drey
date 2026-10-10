import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { PaletteItem, PaletteService } from './palette.service';

/**
 * The quick switcher / command palette overlay (milestone 59): one text
 * field over one list. Focus never leaves the field -- arrows move the
 * highlighted row, Enter runs it (Ctrl+Enter opens a file beside the
 * current tab), Escape or a click outside closes. View-only; the lists
 * and the actions live in `PaletteService`.
 */
@Component({
  selector: 'app-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './palette.html',
  styleUrl: './palette.css',
})
export class Palette {
  protected readonly palette = inject(PaletteService);
  protected readonly items = this.palette.items;

  /** Index of the highlighted row. */
  protected readonly active = signal(0);

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  constructor() {
    // Opening (or re-opening on the other list) focuses the field with the
    // caret behind the `>`.
    effect(() => {
      const input = this.field()?.nativeElement;
      if (this.palette.open() && input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    });
    effect(() => {
      this.palette.query();
      this.active.set(0);
    });
    effect(() => {
      const index = this.active();
      this.list()?.nativeElement.children.item(index)?.scrollIntoView({ block: 'nearest' });
    });
  }

  protected onInput(value: string): void {
    this.palette.query.set(value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.items().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((i) => (count === 0 ? 0 : (i + 1) % count));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((i) => (count === 0 ? 0 : (i - 1 + count) % count));
        break;
      case 'Enter': {
        event.preventDefault();
        const item = this.items()[this.active()];
        if (item) {
          this.run(item, event.ctrlKey || event.metaKey);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.palette.close();
        break;
    }
  }

  protected run(item: PaletteItem, alongside: boolean): void {
    this.palette.run(item, alongside);
  }
}
