/**
 * The cost words every client writes (req-98, canvas decision 20): the
 * estimate with its basis, `no estimate yet (first run)`, and a bare
 * amount that always says what it is (`$1.20 so far`, `$1.84 in total`).
 * One implementation over the catalog and `Intl` currency, so the desktop
 * strip, the desk and Mission Control cannot drift apart.
 */
import type { I18n } from './i18n/types';

/** What an estimate needs to be written: the basis and the cost, with the middle half when the engine sent it. */
export interface EstimateWords {
  /** How many similar earlier runs the figures rest on. */
  readonly runs: number;
  /** The median cost in dollars. */
  readonly cost: number;
  /** The low end of the middle half of those runs; absent = only the median is known. */
  readonly costLow?: number | null;
  /** The high end of the middle half of those runs. */
  readonly costHigh?: number | null;
}

/** `$3.00–5.20 · from 3 runs`; one amount when the ends meet or only the median is known. */
export function estimateText(i18n: I18n, estimate: EstimateWords): string {
  const low = estimate.costLow;
  const high = estimate.costHigh;
  if (typeof low === 'number' && typeof high === 'number') {
    const range = i18n.currencyRange(low, high);
    if (range.high !== '') {
      return i18n.t('cost.estimate.range', { low: range.low, high: range.high, n: estimate.runs });
    }
  }
  return i18n.t('cost.estimate.single', { cost: i18n.formatCurrency(estimate.cost), n: estimate.runs });
}

/** `no estimate yet (first run)`. */
export function noEstimateText(i18n: I18n): string {
  return i18n.t('cost.estimate.none');
}

/** `$1.20 so far` — the money of a ticket still being worked. */
export function costSoFarText(i18n: I18n, amount: number): string {
  return i18n.t('cost.amount.so_far', { cost: i18n.formatCurrency(amount) });
}

/** `$1.84 in total` — the money of a ticket that waits on the owner. */
export function costInTotalText(i18n: I18n, amount: number): string {
  return i18n.t('cost.amount.in_total', { cost: i18n.formatCurrency(amount) });
}

/** `est. $3.00–5.20 · from 3 runs`. */
export function estimateInlineText(i18n: I18n, estimate: EstimateWords): string {
  return i18n.t('cost.amount.estimate', { estimate: estimateText(i18n, estimate) });
}
