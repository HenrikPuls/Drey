import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MC_WORK_STATE, liveRunCountOf } from '../work/work.model';

/**
 * The dock's second tab (E12-2): how many workers run right now. The
 * capacity line, pause and stop controls arrive with E12-4; this is the
 * live count the Work header's fleet chip already reads.
 */
@Component({
  selector: 'mc-capacity',
  templateUrl: './capacity.html',
  styleUrl: './capacity.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Capacity {
  private readonly state = inject(MC_WORK_STATE, { optional: true });

  /** The live-run count; null = the desk sent no run data. */
  protected readonly live = computed(() => liveRunCountOf(this.state?.runs ?? null));
}
