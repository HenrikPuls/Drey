/**
 * The `t(key, params)` facade over one ICU runtime (ADR-0091):
 * `intl-messageformat` compiles a message the first time it is asked for
 * and the compiled form is kept per key, so a label in a list costs one
 * parse. A missing key, or a message whose placeholders the call did not
 * fill, never throws into the UI: the key itself comes back (visible, so
 * it is found in a screenshot) and the reporter hears about it once.
 */
import { IntlMessageFormat } from 'intl-messageformat';
import type { Catalog, MessageKey, SupportedLocale } from './catalog';
import {
  currencyRange,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTime,
} from './intl';
import type { I18n, MessageParams, MissingKeyReporter } from './types';

export interface I18nOptions {
  readonly locale: SupportedLocale;
  readonly catalog: Catalog;
  /**
   * Hears every key that is missing or failed to format, once per key.
   * Default: a `console.warn`. A production binding passes a no-op; a
   * test passes a spy.
   */
  readonly onMissing?: MissingKeyReporter;
}

/** The default reporter: one console warning per key. */
export const warnMissingKey: MissingKeyReporter = (key, error) => {
  if (error === undefined) {
    console.warn(`[i18n] no message for "${key}"`);
  } else {
    console.warn(`[i18n] message "${key}" failed to format`, error);
  }
};

/** A reporter that says nothing — for packaged runs. */
export const silentMissingKey: MissingKeyReporter = () => undefined;

/**
 * The facade an instance of which every runtime binding wraps. Also
 * exposes `setMissingKeyReporter` so a runtime can decide after
 * construction whether it is a dev or a packaged run.
 */
export interface I18nInstance extends I18n {
  setMissingKeyReporter(reporter: MissingKeyReporter): void;
}

export function createI18n(options: I18nOptions): I18nInstance {
  const { locale, catalog } = options;
  let report: MissingKeyReporter = options.onMissing ?? warnMissingKey;
  const compiled = new Map<string, IntlMessageFormat>();
  const reported = new Set<string>();

  const reportOnce = (key: string, error?: unknown): void => {
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    if (error === undefined) {
      report(key);
    } else {
      report(key, error);
    }
  };

  const lookup = (key: string, params?: MessageParams): string => {
    const source = catalog[key];
    if (source === undefined) {
      reportOnce(key);
      return key;
    }
    try {
      let format = compiled.get(key);
      if (format === undefined) {
        format = new IntlMessageFormat(source, locale);
        compiled.set(key, format);
      }
      const result = format.format(params === undefined ? {} : { ...params });
      return Array.isArray(result) ? result.map(String).join('') : String(result);
    } catch (error) {
      reportOnce(key, error);
      return key;
    }
  };

  return {
    locale,
    t: (key: MessageKey, params?: MessageParams) => lookup(key, params),
    lookup,
    has: (key) => Object.prototype.hasOwnProperty.call(catalog, key),
    formatNumber: (value, numberOptions) => formatNumber(locale, value, numberOptions),
    formatCurrency: (amount, currency) => formatCurrency(locale, amount, currency),
    currencyRange: (low, high, currency) => currencyRange(locale, low, high, currency),
    formatDuration: (ms) => formatDuration(locale, ms),
    formatDate: (date, style) => formatDate(locale, date, style),
    formatTime: (date) => formatTime(locale, date),
    formatDateTime: (date) => formatDateTime(locale, date),
    formatRelative: (date, now) => formatRelative(locale, date, now),
    setMissingKeyReporter: (reporter) => {
      report = reporter;
    },
  };
}
