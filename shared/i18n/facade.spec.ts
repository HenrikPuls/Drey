import { describe, expect, it, vi } from 'vitest';
import { loadCatalog } from './catalog';
import { createI18n, silentMissingKey, warnMissingKey } from './facade';
import { i18n } from './index';

/**
 * The `t(key, params)` facade (ADR-0091): plain messages, placeholders,
 * ICU plurals, the missing-key contract (the key comes back, reported once)
 * and the Intl helpers reached through the same object.
 */
function make(catalog: Record<string, string>, onMissing = vi.fn()) {
  return { i18n: createI18n({ locale: 'en', catalog, onMissing }), onMissing };
}

describe('createI18n', () => {
  it('returns a plain message and fills placeholders', () => {
    const { i18n } = make({ 'a.plain': 'Autopilot', 'a.with': 'Resume at {time}' });
    expect(i18n.t('a.plain' as never)).toBe('Autopilot');
    expect(i18n.lookup('a.with', { time: '3:05 PM' })).toBe('Resume at 3:05 PM');
  });

  it('selects the ICU plural form by the number', () => {
    const { i18n } = make({ 'c.runs': 'from {n, plural, one {# run} other {# runs}}' });
    expect(i18n.lookup('c.runs', { n: 1 })).toBe('from 1 run');
    expect(i18n.lookup('c.runs', { n: 3 })).toBe('from 3 runs');
    expect(i18n.lookup('c.runs', { n: 0 })).toBe('from 0 runs');
  });

  it('formats the shipped estimate range with the currency parts and the plural', () => {
    const range = i18n.currencyRange(3, 5.2);
    expect(i18n.t('cost.estimate.range', { low: range.low, high: range.high, n: 3 })).toBe('$3.00–5.20 · from 3 runs');
    expect(i18n.t('cost.estimate.range', { low: range.low, high: range.high, n: 1 })).toBe('$3.00–5.20 · from 1 run');
    expect(i18n.t('cost.estimate.none')).toBe('no estimate yet (first run)');
    expect(i18n.t('decision.send_back_with_comments', { n: 2 })).toBe('Send back with 2 comments');
  });

  it('returns the key for a missing message and reports it once', () => {
    const { i18n, onMissing } = make({});
    expect(i18n.lookup('nothing.here')).toBe('nothing.here');
    expect(i18n.lookup('nothing.here')).toBe('nothing.here');
    expect(i18n.lookup('other.key')).toBe('other.key');
    expect(onMissing).toHaveBeenCalledTimes(2);
    expect(onMissing).toHaveBeenNthCalledWith(1, 'nothing.here');
    expect(onMissing).toHaveBeenNthCalledWith(2, 'other.key');
  });

  it('returns the key when a placeholder is not filled and reports once with the error', () => {
    const { i18n, onMissing } = make({ 'a.with': 'Resume at {time}' });
    expect(i18n.lookup('a.with')).toBe('a.with');
    expect(i18n.lookup('a.with')).toBe('a.with');
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing.mock.calls[0][0]).toBe('a.with');
    expect(onMissing.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it('keeps reporting per key, not per instance, and lets a binding swap the reporter', () => {
    const { i18n, onMissing } = make({});
    i18n.lookup('x.one');
    const later = vi.fn();
    i18n.setMissingKeyReporter(later);
    i18n.lookup('x.one');
    i18n.lookup('x.two');
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledWith('x.two');
  });

  it('knows which keys it has', () => {
    const { i18n } = make({ 'a.b': 'c' });
    expect(i18n.has('a.b')).toBe(true);
    expect(i18n.has('a.c')).toBe(false);
    expect(i18n.has('toString')).toBe(false);
  });

  it('reaches the Intl helpers in its locale', () => {
    const { i18n } = make({});
    expect(i18n.locale).toBe('en');
    expect(i18n.formatCurrency(3)).toBe('$3.00');
    expect(i18n.formatNumber(1234.5)).toBe('1,234.5');
    expect(i18n.formatDuration(64_000)).toBe('1 min 4 sec');
    expect(i18n.formatTime(new Date(2026, 10, 6, 15, 5))).toBe('3:05 PM');
  });

  it('ships the default reporters: a console warning once, or silence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const loud = createI18n({ locale: 'en', catalog: loadCatalog('en') });
      loud.lookup('no.such.key');
      loud.lookup('no.such.key');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('no.such.key');
      warnMissingKey('k', new Error('boom'));
      expect(warn).toHaveBeenCalledTimes(2);
      silentMissingKey('k');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('exports a shared English instance over the shipped catalog', () => {
    expect(i18n.locale).toBe('en');
    expect(i18n.t('autopilot.state.paused')).toBe('Paused');
    expect(i18n.t('autopilot.resume_at', { time: i18n.formatTime(new Date(2026, 10, 6, 9, 30)) })).toBe(
      'Resume at 9:30 AM',
    );
  });
});
