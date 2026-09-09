import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  signal,
} from '@angular/core';
import { EditorService } from '../services/editor.service';
import { PaneService } from '../panes/pane.service';
import { Icon } from '../icons/icon';

interface TabMenu {
  x: number;
  y: number;
  path: string;
}

/**
 * The row of document tabs for one pane (ADR-0037) -- pure view over
 * `PaneService.pane(paneId)` for membership/order/active, `EditorService`
 * for each tab's name/dirty state and to close it. Click activates within
 * this pane, the X closes (a dirty tab confirms first, in the service).
 * Right-click opens a small menu with "Close all" / "Close others",
 * scoped to *this pane only* -- a split's other panes are untouched. The
 * "+" opens a blank scratch note; it lands here because clicking anywhere
 * in a pane focuses it first (`PaneLeaf`'s host `mousedown`).
 *
 * Drag-to-reorder mirrors `DockService`'s press-then-promote gesture (a
 * `mousedown` is a plain click until the pointer clears a threshold): once
 * promoted, the dragged tab is moved live whenever the pointer crosses a
 * neighbour's horizontal midpoint, so the tab bar reorders as you drag
 * rather than only on drop. Dragging the pointer over *another* pane's tab
 * bar (found via `document.elementFromPoint` + a `[data-pane-id]` marker on
 * this component's host, rather than a shared drag-registry service -- this
 * is the only place that needs it) moves the tab there instead of
 * reordering in place.
 */
@Component({
  selector: 'app-tab-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.css',
  host: {
    '[attr.data-pane-id]': 'paneId()',
  },
})
export class TabBar {
  protected readonly editor = inject(EditorService);
  protected readonly panes = inject(PaneService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly paneId = input.required<string>();

  protected readonly menu = signal<TabMenu | null>(null);
  /** The tab currently being dragged, once the press promotes to a drag. */
  protected readonly draggingPath = signal<string | null>(null);

  private static readonly DRAG_THRESHOLD_PX = 4;
  private dragStartX = 0;
  private dragPath: string | null = null;
  private dragPromoted = false;

  protected onClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    this.editor.closeTab(path);
  }

  /** Left-button press on a tab: a plain click until the pointer moves past the threshold. */
  protected onTabMouseDown(event: MouseEvent, path: string): void {
    if (event.button !== 0) {
      return;
    }
    this.dragStartX = event.clientX;
    this.dragPath = path;
    this.dragPromoted = false;
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragUp);
  }

  private readonly onDragMove = (event: MouseEvent): void => {
    const path = this.dragPath;
    if (!path) {
      return;
    }
    if (!this.dragPromoted) {
      if (Math.abs(event.clientX - this.dragStartX) < TabBar.DRAG_THRESHOLD_PX) {
        return;
      }
      this.dragPromoted = true;
      this.draggingPath.set(path);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    }

    // Which tab bar is the pointer over right now -- this one, another
    // pane's, or none (over the editor content / a splitter, in which case
    // the last valid target just holds, nothing moves this tick).
    // `[data-pane-id]` rather than `app-tab-bar[data-pane-id]`: only this
    // host ever sets that attribute, and staying tag-name-agnostic avoids
    // any assumption about how the host element itself is rendered.
    const overBar = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest('[data-pane-id]');
    if (!overBar) {
      return;
    }
    const targetPaneId = overBar.getAttribute('data-pane-id')!;
    const tabs = Array.from(overBar.querySelectorAll<HTMLElement>('.tab'));
    let toIndex = tabs.length - 1;
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        toIndex = i;
        break;
      }
    }
    this.panes.moveToPane(path, targetPaneId, toIndex);
  };

  private readonly onDragUp = (): void => {
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragUp);
    this.dragPath = null;
    this.dragPromoted = false;
    this.draggingPath.set(null);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

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
