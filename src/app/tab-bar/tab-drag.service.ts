import { Injectable, computed, inject, signal } from '@angular/core';
import {
  endDragChrome,
  hitTestUnderPointer,
  moveDragChrome,
  setDragCursor,
  startDragChrome,
} from '../dnd';
import { PaneService } from '../panes/pane.service';

/** Where a dragged tab would land: a pane, an insertion index, and whether the pointer is on the strip or the body. */
export interface TabDropTarget {
  readonly paneId: string;
  readonly index: number;
  /** `'strip'` = over the tab row (precise slot); `'body'` = over the editor area (append). */
  readonly kind: 'strip' | 'body';
}

interface TabPress {
  readonly paneId: string;
  readonly path: string;
  readonly name: string;
  readonly dirty: boolean;
  readonly startX: number;
  readonly startY: number;
  promoted: boolean;
}

const DRAG_THRESHOLD_PX = 4;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/**
 * Owns the editor tab drag gesture, the same way `DockService` owns the
 * dock panel header drag: `TabBar` just reports a `mousedown` on a tab and
 * renders from the signals here.
 *
 * Real drag-and-drop semantics (ADR-0039): a press is a plain click until
 * the pointer clears {@link DRAG_THRESHOLD_PX}; once promoted the source
 * tab stays put, a `.tab-drag-ghost` chip follows the cursor, and
 * `dropTarget` tracks where a release would land -- a pane's tab strip
 * (precise index) or anywhere in a pane's body (appended). Over anything
 * else `dropTarget` is `null`, the cursor is `no-drop`, and a release
 * moves nothing. The move commits **once**, on `mouseup`, via
 * `PaneService.moveToPane`. ESC or the window losing focus cancels.
 */
@Injectable({ providedIn: 'root' })
export class TabDragService {
  private readonly panes = inject(PaneService);

  /** The tab being dragged once the press promotes, else `null`. */
  readonly dragging = signal<{
    path: string;
    fromPaneId: string;
    name: string;
    dirty: boolean;
  } | null>(null);
  /** Where a release right now would drop the tab; `null` = invalid target (`no-drop`). */
  readonly dropTarget = signal<TabDropTarget | null>(null);
  /** True while a tab is mid-drag -- panes use it to show a drop-target wash. */
  readonly dragActive = computed(() => this.dragging() !== null);

  private press: TabPress | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', this.onBlur);
    }
  }

  /**
   * `mousedown` on a tab. A release before the pointer moves
   * `DRAG_THRESHOLD_PX` activates the tab; moving past it promotes to a
   * drag.
   */
  beginPress(
    paneId: string,
    path: string,
    name: string,
    dirty: boolean,
    event: MouseEvent,
  ): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.press = {
      paneId,
      path,
      name,
      dirty,
      startX: event.clientX,
      startY: event.clientY,
      promoted: false,
    };
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
  }

  private readonly onMove = (event: MouseEvent): void => {
    const press = this.press;
    if (!press) {
      return;
    }
    if (!press.promoted) {
      if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < DRAG_THRESHOLD_PX) {
        return;
      }
      press.promoted = true;
      this.dragging.set({
        path: press.path,
        fromPaneId: press.paneId,
        name: press.name,
        dirty: press.dirty,
      });
      startDragChrome({
        ghostClass: 'tab-drag-ghost',
        ghostHtml:
          `<span class="label">${escapeHtml(press.name)}</span>` +
          (press.dirty ? '<span class="dirty"></span>' : ''),
      });
      window.addEventListener('keydown', this.onKeydown, true);
    }

    moveDragChrome(event.clientX, event.clientY);
    this.resolveDropTarget(event.clientX, event.clientY);
  };

  /** Sets `dropTarget` from what is under the pointer (a tab strip, a pane body, or nothing). */
  private resolveDropTarget(clientX: number, clientY: number): void {
    const el = hitTestUnderPointer(clientX, clientY);

    const strip = el?.closest('[data-tabstrip-pane]');
    if (strip) {
      const paneId = strip.getAttribute('data-tabstrip-pane')!;
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.tab'));
      let index = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const rect = tabs[i].getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          index = i;
          break;
        }
      }
      this.dropTarget.set({ paneId, index, kind: 'strip' });
      setDragCursor('grabbing');
      return;
    }

    const leaf = el?.closest('[data-pane-id]');
    if (leaf) {
      const paneId = leaf.getAttribute('data-pane-id')!;
      this.dropTarget.set({
        paneId,
        index: this.panes.pane(paneId)?.tabs.length ?? 0,
        kind: 'body',
      });
      setDragCursor('grabbing');
      return;
    }

    this.dropTarget.set(null);
    setDragCursor('no-drop');
  }

  private readonly onUp = (): void => {
    const press = this.press;
    const drop = this.dropTarget();
    const promoted = press?.promoted ?? false;
    this.teardown();

    if (!press) {
      return;
    }
    if (!promoted) {
      // A plain click: activate the tab (the component has no `(click)`).
      this.panes.activate(press.paneId, press.path);
      return;
    }
    if (drop) {
      this.panes.moveToPane(press.path, drop.paneId, drop.index);
    }
  };

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.teardown();
    }
  };

  private readonly onBlur = (): void => {
    if (this.press) {
      this.teardown();
    }
  };

  /** Removes the listeners, the drag chrome and the signals -- no move. */
  private teardown(): void {
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKeydown, true);
    endDragChrome();
    this.dragging.set(null);
    this.dropTarget.set(null);
    this.press = null;
  }
}
