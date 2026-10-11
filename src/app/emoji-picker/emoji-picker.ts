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
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { EMOJI_NAMES, emojiFor, searchEmojiNames } from '../../../shared/markdown/emoji';
import { EmojiPickerService } from './emoji-picker.service';
import { loadEmojiRecents } from './emoji-recents';

/**
 * The `:emoji:` picker overlay (milestone 72, ADR-0070): rendered at App
 * level like the editor context menu, anchored at the caret of the surface
 * that opened it. Search field + glyph grid over the curated gemoji table
 * (recents first when the search is blank), keyboard-driven (arrows walk,
 * Enter picks, Escape closes) and mouse-driven alike; the footer previews
 * the active option's `:shortcode:`. Picking goes through the service's
 * single insert path.
 */
@Component({
  selector: 'app-emoji-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './emoji-picker.html',
  styleUrl: './emoji-picker.css',
})
export class EmojiPicker {
  protected readonly svc = inject(EmojiPickerService);
  private readonly host = inject(ElementRef<HTMLElement>);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  /** The live search text; reset per open. */
  protected readonly query = signal('');

  /** Index of the keyboard-active option in `options()`. */
  protected readonly active = signal(0);

  /**
   * The offered names: the recents (deduped) ahead of the full table when
   * the search is blank, otherwise the shared prefix-then-substring search.
   */
  protected readonly options = computed(() => {
    const q = this.query().trim();
    if (q !== '') {
      return searchEmojiNames(q, EMOJI_NAMES.length);
    }
    const recents = this.recents();
    const seen = new Set(recents);
    return [...recents, ...EMOJI_NAMES.filter((name) => !seen.has(name))];
  });

  /** Recents reloaded per open (a pick in between must show up next time). */
  protected readonly recents = computed(() => {
    if (this.svc.request() === null) {
      return [];
    }
    try {
      return loadEmojiRecents(globalThis.localStorage);
    } catch {
      return [];
    }
  });

  /** The footer preview: the active option's glyph + `:name:`. */
  protected readonly preview = computed(() => {
    const name = this.options()[this.active()];
    return name === undefined ? null : { glyph: emojiFor(name) ?? '❓', name };
  });

  constructor() {
    // A fresh open resets the search and lands focus in the field; the
    // requestAnimationFrame waits for the @if to paint the input.
    effect((onCleanup) => {
      if (this.svc.request() === null) {
        return;
      }
      this.query.set('');
      this.active.set(0);
      const raf = requestAnimationFrame(() => this.searchInput()?.nativeElement.focus());
      onCleanup(() => cancelAnimationFrame(raf));
    });
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  protected onKey(event: KeyboardEvent): void {
    const count = this.options().length;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.svc.close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (count > 0) {
        this.active.set((this.active() + 1) % count);
        this.scrollActiveIntoView();
      }
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      if (count > 0) {
        this.active.set((this.active() - 1 + count) % count);
        this.scrollActiveIntoView();
      }
    } else if (event.key === 'Enter') {
      const name = this.options()[this.active()];
      if (name !== undefined) {
        event.preventDefault();
        this.pick(name);
      }
    }
  }

  protected pick(name: string): void {
    this.svc.insert(name);
  }

  /** The glyph for a name (the template's one-liner over the shared lookup). */
  protected glyphOf(name: string): string {
    return emojiFor(name) ?? '❓';
  }

  /** Keeps the keyboard-active cell visible in the scrolling grid. */
  private scrollActiveIntoView(): void {
    requestAnimationFrame(() => {
      this.host.nativeElement
        .querySelector('.emoji-cell.on')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.svc.close();
  }
}
