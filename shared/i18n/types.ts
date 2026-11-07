/**
 * The i18n facade's shape (ADR-0091) — what every runtime binding exposes
 * and what the plugin SDK hands a plugin as `api.i18n` / `ctx.i18n`. Pure
 * types: this file imports no runtime so the SDK can name it without
 * pulling the ICU library into a plugin bundle.
 */
import type { MessageKey, SupportedLocale } from './catalog';

export type { MessageKey, SupportedLocale } from './catalog';

/**
 * The values a message's placeholders take. Numbers drive ICU plurals
 * (`{n, plural, …}`) and `{n, number}`; dates drive `{d, date}` /
 * `{t, time}`; a string is inserted as is — the caller formats a date or
 * an amount with the facade's `Intl` helpers first when the message
 * needs a particular shape (`autopilot.resume_at` takes `formatTime(..)`).
 */
export type MessageParams = Readonly<Record<string, string | number | boolean | Date | null | undefined>>;

/** Called once per key the first time a message is missing or fails to format. */
export type MissingKeyReporter = (key: string, error?: unknown) => void;

/** How long a date style is: `Intl.DateTimeFormat`'s `dateStyle`. */
export type DateStyle = 'short' | 'medium' | 'long';

/** The low and high end of a currency range, and the one-line text. */
export interface CurrencyRange {
  /** The low end with its currency: `$3.00`. */
  readonly low: string;
  /** The high end without the currency: `5.20` — the symbol is said once. */
  readonly high: string;
  /** `$3.00–5.20` (an en dash, no spaces). */
  readonly text: string;
}

/**
 * The facade. One instance per runtime; the catalog and the locale are
 * fixed at construction. Every method is synchronous.
 */
export interface I18n {
  /** The BCP 47 locale every format call uses (`en`). */
  readonly locale: SupportedLocale;

  /**
   * The message for `key` with `params` filled in — the typed way: a key
   * the English catalog does not have is a compile error. A missing or
   * unformattable message returns the key itself and reports once.
   */
  t(key: MessageKey, params?: MessageParams): string;

  /**
   * The same lookup for a key computed at runtime (`state.${id}`). Same
   * fallback: the key comes back and is reported once. Prefer `t`.
   */
  lookup(key: string, params?: MessageParams): string;

  /** True when the catalog has a message for `key`. */
  has(key: string): boolean;

  /** `1,234.5` — a plain number in the locale's digits and grouping. */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;

  /** `$3.00` — an amount in `currency` (ISO 4217, default `USD`). */
  formatCurrency(amount: number, currency?: string): string;

  /** `$3.00–5.20` as parts and text; equal ends give the one amount. */
  currencyRange(low: number, high: number, currency?: string): CurrencyRange;

  /** `3 min`, `1 hr 4 min`, `8 sec` — the two largest units, `Intl` unit style. */
  formatDuration(ms: number): string;

  /** The calendar date: `Nov 6, 2026` (medium), `11/6/26` (short), `November 6, 2026` (long). */
  formatDate(date: Date, style?: DateStyle): string;

  /** The wall-clock time on a 24-hour clock: `15:05`. */
  formatTime(date: Date): string;

  /** Date and time together, `medium` date with the short time. */
  formatDateTime(date: Date): string;

  /** `in 2 hours`, `yesterday`, `3 minutes ago` — relative to `now` (default: the current time). */
  formatRelative(date: Date, now?: Date): string;
}
