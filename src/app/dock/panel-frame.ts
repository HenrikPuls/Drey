import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { I18nPipe } from '../i18n';
import { Icon } from '../icons/icon';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { DockService, DockSide, PanelId } from './dock.service';
import { PanelHeaderActionsStore } from './panel-header-actions';
import { WidgetRegistryService } from './widget-registry.service';

/**
 * The chrome every open dock panel shares (board 9a): a header (a fold
 * chevron + the title + an optional status value + the panel's controls,
 * which show on header hover, keyboard focus or while the panel is active), then the panel body (`<ng-content>`).
 *
 * The body scrolls, except for the assistant panel, which fills the frame
 * and scrolls internally (its own header + composer stay put). A closed
 * panel keeps its frame mounted but undisplayed (`Dock` sets `.closed`), so
 * its state survives; it is reopened from the dock's icon strip.
 *
 * The chevron folds the panel to its header (its strip icon stays on). A
 * drag on the header moves the panel between docks, a right-click opens the
 * menu that moves or closes it; the strip icon opens and closes it.
 */
@Component({
  selector: 'app-panel-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [I18nPipe, Icon, NgTemplateOutlet, OverlayGuardDirective],
  templateUrl: './panel-frame.html',
  styleUrl: './panel-frame.css',
  host: {
    '[class.dragging]': 'isDragging()',
    '[class.active]': 'isActive()',
  },
})
export class PanelFrame implements OnInit {
  private readonly dock = inject(DockService);
  private readonly headerActionsStore = inject(PanelHeaderActionsStore);
  private readonly registry = inject(WidgetRegistryService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly panelId = input.required<PanelId>();
  readonly status = input<string | null>(null);

  /** The header's right-click menu, while open. */
  protected readonly menu = signal<{ readonly x: number; readonly y: number } | null>(null);
  protected readonly collapsed = computed(() => this.dock.collapsed(this.panelId()));
  /** The docks this panel can move to. */
  protected readonly moveTargets = computed<DockSide[]>(() =>
    (['left', 'right', 'bottom'] as const).filter((side) => side !== this.dock.sideOf(this.panelId())),
  );

  protected readonly title = computed(
    () => this.registry.descriptor(this.panelId())?.title ?? this.panelId(),
  );
  /** The panel's own control row, moved into this header (req-7); null if it has none. */
  protected readonly headerActions = computed(() =>
    this.headerActionsStore.get(this.panelId()),
  );
  /**
   * True while the panel's own header content stands in for the title
   * (`WidgetDescriptor.headerReplacesTitle`, the calendar) -- once the
   * content template has registered.
   */
  protected readonly titleReplaced = computed(
    () =>
      this.headerActions() !== null &&
      (this.registry.descriptor(this.panelId())?.headerReplacesTitle ?? false),
  );
  /**
   * Panels whose body fills the frame (a flex column) instead of
   * scrolling: the assistant (own header + composer stay put) and the
   * "Add entry" drawer (its text field grows with the panel).
   */
  protected readonly flush = computed(
    () => this.registry.descriptor(this.panelId())?.flush ?? false,
  );
  /** Plugin widgets bring their header controls as a DOM mount (ADR-0044). */
  protected readonly headerActionsMount = computed(
    () => this.registry.descriptor(this.panelId())?.headerActionsMount,
  );
  private readonly pluginActionsView = viewChild<ElementRef<HTMLDivElement>>('pluginActions');
  protected readonly isDragging = computed(() => this.dock.dragging() === this.panelId());
  /** True while this is the panel the user last interacted with: its header controls show. */
  protected readonly isActive = computed(() => this.dock.activePanel() === this.panelId());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dock.unregisterPanelEl(this.panelId(), this.el));
    // Mount a plugin widget's header controls once their container exists.
    // Reading the signal-based `viewChild` INSIDE the effect tracks it: the
    // effect (re-)runs when the panel id changes or the container is
    // re-created; `onCleanup` disposes the previous mount so listeners
    // never pile up.
    effect((onCleanup) => {
      const mount = this.headerActionsMount();
      const host = this.pluginActionsView()?.nativeElement ?? null;
      if (mount === undefined || host === null) {
        return;
      }
      let dispose: (() => void) | undefined;
      try {
        dispose = mount(host) ?? undefined;
      } catch (error) {
        console.error(`panel "${this.panelId()}" header actions mount failed:`, error);
      }
      onCleanup(() => {
        try {
          dispose?.();
        } catch {
          // A failing plugin dispose must not break the shell teardown.
        }
      });
    });
  }

  ngOnInit(): void {
    this.dock.registerPanelEl(this.panelId(), this.el);
  }

  protected onHeaderPress(event: MouseEvent): void {
    this.dock.beginHeaderPress(this.panelId(), this.title(), event);
  }

  /**
   * A press inside the header controls must not start the drag gesture. A title-replacing row spans the whole header, so there the
   * controls stop their own presses and the gaps between them still reach
   * the header.
   */
  protected onActionsPress(event: Event): void {
    if (!this.titleReplaced()) {
      event.stopPropagation();
    }
  }

  protected toggleCollapsed(): void {
    this.dock.toggleCollapsed(this.panelId());
  }

  protected openMenu(event: MouseEvent): void {
    event.preventDefault();
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 176),
      y: Math.min(event.clientY, window.innerHeight - 150),
    });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected moveTo(side: DockSide): void {
    this.closeMenu();
    this.dock.moveToDock(this.panelId(), side);
  }

  protected closePanel(): void {
    this.closeMenu();
    this.dock.toggle(this.panelId());
  }
}
