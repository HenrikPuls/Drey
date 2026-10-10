import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { ConflictService } from './conflict.service';
import { MergeSegment, buildMerge, mergeResult, segmentText } from './merge-model';

/** Unchanged runs longer than this start folded. */
const FOLD_ABOVE = 6;

/**
 * The save-conflict dialog (ADR-0060) as a merge view: the version on
 * disk, the result, and the tab's own version side by side, block by
 * block. Each differing block takes the disk side, mine, both (disk's
 * lines, then mine) or neither, and the result column is editable
 * throughout -- typing in a block replaces what the checkboxes put there.
 * Escape and the backdrop cancel: nothing is written or discarded by
 * accident. The block model is `merge-model.ts`; see `ConflictService`.
 */
@Component({
  selector: 'app-conflict-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './conflict-dialog.html',
  styleUrl: './conflict-dialog.css',
  host: { '(document:keydown.escape)': 'cancel()' },
})
export class ConflictDialog {
  private readonly service = inject(ConflictService);
  protected readonly pending = this.service.pending;

  protected readonly segments = signal<MergeSegment[]>([]);
  /** Indexes of long unchanged runs the user unfolded. */
  private readonly unfolded = signal<ReadonlySet<number>>(new Set());

  protected readonly summary = computed<string>(() => {
    const hunks = this.segments().filter((s) => s.kind === 'hunk');
    const both = hunks.filter((h) => h.kind === 'hunk' && h.conflict).length;
    const blocks = `${hunks.length} block${hunks.length === 1 ? '' : 's'} differ${hunks.length === 1 ? 's' : ''}`;
    return both > 0 ? `${blocks}, ${both} changed on both sides` : blocks;
  });

  constructor() {
    effect(() => {
      const req = this.pending();
      this.segments.set(req ? buildMerge(req.base, req.disk, req.mine) : []);
      this.unfolded.set(new Set());
    });
  }

  protected text(segment: MergeSegment): string {
    return segmentText(segment);
  }

  protected folded(index: number, segment: MergeSegment): boolean {
    return (
      segment.kind === 'context' &&
      segment.edited === null &&
      segment.lines.length > FOLD_ABOVE &&
      !this.unfolded().has(index)
    );
  }

  protected unfold(index: number): void {
    this.unfolded.update((set) => new Set(set).add(index));
  }

  /** A checkbox: (de)selects one side of a block; the block's typed text gives way. */
  protected take(index: number, side: 'disk' | 'mine', on: boolean): void {
    this.patch(index, (s) =>
      s.kind === 'hunk'
        ? { ...s, takeDisk: side === 'disk' ? on : s.takeDisk, takeMine: side === 'mine' ? on : s.takeMine, edited: null }
        : s,
    );
  }

  /** Typing in the result column. */
  protected edit(index: number, value: string): void {
    this.patch(index, (s) => ({ ...s, edited: value }));
  }

  /** The column heads' "Take all": every block to one side, typed text dropped. */
  protected takeAll(side: 'disk' | 'mine'): void {
    this.segments.update((list) =>
      list.map((s) =>
        s.kind === 'hunk'
          ? { ...s, takeDisk: side === 'disk', takeMine: side === 'mine', edited: null }
          : { ...s, edited: null },
      ),
    );
  }

  protected apply(): void {
    const req = this.pending();
    if (req) {
      this.service.answer(mergeResult(this.segments(), req.disk, req.mine));
    }
  }

  protected cancel(): void {
    if (this.pending()) {
      this.service.answer(null);
    }
  }

  private patch(index: number, change: (segment: MergeSegment) => MergeSegment): void {
    this.segments.update((list) => list.map((s, i) => (i === index ? change(s) : s)));
  }
}
