import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  Type,
  computed,
  inject,
  input,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { DockService, DockSide, PanelId } from './dock.service';
import { PanelFrame } from './panel-frame';
import { WidgetRegistryService } from './widget-registry.service';
import { PluginWidgetHost } from '../plugin-host/plugin-widget-host';

/**
 * One dock column (left or right). Renders its ordered panel list, each in
 * a `PanelFrame` whose body is the registered panel component, with a 7px
 * `row-resize` splitter between a panel and its next open neighbour and a
 * 2px accent drop-line at the live drop position during a panel drag.
 * Widths come from `DockService`; the outer-edge resizer is owned by `App`.
 */
@Component({
  selector: 'app-dock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet, PanelFrame],
  templateUrl: './dock.html',
  styleUrl: './dock.css',
  host: {
    '[style.width.px]': 'hostWidth()',
    '[style.minWidth.px]': 'hostWidth()',
    '[style.height.px]': 'hostHeight()',
    '[class.bottom]': 'side() === "bottom"',
    '[class.drop-target]': 'isDropTarget()',
    '[class.drag-active]': 'dock.dragActive() && isEmpty()',
  },
})
export class Dock implements OnInit {
  protected readonly dock = inject(DockService);
  private readonly registry = inject(WidgetRegistryService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly side = input.required<DockSide>();

  protected readonly ids = computed<PanelId[]>(() => this.dock.idsFor(this.side()));
  protected readonly isEmpty = computed(() => this.ids().length === 0);
  /** A side dock is width-sized; the bottom dock is height-sized. */
  protected readonly hostWidth = computed(() =>
    this.side() === 'bottom' ? null : this.dock.dockWidth(this.side()),
  );
  protected readonly hostHeight = computed(() => {
    if (this.side() !== 'bottom') {
      return null;
    }
    // While a panel is being dragged, an emptied bottom dock still shows a
    // band so it stays a reachable drop target (otherwise it collapses to
    // 0 and nothing can be dropped back into it).
    if (this.isEmpty()) {
      return this.dock.dragActive() ? 140 : null;
    }
    return this.dock.allCollapsed('bottom') ? null : this.dock.dockHeight();
  });
  protected readonly isDropTarget = computed(() => this.dock.dropDock() === this.side());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dock.unregisterDockEl(this.side(), this.el));
  }

  ngOnInit(): void {
    this.dock.registerDockEl(this.side(), this.el);
  }

  protected component(id: PanelId): Type<unknown> {
    // Plugin widgets render through the generic DOM host (no Angular
    // coupling for plugin code, ADR-0044); core widgets are components.
    return this.registry.isPlugin(id)
      ? PluginWidgetHost
      : this.registry.widgetMap().get(id)!.component!;
  }

  /** `PluginWidgetHost` needs the widget id; core panels take no inputs. */
  protected componentInputs(id: PanelId): Record<string, unknown> | undefined {
    return this.registry.isPlugin(id) ? { widgetId: id } : undefined;
  }

  protected flexStyle(id: PanelId): string {
    return this.dock.collapsed(id) || this.dock.contentHeight(id)
      ? '0 0 auto'
      : `${this.dock.flexOf(id)} 1 0%`;
  }

  protected splitTarget(id: PanelId): PanelId | null {
    if (this.dock.collapsed(id) || this.dock.contentHeight(id)) {
      return null;
    }
    const next = this.dock.nextOpenId(id);
    // No splitter on the edge of a content-sized panel -- it can't give or
    // take height.
    return next && this.dock.contentHeight(next) ? null : next;
  }

  protected dropBefore(i: number): boolean {
    return this.isDropTarget() && this.dock.dropIndex() === i;
  }

  protected dropAtEnd(i: number, len: number): boolean {
    return this.isDropTarget() && this.dock.dropIndex() === len && i === len - 1;
  }

  /** The value shown in the panel header, right before the grip. */
  protected statusFor(id: PanelId): string | null {
    return this.registry.descriptor(id)?.status?.({ collapsed: this.dock.collapsed(id) }) ?? null;
  }
}
