import { ChangeDetectionStrategy, Component, HostListener, computed, inject, input, signal } from '@angular/core';
import { EditorService, type OpenDoc } from '../services/editor.service';
import { DocKindRegistry } from '../plugin-host';
import { PaneService, type PaneRegion } from '../panes/pane.service';
import { TabDragService } from './tab-drag.service';
import { Icon, type IconName } from '../icons/icon';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';

interface TabMenu {
  x: number;
  y: number;
  path: string;
}

/**
 * The row of document tabs for one pane (ADR-0037) -- pure view over
 * `PaneService.pane(paneId)` for membership/order/active, `EditorService`
 * for each tab's name/dirty state and to close it. A plain press activates
 * the tab within this pane, the X closes (a dirty tab confirms first, in
 * the service). Right-click opens a small menu with "Split right/down" and
 * "Close all" / "Close others", scoped to *this pane only*. The "+" opens a
 * blank scratch note; it lands here because clicking anywhere in a pane
 * focuses it first (`PaneLeaf`'s host `mousedown`).
 *
 * Drag-and-drop is owned by `TabDragService` (ADR-0039), the tab-side
 * analogue of `DockService`'s header drag: this component only reports the
 * `mousedown` and renders the drop-line from the service's `dropTarget`
 * signal. The move commits once on release; the source tab stays put during
 * the drag.
 */
@Component({
  selector: 'app-tab-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, OverlayGuardDirective],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.css',
  host: {
    // Marks this element as a tab strip for `TabDragService`'s drop
    // hit-test -- distinct from `PaneLeaf`'s `data-pane-id` (a body drop),
    // and not tag-name-dependent (the test host renders as a plain div).
    '[attr.data-tabstrip-pane]': 'paneId()',
  },
})
export class TabBar {
  protected readonly editor = inject(EditorService);
  protected readonly panes = inject(PaneService);
  protected readonly tabDrag = inject(TabDragService);
  private readonly docKinds = inject(DocKindRegistry);

  readonly paneId = input.required<string>();

  protected readonly menu = signal<TabMenu | null>(null);

  /** This pane's region (ADR-0038) -- drives the dock-move menu entries. */
  protected readonly region = computed<PaneRegion | null>(() => this.panes.regionOf(this.paneId()));
  /** True while this tab bar's pane lives in a dock's editor band. */
  protected readonly docked = computed(() => {
    const r = this.region();
    return r !== null && r !== 'center';
  });

  /**
   * The tab's favicon slot: null for the base kinds (no glyph), otherwise
   * the kind's favicon URL plus its fallback glyph (ADR-0044 stage 8A --
   * was the hardcoded `kind === 'browser'` branch).
   */
  protected tabIcon(doc: OpenDoc): { url: string | null; glyph: IconName } | null {
    if (doc.kind === 'text' || doc.kind === 'image' || doc.kind === 'pdf') {
      return null;
    }
    return {
      url: this.docKinds.faviconFor(doc.kind, doc.path),
      glyph: (this.docKinds.get(doc.kind)?.icon ?? 'square') as IconName,
    };
  }

  /** Favicon URLs that 404'd -- those tabs fall back to the globe glyph. */
  private readonly brokenFavicons = signal<ReadonlySet<string>>(new Set());

  protected faviconOk(url: string | null | undefined): url is string {
    return !!url && !this.brokenFavicons().has(url);
  }

  protected onClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    this.editor.closeTab(path);
  }

  /** A browser tab's favicon failed to load -- fall back to the globe glyph. */
  protected onFaviconError(url: string): void {
    this.brokenFavicons.update((set) => new Set(set).add(url));
  }

  /** Left-button press on a tab: a plain click until the pointer clears the drag threshold. */
  protected onTabMouseDown(event: MouseEvent, path: string, name: string, dirty: boolean): void {
    // A press that starts on the X is a close, not a drag / activate.
    if ((event.target as HTMLElement | null)?.closest('.close')) {
      return;
    }
    this.tabDrag.beginPress(this.paneId(), path, name, dirty, event);
  }

  /** True for the dragged tab (dimmed, but not moved -- it stays until release). */
  protected isDragging(path: string): boolean {
    return this.tabDrag.dragging()?.path === path;
  }

  /** Show the 2px drop-line just before tab `i` in this pane. */
  protected dropBefore(i: number): boolean {
    const t = this.tabDrag.dropTarget();
    return !!t && t.paneId === this.paneId() && t.index === i;
  }

  /** Show the drop-line after the last tab (drop past the end / onto the pane body). */
  protected dropAtEnd(): boolean {
    const t = this.tabDrag.dropTarget();
    const count = this.panes.pane(this.paneId())?.tabs.length ?? 0;
    return !!t && t.paneId === this.paneId() && t.index >= count && count > 0;
  }

  protected openMenu(event: MouseEvent, path: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 168),
      // The menu grew to seven rows with the dock-move entries (ADR-0038).
      y: Math.min(event.clientY, window.innerHeight - 240),
      path,
    });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeMenu();
  }

  /** Splits this pane, moving `path` into a brand-new sibling. */
  protected split(path: string, direction: 'row' | 'column'): void {
    this.closeMenu();
    this.panes.splitPane(this.paneId(), direction, path);
  }

  /** "Export as PDF…" on the right-clicked tab (centre-pane menu only). */
  protected exportPdf(path: string): void {
    this.closeMenu();
    void this.editor.exportPdf(path);
  }

  /** Moves this whole pane into a dock's editor band (ADR-0038). */
  protected moveToDock(side: 'left' | 'right' | 'bottom'): void {
    this.closeMenu();
    this.panes.detachToDock(this.paneId(), side);
  }

  /** Moves this docked pane back into the centre split tree. */
  protected backToCenter(): void {
    this.closeMenu();
    this.panes.reattachToCenter(this.paneId());
  }

  protected closeOthers(path: string): void {
    this.closeMenu();
    this.editor.closeOthers(this.paneId(), path);
  }

  protected closeAll(): void {
    this.closeMenu();
    this.editor.closeAll(this.paneId());
  }
}
