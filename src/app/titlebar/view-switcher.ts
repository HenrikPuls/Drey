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
import { I18nPipe, I18nService } from '../i18n';
import { Icon } from '../icons/icon';
import { KeybindingService } from '../keybindings';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { ViewService, type ViewDef } from '../views';

/** More views than this fold into a menu instead of a segmented control. */
export const SEGMENT_LIMIT = 4;

type MenuKind = 'layout' | 'list' | 'view';

interface ViewMenu {
  readonly x: number;
  readonly y: number;
  readonly kind: MenuKind;
  /** The view a right-click menu belongs to. */
  readonly view: ViewDef | null;
}

/**
 * The title bar's view switcher (ADR-0089, boards 7h/7i): ONE segmented
 * control with a button per view (a menu when there are more than
 * {@link SEGMENT_LIMIT}), a dot on the view whose working layout differs
 * from its saved one, and ONE "Layout" menu for everything that keeps or
 * changes a view -- save, reset to the saved layout, save as a new view,
 * rename, delete -- with "Edit views…" as its footer. Selecting a view
 * never changes it (D-6): only "Save layout" does. With only Notes there
 * is nothing to switch, so it draws nothing. Also hosts the name field
 * of "Save as new view…" / rename, the right-click menu of a user view
 * and the "Edit views" list.
 */
@Component({
  selector: 'app-view-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [I18nPipe, Icon, OverlayGuardDirective],
  templateUrl: './view-switcher.html',
  styleUrl: './view-switcher.css',
})
export class ViewSwitcher {
  protected readonly views = inject(ViewService);
  protected readonly keys = inject(KeybindingService);
  private readonly i18n = inject(I18nService);

  protected readonly folded = computed(() => this.views.views().length > SEGMENT_LIMIT);
  protected readonly menu = signal<ViewMenu | null>(null);
  protected readonly editing = signal(false);
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
    const base = this.views.modified() && view.id === this.views.activeId() ? this.i18n.t('views.unsaved_title', { view: view.label }) : view.label;
    return this.keys.titled(base, `view.switch.${index + 1}`);
  }

  protected openMenu(event: MouseEvent, view: ViewDef): void {
    if (view.builtin) {
      return;
    }
    event.preventDefault();
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 168),
      y: event.clientY + 4,
      kind: 'view',
      view,
    });
  }

  protected openList(event: MouseEvent): void {
    this.openBelow(event, 'list');
  }

  protected openLayout(event: MouseEvent): void {
    this.openBelow(event, 'layout');
  }

  private openBelow(event: MouseEvent, kind: MenuKind): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
      y: rect.bottom + 4,
      kind,
      view: null,
    });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected pick(view: ViewDef): void {
    this.closeMenu();
    this.views.switchTo(view.id);
  }

  protected save(): void {
    this.closeMenu();
    this.views.saveActive();
  }

  protected reset(): void {
    this.closeMenu();
    void this.views.revertActive();
  }

  protected saveAs(): void {
    this.closeMenu();
    this.views.openSavePrompt();
  }

  protected rename(view: ViewDef): void {
    this.closeMenu();
    this.editing.set(false);
    this.views.openRenamePrompt(view.id);
  }

  protected remove(view: ViewDef): void {
    this.closeMenu();
    void this.views.remove(view.id);
  }

  protected editViews(): void {
    this.closeMenu();
    this.editing.set(true);
  }

  protected closeEditor(): void {
    this.editing.set(false);
  }

  protected commit(value: string): void {
    this.rejected.set(!this.views.commitPrompt(value));
  }

  protected cancel(): void {
    this.rejected.set(false);
    this.views.cancelPrompt();
  }
}
