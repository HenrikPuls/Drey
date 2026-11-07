/**
 * The `Intl` helpers behind the facade (ADR-0091): numbers, currency, a
 * currency range, durations, dates, times and relative times. Nothing
 * here concatenates words of a sentence — units, list joins and date
 * parts all come from `Intl`, so a second locale changes no code.
 */
import type { CurrencyRange, DateStyle } from './types';

export const DEFAULT_CURRENCY = 'USD';

export function formatNumber(locale: string, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatCurrency(locale: string, amount: number, currency: string = DEFAULT_CURRENCY): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

/**
 * `$3.00–5.20`: the currency once, on the low end, and the two amounts
 * joined by an en dash without spaces (canvas decision 20). The high end
 * is the locale's own currency rendering with its currency part and the
 * whitespace next to it removed, so a locale that writes `5,20 €` yields
 * `3,00 €–5,20` without a code path of its own. Equal ends give the one
 * amount and an empty `high`.
 */
export function currencyRange(
  locale: string,
  low: number,
  high: number,
  currency: string = DEFAULT_CURRENCY,
): CurrencyRange {
  const [lo, hi] = low <= high ? [low, high] : [high, low];
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const lowText = format.format(lo);
  if (lo === hi) {
    return { low: lowText, high: '', text: lowText };
  }
  const highText = format
    .formatToParts(hi)
    .filter((part) => part.type !== 'currency')
    .map((part) => part.value)
    .join('')
    .trim();
  return { low: lowText, high: highText, text: `${lowText}–${highText}` };
}

type DurationUnit = 'day' | 'hour' | 'minute' | 'second';

const UNIT_MS: readonly { readonly unit: DurationUnit; readonly ms: number }[] = [
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
  { unit: 'second', ms: 1_000 },
];

/**
 * The two largest non-zero units of a duration, each written by
 * `Intl.NumberFormat`'s unit style (`3 min`, `1 hr 4 min`, `2 days 3 hr`)
 * and joined by `Intl.ListFormat`'s unit list (a space in English). Below
 * a second it is `1 sec`, never `0 sec`: a thing that happened took a
 * moment. Negative input counts as zero.
 */
export function formatDuration(locale: string, ms: number): string {
  let rest = Math.max(0, Math.round(ms / 1000)) * 1000;
  if (rest < 1000) {
    rest = 1000;
  }
  const parts: string[] = [];
  for (const { unit, ms: unitMs } of UNIT_MS) {
    if (parts.length === 2) {
      break;
    }
    const count = Math.floor(rest / unitMs);
    if (count === 0 && parts.length === 0) {
      continue;
    }
    if (count > 0) {
      parts.push(
        new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(count),
      );
    } else {
      // A zero inner unit ends the list: `2 days`, not `2 days 0 hr`.
      break;
    }
    rest -= count * unitMs;
  }
  return new Intl.ListFormat(locale, { type: 'unit', style: 'narrow' }).format(parts);
}

export function formatDate(locale: string, date: Date, style: DateStyle = 'medium'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(date);
}

/** A 24-hour clock in every locale: the boards' "Resume at 18:00" (D-36). */
export function formatTime(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short', hourCycle: 'h23' }).format(date);
}

export function formatDateTime(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

type RelativeUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

const RELATIVE_UNITS: readonly { readonly unit: RelativeUnit; readonly ms: number }[] = [
  { unit: 'year', ms: 365 * 86_400_000 },
  { unit: 'month', ms: 30 * 86_400_000 },
  { unit: 'week', ms: 7 * 86_400_000 },
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
  { unit: 'second', ms: 1_000 },
];

/**
 * `in 2 hours`, `3 minutes ago`, `yesterday`, `now` — the largest unit
 * whose count is at least one, through `Intl.RelativeTimeFormat` with
 * `numeric: 'auto'` so the locale's own words for yesterday / tomorrow /
 * now appear where it has them.
 */
export function formatRelative(locale: string, date: Date, now: Date = new Date()): string {
  const delta = date.getTime() - now.getTime();
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const { unit, ms } of RELATIVE_UNITS) {
    const count = Math.trunc(delta / ms);
    if (Math.abs(count) >= 1) {
      return format.format(count, unit);
    }
  }
  return format.format(0, 'second');
}
