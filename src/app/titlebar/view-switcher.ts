import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from '../icons/icon';
import { KeybindingService } from '../keybindings';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { ViewService, type ViewDef } from '../views';

/** More views than this fold into a menu instead of a segmented control. */
export const SEGMENT_LIMIT = 4;

interface ViewMenu {
  readonly x: number;
  readonly y: number;
  readonly view: ViewDef | null;
}

/**
 * The title bar's view switcher (ADR-0089): a segmented control with one
 * button per view, a menu when there are more than {@link SEGMENT_LIMIT}.
 * With only Notes there is nothing to switch, so it draws nothing. Also
 * hosts the name field of "Save current layout as a view…" / rename, and
 * the right-click menu of a user view (Rename / Delete).
 */
@Component({
  selector: 'app-view-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, OverlayGuardDirective],
  templateUrl: './view-switcher.html',
  styleUrl: './view-switcher.css',
})
export class ViewSwitcher {
  protected readonly views = inject(ViewService);
  protected readonly keys = inject(KeybindingService);

  protected readonly folded = computed(() => this.views.views().length > SEGMENT_LIMIT);
  protected readonly menu = signal<ViewMenu | null>(null);
  protected readonly rejected = signal(false);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('name');

  constructor() {
    effect(() => {
      const input = this.nameInput();
      if (input !== undefined) {
        input.nativeElement.focus();
        input.nativeElement.select();
      }
    });
  }

  protected titleOf(view: ViewDef, index: number): string {
    return this.keys.titled(view.label, `view.switch.${index + 1}`);
  }

  protected openMenu(event: MouseEvent, view: ViewDef | null): void {
    if (view !== null && view.builtin) {
      return;
    }
    event.preventDefault();
    this.menu.set({ x: Math.min(event.clientX, window.innerWidth - 168), y: event.clientY + 4, view });
  }

  protected openList(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ x: rect.left, y: rect.bottom + 4, view: null });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected pick(view: ViewDef): void {
    this.closeMenu();
    this.views.switchTo(view.id);
  }

  protected rename(view: ViewDef): void {
    this.closeMenu();
    this.views.openRenamePrompt(view.id);
  }

  protected remove(view: ViewDef): void {
    this.closeMenu();
    void this.views.remove(view.id);
  }

  protected saveAs(): void {
    this.closeMenu();
    this.views.openSavePrompt();
  }

  protected commit(value: string): void {
    this.rejected.set(!this.views.commitPrompt(value));
  }

  protected cancel(): void {
    this.rejected.set(false);
    this.views.cancelPrompt();
  }
}
