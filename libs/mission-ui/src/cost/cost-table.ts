import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { McI18nPipe } from '../i18n/i18n.pipe';
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
  readonly view = input.required<CostTableView>();
}
