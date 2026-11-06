import { describe, expect, it } from 'vitest';
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

/**
 * The Intl helpers (ADR-0091). English only, since only English ships;
 * the one locale-crossing case (the currency range in a suffix-currency
 * locale) is checked so the helper stays free of English assumptions.
 */
describe('currency', () => {
  it('writes an amount in the locale with the default USD', () => {
    expect(formatCurrency('en', 3)).toBe('$3.00');
    expect(formatCurrency('en', 5.2)).toBe('$5.20');
    expect(formatCurrency('en', 1234.567, 'EUR')).toBe('€1,234.57');
  });

  it('writes a range with the currency once and an en dash without spaces', () => {
    expect(currencyRange('en', 3, 5.2)).toEqual({ low: '$3.00', high: '5.20', text: '$3.00–5.20' });
    expect(currencyRange('en', 3, 5.2).text).toBe('$3.00–5.20');
  });

  it('orders the ends and collapses an equal range to one amount', () => {
    expect(currencyRange('en', 5.2, 3).text).toBe('$3.00–5.20');
    expect(currencyRange('en', 4, 4)).toEqual({ low: '$4.00', high: '', text: '$4.00' });
  });

  it('keeps a suffix-currency locale readable without a locale-specific path', () => {
    const range = currencyRange('de-DE', 3, 5.2, 'EUR');
    expect(range.low).toBe('3,00 €');
    expect(range.high).toBe('5,20');
    expect(range.text).toBe('3,00 €–5,20');
  });
});

describe('numbers', () => {
  it('groups and rounds per locale and options', () => {
    expect(formatNumber('en', 1234.5)).toBe('1,234.5');
    expect(formatNumber('en', 0.256, { style: 'percent' })).toBe('26%');
    expect(formatNumber('en', 2, { minimumFractionDigits: 1 })).toBe('2.0');
  });
});

describe('durations', () => {
  it('uses Intl unit words for the two largest units', () => {
    expect(formatDuration('en', 8_400)).toBe('8 sec');
    expect(formatDuration('en', 59_400)).toBe('59 sec');
    expect(formatDuration('en', 64_000)).toBe('1 min 4 sec');
    expect(formatDuration('en', 750_000)).toBe('12 min 30 sec');
    expect(formatDuration('en', 3_600_000 + 4 * 60_000)).toBe('1 hr 4 min');
    expect(formatDuration('en', 2 * 86_400_000 + 3 * 3_600_000 + 5 * 60_000)).toBe('2 days 3 hr');
  });

  it('stops at a zero inner unit and never says 0 sec', () => {
    expect(formatDuration('en', 120_000)).toBe('2 min');
    expect(formatDuration('en', 2 * 86_400_000)).toBe('2 days');
    expect(formatDuration('en', 0)).toBe('1 sec');
    expect(formatDuration('en', 120)).toBe('1 sec');
    expect(formatDuration('en', -5_000)).toBe('1 sec');
  });
});

describe('dates and times', () => {
  const date = new Date(2026, 10, 6, 15, 5);

  it('writes the three date styles, the short time and both together', () => {
    expect(formatDate('en', date)).toBe('Nov 6, 2026');
    expect(formatDate('en', date, 'short')).toBe('11/6/26');
    expect(formatDate('en', date, 'long')).toBe('November 6, 2026');
    expect(formatTime('en', date)).toBe('3:05 PM');
    expect(formatDateTime('en', date)).toBe('Nov 6, 2026, 3:05 PM');
  });

  it('writes a relative time with the locale words for near days', () => {
    const now = new Date(2026, 10, 6, 12, 0);
    expect(formatRelative('en', new Date(2026, 10, 6, 14, 0), now)).toBe('in 2 hours');
    expect(formatRelative('en', new Date(2026, 10, 6, 11, 57), now)).toBe('3 minutes ago');
    expect(formatRelative('en', new Date(2026, 10, 5, 12, 0), now)).toBe('yesterday');
    expect(formatRelative('en', new Date(2026, 10, 7, 12, 0), now)).toBe('tomorrow');
    expect(formatRelative('en', new Date(2026, 9, 20, 12, 0), now)).toBe('2 weeks ago');
    expect(formatRelative('en', now, now)).toBe('now');
  });
});
