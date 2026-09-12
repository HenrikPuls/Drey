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
  signal,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { DockService, DockSide, PanelId } from './dock.service';
import { PaneService } from '../panes/pane.service';
import { EditorService } from '../services/editor.service';
import { PanelFrame } from './panel-frame';
import { WidgetRegistryService } from './widget-registry.service';
import { PluginWidgetHost } from '../plugin-host/plugin-widget-host';

/**
 * Resolves the pane component lazily, via a post-boot dynamic `import()`.
 * Importing the pane component subtree statically from `dock.ts` changes
 * the vitest builder's chunk evaluation order and poisons TestBed compiles
 * in unrelated spec files (editor.spec / pane-leaf.spec crash with a
 * `ɵcmp` TypeError) -- a leaf band render is worth neither that nor a
 * restructure of the shared chunk graph, so the band's `PaneLeaf` is
 * resolved on the first microtask after boot instead.
 */
async function loadPaneLeaf(): Promise<Type<unknown> | null> {
  try {
    const m = await import('../panes/pane-leaf');
    return m.PaneLeaf;
  } catch {
    return null;
  }
}

/**
 * One dock column (left or right). Renders its ordered panel list, each in
 * a `PanelFrame` whose body is the registered panel component, with a 7px
 * `row-resize` splitter between a panel and its next open neighbour and a
 * 2px accent drop-line at the live drop position during a panel drag.
 * Above the widget list sits the dock's editor band, when `PaneService` has
 * a pane docked here (ADR-0038): a 32px header (title = the pane's active
 * tab name) over that pane's own `PaneLeaf`, with a splitter against the
 * first widget below. Widths come from `DockService`; the outer-edge
 * resizer is owned by `App`.
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
  protected readonly panes = inject(PaneService);
  protected readonly editor = inject(EditorService);
  private readonly registry = inject(WidgetRegistryService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly side = input.required<DockSide>();

  protected readonly ids = computed<PanelId[]>(() => this.dock.idsFor(this.side()));
  protected readonly isEmpty = computed(() => this.ids().length === 0);
  /** The pane docked in this dock's editor band, if any (ADR-0038). */
  protected readonly bandPaneId = computed(() => this.panes.dockPane(this.side()));
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
      // An editor band gives the dock its height when no widget does.
      if (this.bandPaneId()) {
        return this.panes.bandHeight('bottom');
      }
      return this.dock.dragActive() ? 140 : null;
    }
    return this.dock.allCollapsed('bottom') ? null : this.dock.dockHeight();
  });
  protected readonly isDropTarget = computed(() => this.dock.dropDock() === this.side());

  /**
   * The band's `PaneLeaf` component, resolved by `loadPaneLeaf()` shortly
   * after boot (see the function's doc); null until then -- the band block
   * in the template simply renders nothing.
   */
  protected readonly bandLeaf = signal<Type<unknown> | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dock.unregisterDockEl(this.side(), this.el));
    void loadPaneLeaf().then((leaf) => this.bandLeaf.set(leaf));
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

  /** The band header's live title: the docked pane's active tab name. */
  protected bandTitle(paneId: string): string {
    const pane = this.panes.pane(paneId);
    const doc = pane?.active
      ? this.editor.docFor(pane.active)
      : undefined;
    return doc?.name ?? 'Editor';
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
    // Reading the tick here tracks it for this view: a bump (any document /
    // vault event the host fanned out) re-renders the headers, so plugin
    // statuses go stale only until the next event they could react to.
    this.registry.statusVersion();
    return this.registry.descriptor(id)?.status?.({ collapsed: this.dock.collapsed(id) }) ?? null;
  }
}
