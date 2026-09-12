import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LayoutGestureService } from '../services/layout-gesture.service';
import { PaneLeaf } from './pane-leaf';
import { PaneNode } from './pane-tree';
import { PaneService } from './pane.service';

/**
 * Recursively renders the pane split tree (ADR-0037): a leaf becomes
 * `PaneLeaf`; a split becomes a flex row/column of its children with a
 * draggable splitter between each adjacent pair. The component imports
 * *itself* for the recursive case -- a standard pattern for Angular tree
 * components, since `imports` is only read once the class exists.
 *
 * The splitter only ever resizes the two cells it sits between (their
 * `sizes` entries), leaving the rest of the split untouched -- the same
 * "resize the pair, not the whole row" model as a spreadsheet column drag,
 * and the same recipe `DockService.startSplit` already uses for the dock's
 * own splitters (measure current pixel size, redistribute a delta, keep the
 * pair's total constant).
 */
@Component({
  selector: 'app-pane-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PaneLayout, PaneLeaf],
  templateUrl: './pane-layout.html',
  styleUrl: './pane-layout.css',
})
export class PaneLayout {
  readonly node = input.required<PaneNode>();

  private readonly panes = inject(PaneService);
  private readonly layoutGesture = inject(LayoutGestureService);

  private static readonly MIN_CELL_PX = 120;

  /** Stable `@for` track key: a leaf's pane id, a split's own id. */
  protected childKey(node: PaneNode): string {
    return node.kind === 'leaf' ? node.paneId : node.id;
  }

  /**
   * Drags the splitter between children `index` and `index + 1` of `split`.
   * Reads the pair's *current* rendered size (not the stored weight, which
   * may be stale after a window resize) so the drag starts from where the
   * seam actually is.
   */
  protected startResize(split: Extract<PaneNode, { kind: 'split' }>, index: number, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const a = handle.previousElementSibling as HTMLElement | null;
    const b = handle.nextElementSibling as HTMLElement | null;
    if (!a || !b) {
      return;
    }
    const horizontal = split.direction === 'row';
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const aSize = horizontal ? rectA.width : rectA.height;
    const bSize = horizontal ? rectB.width : rectB.height;
    const total = aSize + bSize;
    const start = horizontal ? event.clientX : event.clientY;
    const min = Math.min(PaneLayout.MIN_CELL_PX, total / 2);

    handle.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    // The input-recovery watchdog reads this marker: `user-select:none` on
    // <body> is only legitimate while a gesture flag is set (ADR-0032).
    document.body.setAttribute('data-drey-gesture', 'pane-splitter');
    // Hide any in-editor browser view for the drag -- its native bounds
    // trail the DOM by a frame otherwise (ADR-0042).
    this.layoutGesture.set('pane-splitter', true);

    const move = (ev: PointerEvent): void => {
      const cur = horizontal ? ev.clientX : ev.clientY;
      const nextA = Math.max(min, Math.min(total - min, aSize + (cur - start)));
      const sizes = split.sizes.slice();
      sizes[index] = nextA;
      sizes[index + 1] = total - nextA;
      this.panes.resizeSplit(split.id, sizes);
    };
    const up = (): void => {
      handle.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.removeAttribute('data-drey-gesture');
      this.layoutGesture.set('pane-splitter', false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    // A pointerup lost to an alt-tab must not leave `user-select: none`
    // stuck on <body> (bug-6). `up` is idempotent and removes itself.
    window.addEventListener('blur', up);
  }
}
