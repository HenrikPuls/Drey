/**
 * Mission Control's binding of the message catalog (ADR-0091): one Angular
 * injectable over `shared/i18n`'s facade, provided in root so the shell
 * (`apps/mission-control`) needs no provider. The phone, the iPad and the
 * desktop web client read every new surface's string through it or the
 * `t` pipe beside it. A dev build warns once per missing key; a
 * production build shows the key and stays quiet.
 */
import { Injectable, isDevMode } from '@angular/core';
import {
  DEFAULT_LOCALE,
  createI18n,
  loadCatalog,
  silentMissingKey,
  warnMissingKey,
  type CurrencyRange,
  type DateStyle,
  type I18n,
  type I18nInstance,
  type MessageKey,
  type MessageParams,
  type SupportedLocale,
} from '../../../../shared/i18n';

@Injectable({ providedIn: 'root' })
export class McI18n implements I18n {
  private readonly impl: I18nInstance = createI18n({
    locale: DEFAULT_LOCALE,
    catalog: loadCatalog(DEFAULT_LOCALE),
    onMissing: isDevMode() ? warnMissingKey : silentMissingKey,
  });

  get locale(): SupportedLocale {
    return this.impl.locale;
  }

  t(key: MessageKey, params?: MessageParams): string {
    return this.impl.t(key, params);
  }

  lookup(key: string, params?: MessageParams): string {
    return this.impl.lookup(key, params);
  }

  has(key: string): boolean {
    return this.impl.has(key);
  }

  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return this.impl.formatNumber(value, options);
  }

  formatCurrency(amount: number, currency?: string): string {
    return this.impl.formatCurrency(amount, currency);
  }

  currencyRange(low: number, high: number, currency?: string): CurrencyRange {
    return this.impl.currencyRange(low, high, currency);
  }

  formatDuration(ms: number): string {
    return this.impl.formatDuration(ms);
  }

  formatDate(date: Date, style?: DateStyle): string {
    return this.impl.formatDate(date, style);
  }

  formatTime(date: Date): string {
    return this.impl.formatTime(date);
  }

  formatDateTime(date: Date): string {
    return this.impl.formatDateTime(date);
  }

  formatRelative(date: Date, now?: Date): string {
    return this.impl.formatRelative(date, now);
  }
}
