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
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DockService, PanelId } from './dock.service';
import { PanelHeaderActionsStore } from './panel-header-actions';
import { WidgetRegistryService } from './widget-registry.service';

/**
 * The chrome every dock panel shares (DESIGN.md principle 3): a 32px
 * low-profile header (the mono-uppercase title + an optional status value +
 * a drag grip), then the panel body (`<ng-content>`).
 *
 * The body scrolls, except for the assistant panel, which fills the frame
 * and scrolls internally (its own header + composer stay put). It stays
 * mounted while collapsed so its state survives; `.body-wrap` animates the
 * height between the two.
 *
 * `mousedown` on the header opens a press gesture in `DockService`: a click
 * (no movement) toggles collapse, a drag past the threshold moves the panel
 * between docks. Enter / Space on the focused header also toggles.
 */
@Component({
  selector: 'app-panel-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: './panel-frame.html',
  styleUrl: './panel-frame.css',
  host: {
    '[class.dragging]': 'isDragging()',
  },
})
export class PanelFrame implements OnInit {
  private readonly dock = inject(DockService);
  private readonly headerActionsStore = inject(PanelHeaderActionsStore);
  private readonly registry = inject(WidgetRegistryService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly panelId = input.required<PanelId>();
  readonly status = input<string | null>(null);

  protected readonly title = computed(
    () => this.registry.descriptor(this.panelId())?.title ?? this.panelId(),
  );
  /** The panel's own control row, moved into this header (req-7); null if it has none. */
  protected readonly headerActions = computed(() =>
    this.headerActionsStore.get(this.panelId()),
  );
  protected readonly collapsed = computed(() => this.dock.collapsed(this.panelId()));
  /**
   * True while the panel's own header content stands in for the title
   * (`WidgetDescriptor.headerReplacesTitle`, the calendar): expanded, and
   * the content template has registered.
   */
  protected readonly titleReplaced = computed(
    () =>
      !this.collapsed() &&
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

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dock.unregisterPanelEl(this.panelId(), this.el));
    // Mount a plugin widget's header controls once their container exists.
    // Reading the signal-based `viewChild` INSIDE the effect tracks it: the
    // effect (re-)runs when the panel id changes or the container re-appears
    // after a collapse/expand cycle (a panel that starts collapsed mounts
    // its controls on first expand -- the old container, and the controls
    // mounted into it, go away with the `@if`); `onCleanup` disposes the
    // previous mount so listeners never pile up.
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
   * A press inside the header controls must not start the collapse / drag
   * gesture. A title-replacing row spans the whole header, so there the
   * controls stop their own presses and the gaps between them still reach
   * the header.
   */
  protected onActionsPress(event: Event): void {
    if (!this.titleReplaced()) {
      event.stopPropagation();
    }
  }

  protected onHeaderKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.dock.toggleCollapse(this.panelId());
    }
  }
}
