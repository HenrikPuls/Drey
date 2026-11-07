import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { padSignal } from '../phone/phone';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import type { CostTableView } from './cost-table.model';

/**
 * The cost-by-phase table at the end of a ticket (req-98): five columns
 * on the iPad and the desktop web client, Phase and Cost per row with one
 * grey meta line under the phase on a phone. Pure presentation — the rows
 * come from `costTableOf`.
 */
@Component({
  selector: 'mc-cost-table',
  templateUrl: './cost-table.html',
  styleUrl: './cost-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [McI18nPipe],
})
export class CostTable {
  private readonly i18n = inject(McI18n);
  /** The iPad's table reads as the boards': `Plan · Paul`, then the model alone (10e). */
  protected readonly pad = padSignal();
  readonly view = input.required<CostTableView>();
  /** The phone's rows of phases without a run: only these, the ones still to come. */
  readonly openPhases = input<readonly string[] | null>(null);
  /** The phase that runs right now: its grey line says so. */
  readonly runningPhase = input<string | null>(null);
  /** The ticket has run its course: the total is `Total`, not `Total so far`. */
  readonly settled = input(false);

  protected phoneRows(): CostTableView['rows'] {
    const open = this.openPhases();
    return this.view().rows.filter((row) => !row.pending || open === null || open.includes(row.phase));
  }

  /** The phone's row title: `Plan · Paul`, the persona off the row's model field. */
  protected phoneTitle(row: CostTableView['rows'][number]): string {
    const persona = row.pending ? '' : row.model.split(' · ')[0]!;
    return persona === '' ? row.phase : `${row.phase} · ${persona}`;
  }

  protected padModel(row: CostTableView['rows'][number]): string {
    return row.model.split(' · ').slice(1).join(' · ');
  }

  /** The time as the board's cells write it: `4m`. */
  protected padTime(time: string): string {
    return this.shortTime(time);
  }

  /** The phone's grey line: the model, the tokens and the time. */
  protected phoneSub(row: CostTableView['rows'][number]): string {
    const model = row.model.split(' · ').slice(1).join(' · ');
    const running = !this.settled() && row.phase === this.runningPhase() ? this.i18n.t('cost.table.running') : '';
    return [model, row.tokens, this.shortTime(row.time), running].filter((bit) => bit !== '').join(' · ');
  }

  protected phoneTotal(): string {
    const total = this.view().total;
    return [total.tokens, this.shortTime(total.time)].filter((bit) => bit !== '').join(' · ');
  }

  /** `9 min` as the phone's rows write it: `9m`. */
  private shortTime(time: string): string {
    const minutes = /^(\d+)/.exec(time)?.[1];
    return minutes === undefined ? time : this.i18n.t('cost.table.minutes_short', { n: Number(minutes) });
  }
}
