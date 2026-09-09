import { ChangeDetectionStrategy, Component, HostListener, inject, input, signal } from '@angular/core';
import { EditorService } from '../services/editor.service';
import { PaneService } from '../panes/pane.service';
import { TabDragService } from './tab-drag.service';
import { Icon } from '../icons/icon';

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
  imports: [Icon],
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

  readonly paneId = input.required<string>();

  protected readonly menu = signal<TabMenu | null>(null);

  protected onClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    this.editor.closeTab(path);
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
      y: Math.min(event.clientY, window.innerHeight - 80),
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

  protected closeOthers(path: string): void {
    this.closeMenu();
    this.editor.closeOthers(this.paneId(), path);
  }

  protected closeAll(): void {
    this.closeMenu();
    this.editor.closeAll(this.paneId());
  }
}
